import { ObjectId } from 'mongodb';
import { CODE_REACTIVE_TASK_LOCK_LOST } from '../../src';
import { getNewInstance, wait } from '../testHelpers';

/**
 * Covers the worker's reaction to losing its task lock mid-handler, added in
 * Iter 2. When a slow handler runs past the visibility timeout and another
 * worker claims the task, the CAS renewal detects the steal and the original
 * worker must:
 *   - emit onInfo with CODE_REACTIVE_TASK_LOCK_LOST
 *   - NOT finalize the task record (the new claimant owns it now)
 */
describe('ReactiveTaskWorker - lock lost handling', () => {
    let instance: ReturnType<typeof getNewInstance>;
    const COLLECTION = 'lock_lost_source';

    beforeEach(async () => {
        instance = getNewInstance();
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('emits CODE_REACTIVE_TASK_LOCK_LOST and skips finalize when the lock is stolen', async () => {
        const onInfoCalls: Array<{ code?: string }> = [];

        await instance.initInstance({
            globalsCollection: '_mongodash_locklost_globals',
            visibilityTimeoutMs: 1000,
            onInfo: (info: { code?: string }) => {
                onInfoCalls.push(info);
            },
            monitoring: { enabled: false },
        } as never);

        const source = instance.mongodash.getCollection(COLLECTION);
        const tasks = instance.mongodash.getCollection(`${COLLECTION}_tasks`);

        const docId = new ObjectId();

        let inHandler = false;
        let handlerReleased = false;
        await instance.mongodash.reactiveTask({
            collection: COLLECTION,
            task: 'slow-task',
            handler: async () => {
                inHandler = true;
                // Busy-wait until the test tampers with the lock and gives us the go-ahead.
                while (!handlerReleased) await wait(20);
            },
        });

        await source.insertOne({ _id: docId as never });
        await instance.mongodash.startReactiveTasks();

        // Wait for the worker to claim the task.
        for (let i = 0; i < 50 && !inHandler; i += 1) await wait(50);
        expect(inHandler).toBe(true);

        // Simulate another worker stealing the lock by rewriting nextRunAt.
        // The original worker's CAS-based renewal should then fail.
        await tasks.updateOne({ sourceDocId: docId as never }, { $set: { nextRunAt: new Date(Date.now() + 60000) } });

        // Wait long enough for the next renewal tick (lockTime/5 = 200ms).
        await wait(400);

        // Release the handler - it has been running for a while now.
        handlerReleased = true;

        // Give the worker a chance to run through its post-handler branch.
        await wait(300);

        const lockLostEvents = onInfoCalls.filter((c) => c.code === CODE_REACTIVE_TASK_LOCK_LOST);
        expect(lockLostEvents.length).toBeGreaterThanOrEqual(1);

        const taskRecord = await tasks.findOne({ sourceDocId: docId as never });
        // The status must NOT be flipped to completed by the original worker,
        // which would clobber the new claimant's state.
        expect(taskRecord?.status).not.toBe('completed');
    });
});
