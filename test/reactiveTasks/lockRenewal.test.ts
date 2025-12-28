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

        // Wait 100ms (should have triggered ~2 updates)
        await wait(150);

        const updatedTask = await tasksCol.findOne({ sourceDocId: 'doc1' as any });
        const currentNextRunAt = updatedTask!.nextRunAt!.getTime();

        // VERIFY: The lock (nextRunAt) should have moved forward
        expect(currentNextRunAt).toBeGreaterThan(startNextRunAt);

        // Also, explicitly check that lockExpiresAt (legacy) is NOT there or disregarded
        // The current implementation ADDS lockExpiresAt! We want to ensure nextRunAt is the one moving.
        // Current buggy implementation: Updates lockExpiresAt, ignores nextRunAt.
        // So nextRunAt will be INITIAL value.
        // Failed expectation: currentNextRunAt > startNextRunAt
    });
});
