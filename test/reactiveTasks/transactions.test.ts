import { ObjectId } from 'mongodb';
import { getNewInstance, wait } from '../testHelpers';

describe('Reactive Task Transactions', () => {
    let instance: ReturnType<typeof getNewInstance>;
    const SOURCE_COLLECTION = 'source';

    beforeEach(() => {
        instance = getNewInstance();
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('should allow manual atomic completion within a transaction', async () => {
        await instance.initInstance({
            monitoring: { enabled: false },
            reactiveTaskConcurrency: 2,
        });

        const collection = instance.mongodash.getCollection(SOURCE_COLLECTION);
        const courseId = new ObjectId();
        await collection.insertOne({ _id: courseId, title: 'Draft Course' });

        let processed = false;

        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'publish-course',
            watchProjection: { _id: 1 }, // Watch only ID (never changes) to prevent 'title' updates from re-triggering task
            handler: async (context: any) => {
                // Type 'any' to avoid strict type import issues in test setup for now
                const { docId, markCompleted } = context;
                const client = instance.mongodash.getMongoClient();
                const session = client.startSession();
                try {
                    await session.withTransaction(async () => {
                        // 1. Business Logic: Update document
                        await collection.updateOne({ _id: docId }, { $set: { title: 'Published Course' } }, { session });

                        // 2. Mark task as completed in same transaction
                        await markCompleted({ session });
                    });
                } finally {
                    await session.endSession();
                }
                processed = true;
            },
        });

        await instance.mongodash.startReactiveTasks();

        // Wait for processing
        await wait(2000);

        expect(processed).toBe(true);

        // Verify Source Doc Update
        const updatedCourse = await collection.findOne({ _id: courseId });
        expect(updatedCourse?.title).toBe('Published Course');

        // Verify Task Status
        const tasksCollection = instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`);
        const task = await tasksCollection.findOne({ task: 'publish-course', sourceDocId: courseId });
        expect(task).toBeDefined();
        expect(task?.status).toBe('completed');
        expect(task?.attempts).toBe(1);
        expect(task?.lastError).toBeFalsy();
    });

    it('should fallback to automatic completion if markCompleted is not called', async () => {
        await instance.initInstance({ monitoring: { enabled: false } });
        const collection = instance.mongodash.getCollection(SOURCE_COLLECTION);
        const courseId = new ObjectId();
        await collection.insertOne({ _id: courseId, title: 'Draft Course 2' });

        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'simple-task',
            handler: async () => {
                // Do nothing special
            },
        });

        await instance.mongodash.startReactiveTasks();
        await wait(1500);

        const tasksCollection = instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`);
        const task = await tasksCollection.findOne({ task: 'simple-task', sourceDocId: courseId });
        expect(task?.status).toBe('completed');
    });

    it('should retry task if transaction aborts (rollback)', async () => {
        // This test simulates a failure inside the transaction AFTER markCompleted was called.
        // The transaction should rollback the 'completed' status, and the worker should catch the error.

        await instance.initInstance({ monitoring: { enabled: false } });
        const collection = instance.mongodash.getCollection(SOURCE_COLLECTION);

        const courseId = new ObjectId();
        await collection.insertOne({ _id: courseId, title: 'Rolling Back' });

        let attempts = 0;

        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'failing-transaction',
            retryPolicy: { maxAttempts: 2, type: 'linear', interval: '100ms' },
            handler: async (context: any) => {
                const { docId, markCompleted } = context;
                attempts++;
                const client = instance.mongodash.getMongoClient();
                const session = client.startSession();
                try {
                    await session.withTransaction(async () => {
                        // 1. Business Logic
                        await collection.updateOne(
                            { _id: docId },
                            { $set: { title: 'Processing...' } }, // temporary state
                            { session },
                        );

                        // 2. Mark completed
                        await markCompleted({ session });

                        // 3. OOPS! Something goes wrong
                        throw new Error('Transaction Explosion');
                    });
                } finally {
                    await session.endSession();
                }
            },
        });

        await instance.mongodash.startReactiveTasks();
        await wait(2500); // Wait for retries

        expect(attempts).toBeGreaterThanOrEqual(2);

        // Verify Source Doc is NOT changed (rollback)
        const course = await collection.findOne({ _id: courseId });
        expect(course?.title).toBe('Rolling Back'); // Should be original value

        // Verify Task is FAILED (because retry policy exhausted)
        const tasksCollection = instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`);
        const task = await tasksCollection.findOne({ task: 'failing-transaction', sourceDocId: courseId });
        expect(task?.status).toBe('failed');
        expect(task?.lastError).toContain('Transaction Explosion');
    });

    it('should support idempotent calls to markCompleted', async () => {
        await instance.initInstance({ monitoring: { enabled: false } });
        const collection = instance.mongodash.getCollection(SOURCE_COLLECTION);
        const courseId = new ObjectId();
        await collection.insertOne({ _id: courseId });

        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'idempotent-check',
            handler: async (context: any) => {
                const { markCompleted } = context;
                await markCompleted();
                await markCompleted(); // Should not error
            },
        });

        await instance.mongodash.startReactiveTasks();
        await wait(1000);

        const tasksCollection = instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`);
        const task = await tasksCollection.findOne({ task: 'idempotent-check', sourceDocId: courseId });
        expect(task?.status).toBe('completed');
    });
});
