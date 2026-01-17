import { getNewInstance } from '../testHelpers';

// Helper to simulate time passing if needed, or just sleep
// Helper to simulate time passing if needed, or just sleep
// const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

jest.setTimeout(30000);

describe('assertNoReactiveTaskErrors', () => {
    let sourceCol: any;
    let tasksCol: any;
    let globalsCol: any;
    let instance: ReturnType<typeof getNewInstance>;

    // Dynamic references
    let startReactiveTasks: any;
    let stopReactiveTasks: any;
    let reactiveTask: any;
    let waitUntilReactiveTasksIdle: any;
    let assertNoReactiveTaskErrors: any;
    let ObjectId: any;

    beforeEach(async () => {
        jest.resetModules();
        const { getNewInstance } = require('../testHelpers');
        instance = getNewInstance();

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

        // Load helpers dynamically
        waitUntilReactiveTasksIdle = require('../../src/testing/waitUntilReactiveTasksIdle').waitUntilReactiveTasksIdle;
        assertNoReactiveTaskErrors = require('../../src/testing/assertNoReactiveTaskErrors').assertNoReactiveTaskErrors;
        ObjectId = require('mongodb').ObjectId;

        // Use unique collections for each test to ensure isolation
        const randomId = new ObjectId().toHexString();
        const sourceName = `test_assert_source_${randomId}`;
        const tasksName = `test_assert_source_${randomId}_tasks`;

        sourceCol = mongodash.getCollection(sourceName);
        tasksCol = mongodash.getCollection(tasksName);
        globalsCol = mongodash.getCollection('globals'); // Shared globals is fine

        // Cleanup (just in case)
        await sourceCol.deleteMany({});
        await tasksCol.deleteMany({});
        await globalsCol.deleteMany({});
    });

    afterEach(async () => {
        if (stopReactiveTasks) await stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    it('passes when no errors occurred', async () => {
        const startTime = new Date();

        await reactiveTask({
            task: 'task_success',
            collection: sourceCol.collectionName,
            debounce: 0,
            handler: async () => {
                /* success */
            },
        });

        await startReactiveTasks();
        await sourceCol.insertOne({ status: 'new' });
        await waitUntilReactiveTasksIdle();

        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).resolves.not.toThrow();
    });

    it('detects a failed task', async () => {
        const startTime = new Date();

        await reactiveTask({
            task: 'task_fail',
            collection: sourceCol.collectionName,
            filter: { fail: true },
            debounce: 0,
            retryPolicy: { maxAttempts: 1, type: 'fixed', interval: '1s' },
            handler: async () => {
                throw new Error('Boom!');
            },
        });

        await startReactiveTasks();
        await sourceCol.insertOne({ fail: true });

        // Wait for it to fail
        await waitUntilReactiveTasksIdle();

        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).rejects.toThrow(/Found 1 unexpected reactive task errors/);

        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).rejects.toThrow(/Task 'task_fail'/);

        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).rejects.toThrow(/Boom!/);
    });

    it('respects the time filter (since)', async () => {
        await reactiveTask({
            task: 'task_fail_early',
            collection: sourceCol.collectionName,
            filter: { fail: true },
            debounce: 0,
            retryPolicy: { maxAttempts: 1, type: 'fixed', interval: '1s' },
            handler: async () => {
                throw new Error('Early Error');
            },
        });

        await startReactiveTasks();

        // 1. Trigger error
        await sourceCol.insertOne({ fail: true });
        await waitUntilReactiveTasksIdle();

        // 2. Mark "start time" for the next phase
        const startTime = new Date(Date.now() + 10); // slightly in future to be safe

        // 3. Asset NO errors since this new timestamp
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).resolves.not.toThrow();
    });

    it('filters by sourceDocIds', async () => {
        const startTime = new Date();
        const id1 = new ObjectId();
        const id2 = new ObjectId();

        await reactiveTask({
            task: 'task_mixed',
            collection: sourceCol.collectionName,
            debounce: 0,
            retryPolicy: { maxAttempts: 1, type: 'fixed', interval: '1s' },
            handler: async (ctx: any) => {
                throw new Error(`Error for ${ctx.docId}`);
            },
        });

        await startReactiveTasks();

        // Fail both documents
        await sourceCol.insertMany([{ _id: id1 }, { _id: id2 }]);
        await waitUntilReactiveTasksIdle();

        // Check GLOBAL -> fails (found 2)
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).rejects.toThrow(/Found 2 unexpected/);

        // Check ID1 -> fails (found 1)
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                sourceDocIds: [id1],
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).rejects.toThrow(/Doc: .*? Error for/);

        // Check random ID -> success (0 found)
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                sourceDocIds: [new ObjectId()],
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).resolves.not.toThrow();
    });

    it('excludes errors via whitelist', async () => {
        const startTime = new Date();

        await reactiveTask({
            task: 'task_whitelist',
            collection: sourceCol.collectionName,
            debounce: 0,
            retryPolicy: { maxAttempts: 1, type: 'fixed', interval: '1s' },
            handler: async () => {
                throw new Error('Expected Failure');
            },
        });

        await startReactiveTasks();
        await sourceCol.insertOne({ fail: true });
        await waitUntilReactiveTasksIdle();

        // Exact string match
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                excludeErrors: ['Expected Failure'],
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).resolves.not.toThrow();

        // Regex match
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                excludeErrors: [/Expected/],
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).resolves.not.toThrow();

        // Mismatch throws
        await expect(
            assertNoReactiveTaskErrors({
                since: startTime,
                excludeErrors: ['Other Error'],
                scheduler: require('../../src/reactiveTasks')._scheduler,
            }),
        ).rejects.toThrow(/Expected Failure/);
    });
});
