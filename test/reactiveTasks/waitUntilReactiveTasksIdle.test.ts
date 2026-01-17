import { getNewInstance } from '../testHelpers';

// Helper to simulate time passing if needed, or just sleep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

jest.setTimeout(30000);

describe('waitUntilReactiveTasksIdle', () => {
    let sourceCol: any;
    let tasksCol: any;
    let globalsCol: any;
    let instance: ReturnType<typeof getNewInstance>;

    // Dynamic references
    let startReactiveTasks: any;
    let stopReactiveTasks: any;
    let reactiveTask: any;
    let waitUntilReactiveTasksIdle: any;
    let ObjectId: any;

    beforeEach(async () => {
        instance = getNewInstance();
        // Do NOT init yet, we need to setup collections first?
        // No, getNewInstance provides collectionFactory which uses getCollection.
        // We can get collections from mongodash object before init?
        // getCollection usually requires init.
        // BUT getNewInstance's collectionFactory handles it or we use instance.mongodash.getCollection AFTER init.

        // Wait, getNewInstance's initInstance calls init.
        // We passed collectionFactory hook in getNewInstance.

        // Let's Init FIRST.
        await instance.initInstance({
            globalsCollection: 'globals',
            reactiveTaskConcurrency: 2,
            minBatchIntervalMs: 10,
            minPollMs: 10,
        } as any);

        const mongodash = instance.mongodash;

        startReactiveTasks = mongodash.startReactiveTasks;
        stopReactiveTasks = mongodash.stopReactiveTasks;
        reactiveTask = mongodash.reactiveTask;

        // Load helper strictly after resetModules (which happened in getNewInstance)
        // We need to re-require the helper so it binds to the SAME reactiveTasks module instance
        waitUntilReactiveTasksIdle = require('../../src/testing/waitUntilReactiveTasksIdle').waitUntilReactiveTasksIdle;
        ObjectId = require('mongodb').ObjectId;

        sourceCol = mongodash.getCollection('test_idle_source');
        tasksCol = mongodash.getCollection('test_idle_source_tasks');
        globalsCol = mongodash.getCollection('globals');

        // Cleanup
        await sourceCol.deleteMany({});
        await tasksCol.deleteMany({});
        await globalsCol.deleteMany({});
    });

    afterEach(async () => {
        if (stopReactiveTasks) await stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    it('resolves immediately when no tasks exist', async () => {
        await startReactiveTasks();
        await waitUntilReactiveTasksIdle({ stabilityDurationMs: 50 });
    });

    it('waits for a task to complete', async () => {
        let processed = false;
        await reactiveTask({
            task: 'test_idle_task',
            collection: 'test_idle_source',
            handler: async () => {
                await sleep(100);
                processed = true;
            },
        });

        await startReactiveTasks();

        // Trigger task
        await sourceCol.insertOne({ _id: new ObjectId(), status: 'new' });

        // Should wait until processed is true AND system is settled
        await waitUntilReactiveTasksIdle();

        expect(processed).toBe(true);
        const count = await tasksCol.countDocuments({ status: 'pending' });
        expect(count).toBe(0);
    });

    it('waits for cascading tasks (chain reaction)', async () => {
        let stepA = false;
        let stepB = false;

        await reactiveTask({
            task: 'task_A',
            collection: 'test_idle_source',
            filter: { step: 'A' },
            handler: async (_doc: any) => {
                await sleep(50);
                stepA = true;
                // Trigger B via NEW INSERT
                await sourceCol.insertOne({ step: 'B' });
            },
        });

        await reactiveTask({
            task: 'task_B',
            collection: 'test_idle_source',
            filter: { step: 'B' },
            handler: async () => {
                await sleep(50);
                stepB = true;
            },
        });

        await startReactiveTasks();

        // Start Chain
        await sourceCol.insertOne({ step: 'A' });

        await waitUntilReactiveTasksIdle();

        expect(stepA).toBe(true);
        expect(stepB).toBe(true);
    });

    it('resolves even if a task fails (current behavior)', async () => {
        let attempts = 0;
        await reactiveTask({
            task: 'task_fail',
            collection: 'test_idle_source',
            filter: { bg: 'fail' },
            handler: async () => {
                attempts++;
                throw new Error('Task Failed');
            },
            retryPolicy: { maxAttempts: 1, type: 'fixed', interval: '1s' }, // Fail immediately, no retries
        });

        await startReactiveTasks();

        // Trigger task
        await sourceCol.insertOne({ bg: 'fail' });

        // Should resolve because failed task is not "pending"
        await waitUntilReactiveTasksIdle();

        expect(attempts).toBe(1);
        const count = await tasksCol.countDocuments({ status: 'failed' });
        expect(count).toBe(1);
        expect(count).toBe(1);
    });

    it('resolves intentionally if a task is retrying in the distant future', async () => {
        let attempts = 0;
        await reactiveTask({
            task: 'task_future_retry',
            collection: 'test_idle_source',
            filter: { bg: 'future' },
            debounce: 0,
            handler: async () => {
                attempts++;
                throw new Error('Task Failed');
            },
            retryPolicy: {
                maxAttempts: 5,
                type: 'fixed',
                interval: '1h', // Retry in 1 hour
            },
        });

        await startReactiveTasks();

        // Trigger task
        await sourceCol.insertOne({ bg: 'future' });

        // Should RESOLVE because the task is pending but scheduled for 1h later,
        // which is beyond our timeout.
        await waitUntilReactiveTasksIdle({ timeoutMs: 1000, pollIntervalMs: 50 });

        expect(attempts).toBe(1);
    });
});
