import { ObjectId } from 'mongodb';
import { CODE_REACTIVE_TASK_DEFER_IGNORED } from '../../src';
import { waitUntil } from '../../src/testing';
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

        let handlerCompletions = 0;
        let secondMarkCompletedThrew: Error | null = null;
        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'idempotent-check',
            handler: async (context: any) => {
                const { markCompleted } = context;
                await markCompleted();
                try {
                    await markCompleted(); // idempotent: must not throw
                } catch (err) {
                    // Record the failure but do not rethrow - otherwise the
                    // task ends up 'failed' and the waitUntil below times
                    // out obscuring the real assertion.
                    secondMarkCompletedThrew = err as Error;
                }
                handlerCompletions += 1;
            },
        });

        await instance.mongodash.startReactiveTasks();

        const tasksCollection = instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`);
        // Wait for the task to settle on either 'completed' or 'failed' -
        // stopping early on 'failed' surfaces regressions with a clear
        // assertion instead of a 15s timeout.
        //
        // The success branch also waits for the handler to actually return:
        // markCompleted() writes 'completed' BEFORE the handler increments
        // handlerCompletions, so polling on status alone can observe the write
        // first and read a stale 0 below (an intermittent CI failure).
        await waitUntil(
            async () => {
                const doc = await tasksCollection.findOne({ task: 'idempotent-check', sourceDocId: courseId });
                return doc?.status === 'failed' || (doc?.status === 'completed' && handlerCompletions > 0);
            },
            { timeoutMs: 15000, pollIntervalMs: 100 },
        );

        // Actually exercise the "idempotent" assertion.
        expect(secondMarkCompletedThrew).toBeNull();
        expect(handlerCompletions).toBe(1);

        const task = await tasksCollection.findOne({ task: 'idempotent-check', sourceDocId: courseId });
        expect(task?.status).toBe('completed');
    });

    it('records the success duration sample when deferCurrent() is ignored after a transactional markCompleted', async () => {
        // A transactional markCompleted() holds its duration sample until the
        // handler returns (the transaction could still abort). When the handler
        // ALSO called deferCurrent(), the DEFER_IGNORED early-return must flush
        // that pending sample instead of dropping it.
        const infoCodes: string[] = [];
        await instance.initInstance({
            monitoring: { enabled: true, scrapeMode: 'local' },
            onInfo: ({ code }: { code: string }) => infoCodes.push(code),
        } as never);
        const collection = instance.mongodash.getCollection(SOURCE_COLLECTION);
        const courseId = new ObjectId();
        await collection.insertOne({ _id: courseId });

        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'defer-after-complete',
            handler: async (context: any) => {
                const client = instance.mongodash.getMongoClient();
                const session = client.startSession();
                try {
                    await session.withTransaction(async () => {
                        await context.markCompleted({ session });
                    });
                } finally {
                    await session.endSession();
                }
                context.deferCurrent(60000); // ignored - the completion wins
            },
        });

        await instance.mongodash.startReactiveTasks();

        // The DEFER_IGNORED branch runs after the handler returned, i.e. after
        // the transaction committed - exactly where the sample must be flushed.
        await waitUntil(() => infoCodes.includes(CODE_REACTIVE_TASK_DEFER_IGNORED), { timeoutMs: 15000, pollIntervalMs: 100 });

        const task = await instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`).findOne({ task: 'defer-after-complete', sourceDocId: courseId });
        expect(task?.status).toBe('completed');

        const registry = await instance.mongodash.getPrometheusMetrics();
        expect(registry).not.toBeNull();
        const json = await registry!.getMetricsAsJSON();
        const duration = json.find((metric: any) => metric.name === 'reactive_tasks_duration_seconds') as any;
        expect(duration).toBeDefined();

        const countSamples = duration.values.filter(
            (value: any) => value.metricName === 'reactive_tasks_duration_seconds_count' && value.labels?.task_name === 'defer-after-complete',
        );
        const successCount = countSamples.find((value: any) => value.labels.status === 'success');
        expect(successCount?.value).toBeGreaterThanOrEqual(1);
        expect(countSamples.find((value: any) => value.labels.status === 'failed')).toBeUndefined();
    }, 30000);

    it('keeps the task completed when the handler throws after a non-transactional markCompleted', async () => {
        // Counterpart to the aborted-transaction case above: here the completion
        // is durable, so the later throw must NOT revert it, retry it, or be
        // reported as a lost lock.
        const infoCodes: string[] = [];
        await instance.initInstance({
            monitoring: { enabled: false },
            onInfo: ({ code }: { code: string }) => infoCodes.push(code),
        } as never);
        const collection = instance.mongodash.getCollection(SOURCE_COLLECTION);
        const courseId = new ObjectId();
        await collection.insertOne({ _id: courseId });

        let attempts = 0;

        await instance.mongodash.reactiveTask({
            collection: SOURCE_COLLECTION,
            task: 'throw-after-complete',
            retryPolicy: { maxAttempts: 3, type: 'linear', interval: '100ms' },
            handler: async (context: any) => {
                attempts++;
                await context.markCompleted(); // durable, no session
                throw new Error('best-effort side effect failed');
            },
        });

        await instance.mongodash.startReactiveTasks();

        const tasksCollection = instance.mongodash.getCollection(`${SOURCE_COLLECTION}_tasks`);
        await waitUntil(
            async () => {
                const doc = await tasksCollection.findOne({ task: 'throw-after-complete', sourceDocId: courseId });
                return doc?.status === 'completed' || doc?.status === 'failed';
            },
            { timeoutMs: 15000, pollIntervalMs: 100 },
        );

        // Give any (wrong) retry a chance to fire.
        await wait(1000);

        const task = await tasksCollection.findOne({ task: 'throw-after-complete', sourceDocId: courseId });
        expect(task?.status).toBe('completed');
        expect(task?.nextRunAt).toBeNull();
        expect(attempts).toBe(1); // never retried
        expect(infoCodes).not.toContain('reactiveTaskLockLost'); // nothing was stolen
    });
});
