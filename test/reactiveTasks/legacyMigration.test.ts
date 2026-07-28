import { ObjectId } from 'mongodb';
import { getNewInstance, wait, waitUntil } from '../testHelpers';

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

    it('records a per-collection marker so it does not rescan on every start', async () => {
        const meta = (await API.getCollection('_mongodash_globals').findOne({ _id: '_mongodash_planner_meta' } as never)) as unknown as Record<string, unknown>;
        // Per collection, not one cluster-wide flag: a leader only sees the
        // tasks registered on its own instance.
        expect(meta.legacyMigratedCollections).toEqual([tasksCollectionName]);
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

/**
 * A mixed-version artifact: a pre-2.3.1 finalize cannot null `nextRunAt`, so a
 * terminal record can carry a past DATED nextRunAt. The polling query's
 * `status: { $nin: ['completed', 'failed'] }` guard must keep workers from ever
 * re-claiming such a record - re-running it would replay its side effects.
 */
describe('claim guard for terminal records with a dated nextRunAt', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let API: typeof instance.mongodash;

    const taskName = 'terminal-claim-guard-task';
    const sourceCollectionName = 'terminal_claim_guard_items';
    const tasksCollectionName = 'terminal_claim_guard_items_tasks';

    const completedId = new ObjectId();
    const failedId = new ObjectId();
    const pendingId = new ObjectId();

    const srcCompleted = new ObjectId();
    const srcFailed = new ObjectId();
    const srcPending = new ObjectId();

    // The terminal records are the MOST due ones (earliest nextRunAt), so a
    // missing status guard would claim them before the healthy pending record.
    const longPast = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 60 * 1000);

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

        const record = (id: ObjectId, sourceDocId: ObjectId, status: string, nextRunAt: Date, extra: Record<string, unknown> = {}) => ({
            _id: id,
            task: taskName,
            sourceDocId,
            status,
            attempts: 1,
            nextRunAt,
            dueAt: past,
            createdAt: past,
            updatedAt: past,
            ...extra,
        });

        await API.getCollection(tasksCollectionName).insertMany([
            record(completedId, srcCompleted, 'completed', longPast, { completedAt: past, lastError: null }),
            record(failedId, srcFailed, 'failed', longPast, { lastError: 'boom' }),
            record(pendingId, srcPending, 'pending', past, { attempts: 0 }),
        ] as never);

        await API.startReactiveTasks();
    });

    afterEach(async () => {
        await API.stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    it('never claims completed/failed records while a normal pending record is processed', async () => {
        // The healthy pending record proves the workers ARE polling.
        await waitUntil(() => handlerCalls.includes(String(srcPending)), { timeoutMs: 10000, message: 'pending record should be processed' });

        // Negative assertion: give the workers ample time to (wrongly) claim
        // the terminal records too.
        await wait(800);

        const read = async (id: ObjectId) => (await API.getCollection(tasksCollectionName).findOne({ _id: id } as never)) as unknown as Record<string, unknown>;

        const completed = await read(completedId);
        expect(completed.status).toBe('completed');
        expect(completed.attempts).toBe(1); // findAndLockNextTask would $inc it
        expect(completed.startedAt).toBeUndefined(); // and stamp startedAt

        const failed = await read(failedId);
        expect(failed.status).toBe('failed');
        expect(failed.attempts).toBe(1);
        expect(failed.startedAt).toBeUndefined();

        expect(handlerCalls).not.toContain(String(srcCompleted));
        expect(handlerCalls).not.toContain(String(srcFailed));
    }, 20000);
});

/**
 * Legacy straggler self-heal: the one-time migration is marker-gated, so a
 * pre-2.3.1 record written AFTER the migration ran (an old instance still
 * alive during a rolling window) is invisible to polling - it has no dated
 * `nextRunAt`. The planning `$merge` whenMatched branch must heal it by
 * mapping the missing nextRunAt to `$$new.nextRunAt` on non-terminal records.
 */
describe('legacy straggler self-heal via the planning pipeline', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let API: typeof instance.mongodash;

    const taskName = 'legacy-straggler-task';
    const sourceCollectionName = 'legacy_straggler_items';
    const tasksCollectionName = 'legacy_straggler_items_tasks';

    const stragglerId = new ObjectId();
    const srcId = new ObjectId();
    const past = new Date(Date.now() - 60 * 60 * 1000);

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
            debounce: 10,
            handler: async (context) => {
                handlerCalls.push(String(context.docId));
            },
        });

        // The source document exists, so reconciliation on startup plans a task
        // for it and the $merge takes the whenMatched path over the straggler.
        await API.getCollection(sourceCollectionName).insertOne({ _id: srcId } as never);

        // The straggler exactly as a pre-2.3.1 instance writes it: scheduledAt,
        // NO nextRunAt - invisible to the polling query until healed.
        await API.getCollection(tasksCollectionName).insertOne({
            _id: stragglerId,
            task: taskName,
            sourceDocId: srcId,
            status: 'pending',
            attempts: 0,
            scheduledAt: past,
            createdAt: past,
            updatedAt: past,
        } as never);

        // The collection is ALREADY marked migrated, so the one-time migration
        // must skip it - only the planning pipeline can heal the record.
        await API.getCollection('_mongodash_globals').updateOne(
            { _id: '_mongodash_planner_meta' } as never,
            { $set: { legacyMigratedCollections: [tasksCollectionName] } } as never,
            { upsert: true },
        );

        await API.startReactiveTasks();
    });

    afterEach(async () => {
        await API.stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    it('heals the straggler with a dated nextRunAt and executes it', async () => {
        const read = async () => (await API.getCollection(tasksCollectionName).findOne({ _id: stragglerId } as never)) as unknown as Record<string, unknown>;

        // Reconciliation plans the source doc; whenMatched maps the missing
        // nextRunAt to a date, making the record claimable.
        await waitUntil(async () => (await read()).nextRunAt instanceof Date, { timeoutMs: 15000, message: 'straggler should gain a dated nextRunAt' });

        // ...and the task actually executes to completion.
        await waitUntil(() => handlerCalls.includes(String(srcId)), { timeoutMs: 15000, message: 'straggler task should execute' });
        await waitUntil(async () => (await read()).status === 'completed', { timeoutMs: 15000, message: 'straggler task should complete' });

        // Proof the heal came from the planning pipeline, not from a second run
        // of the one-time migration: the migration $unsets scheduledAt, the
        // whenMatched branch leaves it in place.
        expect((await read()).scheduledAt).toEqual(past);
    }, 30000);
});
