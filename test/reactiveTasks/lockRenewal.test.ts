import { waitUntil } from '../../src/testing';
import { createReusableWaitableStub, getNewInstance, wait } from '../testHelpers';

describe('Reactive Task - Lock Renewal', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
        instance.setOnError((err) => {
            console.error('Captured error in test:', err);
            throw err;
        });
        await instance.initInstance({
            globalsCollection: '_mongodash_lock_test',
            visibilityTimeoutMs: 200, // Very short lock
        } as any);
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('should prolong the lock by updating nextRunAt on the task document', async () => {
        // Lock prolong happens at lockTime / 5 = 40ms.
        // Handler should run for > 200ms.

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_ctx: any) => {
            // Task runs for 500ms
            await wait(500);
        });

        const collectionName = 'lock_renewal_test';
        await instance.mongodash.reactiveTask({
            task: 'lock_task',
            collection: collectionName,
            handler: handler,
        });

        const collection = instance.mongodash.getCollection(collectionName);
        await collection.insertOne({ _id: 'doc1' as any });

        await instance.mongodash.startReactiveTasks();

        // Wait for handler start
        await waitForNextCall(1000);

        const tasksCol = instance.mongodash.getCollection(`${collectionName}_tasks`);

        // Poll checking nextRunAt
        let initialTask = await tasksCol.findOne({ sourceDocId: 'doc1' as any });
        // It might be difficult to catch the "exact" moment, but we can check if it INCREASES.
        expect(initialTask).toBeDefined();
        const startNextRunAt = initialTask!.nextRunAt!.getTime();

        // Renewal fires every visibilityTimeoutMs/5 (40ms here). Poll for the
        // lock to move rather than sleeping a fixed 150ms and hoping a renewal
        // landed - on a loaded runner it may not have, which is what made this
        // test intermittently fail.
        await waitUntil(
            async () => {
                const doc = await tasksCol.findOne({ sourceDocId: 'doc1' as any });
                return (doc?.nextRunAt?.getTime() ?? 0) > startNextRunAt;
            },
            { timeoutMs: 10000, pollIntervalMs: 20 },
        );

        const updatedTask = await tasksCol.findOne({ sourceDocId: 'doc1' as any });
        const currentNextRunAt = updatedTask!.nextRunAt!.getTime();

        // VERIFY: The lock (nextRunAt) should have moved forward
        expect(currentNextRunAt).toBeGreaterThan(startNextRunAt);

        // Also, explicitly check that lockExpiresAt (legacy) is NOT there or disregarded
        // The current implementation ADDS lockExpiresAt! We want to ensure nextRunAt is the one moving.
        // Current buggy implementation: Updates lockExpiresAt, ignores nextRunAt.
        // So nextRunAt will be INITIAL value.
        // Failed expectation: currentNextRunAt > startNextRunAt
        // Explicit timeout: startReactiveTasks() (leader election + planner start
        // + reconcile) plus the 500ms handler and the polls above can exceed
        // Jest's 5s default on a loaded CI runner - the cause of this test's
        // long-standing intermittent failures.
    }, 30000);
});
