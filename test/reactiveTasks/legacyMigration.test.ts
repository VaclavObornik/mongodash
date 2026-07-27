import { ObjectId } from 'mongodb';
import { getNewInstance } from '../testHelpers';

/**
 * Backward compatibility with records written before 2.3.1, which stored the
 * poll time in `scheduledAt` / `initialScheduledAt` and the visibility lock in
 * `lockExpiresAt`.
 *
 * The critical invariant: pre-2.3.1 finalize LEFT a past `scheduledAt` on
 * completed and terminally-failed records (the old polling query excluded them
 * by status). The current query has no status filter, so migrating
 * `scheduledAt` verbatim would make every historical record due again and
 * re-run its handler - duplicate side effects for exactly the users the
 * migration exists to help.
 */
describe('legacy (pre-2.3.1) task record migration', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let API: typeof instance.mongodash;

    const taskName = 'legacy-migration-task';
    const sourceCollectionName = 'legacy_migration_items';
    const tasksCollectionName = 'legacy_migration_items_tasks';

    const completedId = new ObjectId();
    const failedId = new ObjectId();
    const pendingId = new ObjectId();
    const processingId = new ObjectId();

    // Source ids are tracked per record so we can assert exactly which of them
    // the workers executed.
    const srcCompleted = new ObjectId();
    const srcFailed = new ObjectId();
    const srcPending = new ObjectId();
    const srcProcessing = new ObjectId();

    const past = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const lockDeadline = new Date(Date.now() - 30 * 60 * 1000); // 30m ago

    let handlerCalls: string[] = [];

    beforeEach(async () => {
        handlerCalls = [];
        instance = getNewInstance();
        await instance.initInstance({
            reactiveTaskConcurrency: 2,
            minBatchIntervalMs: 10,
            minPollMs: 10,
        } as never);
        API = instance.mongodash;

        await API.reactiveTask({
            task: taskName,
            collection: sourceCollectionName,
            handler: async (context) => {
                handlerCalls.push(String(context.docId));
            },
        });

        // Records exactly as pre-2.3.1 wrote them: no nextRunAt/dueAt, a past
        // scheduledAt retained even on terminal records, lock in lockExpiresAt.
        const legacy = (id: ObjectId, sourceDocId: ObjectId, status: string, extra: Record<string, unknown> = {}) => ({
            _id: id,
            task: taskName,
            sourceDocId,
            status,
            attempts: 1,
            scheduledAt: past,
            createdAt: past,
            updatedAt: past,
            ...extra,
        });

        await API.getCollection(tasksCollectionName).insertMany([
            legacy(completedId, srcCompleted, 'completed', { completedAt: past, lastError: null }),
            legacy(failedId, srcFailed, 'failed', { lastError: 'boom' }),
            legacy(pendingId, srcPending, 'pending'),
            legacy(processingId, srcProcessing, 'processing', { lockExpiresAt: lockDeadline, startedAt: past }),
        ] as never);

        await API.startReactiveTasks();
    });

    afterEach(async () => {
        await API.stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    const read = async (id: ObjectId) => (await API.getCollection(tasksCollectionName).findOne({ _id: id } as never)) as unknown as Record<string, unknown>;

    it('never re-executes historical completed/failed records', async () => {
        // Give the workers ample opportunity to (wrongly) claim them.
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const completed = await read(completedId);
        expect(completed.nextRunAt).toBeNull(); // stays out of the polling index
        expect(completed.status).toBe('completed'); // never re-claimed

        const failed = await read(failedId);
        expect(failed.nextRunAt).toBeNull();
        expect(failed.status).toBe('failed');

        // The decisive assertion: no handler ran for a historical terminal
        // record. Migrating `scheduledAt` verbatim (the bug this pins) made
        // both of these due and replayed their side effects.
        expect(handlerCalls).not.toContain(String(srcCompleted));
        expect(handlerCalls).not.toContain(String(srcFailed));

        // Non-terminal legacy records SHOULD become runnable again - that is the
        // whole point of the migration.
        expect(handlerCalls).toEqual(expect.arrayContaining([String(srcPending), String(srcProcessing)]));
    });

    it('makes pending records runnable again and preserves the lag baseline', async () => {
        const pending = await read(pendingId);
        expect(pending.dueAt).toEqual(past); // initialScheduledAt absent -> falls back to scheduledAt
        // nextRunAt is either the migrated past date or already consumed by a
        // worker; either way it must no longer be missing.
        expect(pending.nextRunAt === undefined).toBe(false);
    });

    it('maps a legacy processing record onto the new visibility deadline', async () => {
        const processing = await read(processingId);
        // Zombie recovery must keep working: the old lockExpiresAt becomes nextRunAt.
        expect(processing.nextRunAt === undefined).toBe(false);
        expect(processing.dueAt).toEqual(past);
    });

    it('drops the legacy fields', async () => {
        for (const id of [completedId, failedId, pendingId, processingId]) {
            const doc = await read(id);
            expect(doc.scheduledAt).toBeUndefined();
            expect(doc.initialScheduledAt).toBeUndefined();
            expect(doc.lockExpiresAt).toBeUndefined();
        }
    });

    it('records the migration marker so it does not rescan on every start', async () => {
        const meta = (await API.getCollection('_mongodash_globals').findOne({ _id: '_mongodash_planner_meta' } as never)) as unknown as Record<string, unknown>;
        expect(meta.legacyScheduledAtMigratedAt).toBeInstanceOf(Date);
    });

    it('does not rescan once the marker is set (the migration is one-shot per cluster)', async () => {
        // The gate keeps an unindexable query off every startup. The documented
        // consequence: a legacy record appearing AFTER the marker (only possible
        // if a pre-2.3.1 instance is still writing during a mixed rolling
        // window) is not picked up - hence the "stop old instances first"
        // guidance in the changelog.
        await API.stopReactiveTasks();

        const lateId = new ObjectId();
        await API.getCollection(tasksCollectionName).insertOne({
            _id: lateId,
            task: taskName,
            sourceDocId: new ObjectId(),
            status: 'pending',
            attempts: 0,
            scheduledAt: past,
            createdAt: past,
            updatedAt: past,
        } as never);

        await API.startReactiveTasks();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const late = await read(lateId);
        expect(late.nextRunAt).toBeUndefined(); // untouched: no second scan
        expect(late.scheduledAt).toEqual(past);
    });
});
