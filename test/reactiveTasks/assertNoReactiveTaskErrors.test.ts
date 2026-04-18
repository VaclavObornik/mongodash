import { getNewInstance } from '../testHelpers';

describe('assertNoReactiveTaskErrors', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let testDB: any;

    // Dynamic references
    let reactiveTask: any;
    let waitUntilReactiveTasksIdle: any;
    let assertNoReactiveTaskErrors: any;
    let startReactiveTasks: any;
    let stopReactiveTasks: any;

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance({
            globalsCollection: 'globals',
            reactiveTaskConcurrency: 2,
            minBatchIntervalMs: 10,
            minPollMs: 10,
        } as any);

        const mongodash = instance.mongodash;
        reactiveTask = mongodash.reactiveTask;
        startReactiveTasks = mongodash.startReactiveTasks;
        stopReactiveTasks = mongodash.stopReactiveTasks;

        // Load helpers after resetModules to bind to same instance
        waitUntilReactiveTasksIdle = require('../../src/testing/waitUntilReactiveTasksIdle').waitUntilReactiveTasksIdle;
        assertNoReactiveTaskErrors = require('../../src/testing/assertNoReactiveTaskErrors').assertNoReactiveTaskErrors;

        testDB = mongodash.getCollection('test_assert_errors');
        await testDB.deleteMany({});
    });

    afterEach(async () => {
        await stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    it('should pass if no errors occurred', async () => {
        // Register a simple task before starting
        await reactiveTask({
            task: 'simple_task',
            collection: 'test_assert_errors',
            handler: async () => {
                // no-op
            },
        });
        await startReactiveTasks();

        const since = new Date();
        await assertNoReactiveTaskErrors({ since });
    });

    it('should detect errors (global)', async () => {
        await reactiveTask({
            task: 'failing_task',
            collection: 'test_assert_errors',
            handler: async () => {
                throw new Error('Planned Failure');
            },
            retryPolicy: { type: 'fixed', interval: '1ms', maxAttempts: 1 },
        });
        await startReactiveTasks();

        const since = new Date();
        await testDB.insertOne({ status: 'new' });

        await waitUntilReactiveTasksIdle();

        let error;
        try {
            await assertNoReactiveTaskErrors({ since });
        } catch (e: any) {
            error = e;
        }

        expect(error).toBeDefined();
        expect(error.message).toContain('Planned Failure');
    });

    it('should ignore errors outside whitelist scope', async () => {
        await reactiveTask({
            task: 'failing_task',
            collection: 'test_assert_errors',
            handler: async () => {
                throw new Error('Should Be Ignored');
            },
            retryPolicy: { type: 'fixed', interval: '1ms', maxAttempts: 1 },
        });
        await startReactiveTasks();

        const since = new Date();
        await testDB.insertOne({ status: 'new' });
        await waitUntilReactiveTasksIdle();

        // Check ONLY another collection (where no errors exist)
        await assertNoReactiveTaskErrors({
            since,
            whitelist: [{ collection: 'other_collection' }],
        });
    });

    it('should detect errors matching whitelist scope', async () => {
        await reactiveTask({
            task: 'target_task',
            collection: 'test_assert_errors',
            handler: async () => {
                throw new Error('Should Be Detected');
            },
            retryPolicy: { type: 'fixed', interval: '1ms', maxAttempts: 1 },
        });
        await startReactiveTasks();

        const since = new Date();
        const res = await testDB.insertOne({ status: 'new' });
        await waitUntilReactiveTasksIdle();

        let error;
        try {
            await assertNoReactiveTaskErrors({
                since,
                whitelist: [{ collection: 'test_assert_errors', filter: { _id: res.insertedId } }],
            });
        } catch (e: any) {
            error = e;
        }

        expect(error).toBeDefined();
        expect(error.message).toContain('Should Be Detected');
    });

    it('ignores errors matching excludeErrors (string exact + RegExp)', async () => {
        await reactiveTask({
            task: 'multi_failing_task',
            collection: 'test_assert_errors',
            handler: async (ctx: any) => {
                const doc = await testDB.findOne({ _id: ctx.docId });
                if (doc?.kind === 'auth') throw new Error('Expected Failure');
                if (doc?.kind === 'authz') throw new Error('Authorization Error: forbidden');
                if (doc?.kind === 'real') throw new Error('real unexpected issue');
            },
        });

        await startReactiveTasks();
        const since = new Date();
        const a = await testDB.insertOne({ kind: 'auth' });
        const b = await testDB.insertOne({ kind: 'authz' });
        await waitUntilReactiveTasksIdle({ timeoutMs: 8000 });

        // Both errors are whitelisted (one as string exact, one via RegExp)
        await assertNoReactiveTaskErrors({
            since,
            excludeErrors: ['Expected Failure', /Authorization Error/],
            whitelist: [{ collection: 'test_assert_errors', filter: { _id: { $in: [a.insertedId, b.insertedId] } } }],
        });

        // A non-whitelisted error still fails the assertion.
        const c = await testDB.insertOne({ kind: 'real' });
        await waitUntilReactiveTasksIdle({ timeoutMs: 8000 });
        await expect(
            assertNoReactiveTaskErrors({
                since,
                excludeErrors: ['Expected Failure', /Authorization Error/],
                whitelist: [{ collection: 'test_assert_errors', filter: { _id: c.insertedId } }],
            }),
        ).rejects.toThrow(/real unexpected issue/);
    }, 20000);

    it('should ignore errors matching whitelist collection but NOT filter', async () => {
        await reactiveTask({
            task: 'target_task',
            collection: 'test_assert_errors',
            handler: async (ctx: any) => {
                // Only fail for docs with status 'new'
                const doc = await ctx.getDocument();
                if (doc.status === 'new') {
                    throw new Error('Should Be Ignored');
                }
            },
            retryPolicy: { type: 'fixed', interval: '1ms', maxAttempts: 1 },
        });
        await startReactiveTasks();

        const since = new Date();
        await testDB.insertOne({ status: 'new' }); // Fails
        const otherDoc = await testDB.insertOne({ status: 'new_ok' }); // Succeeds

        await waitUntilReactiveTasksIdle();

        // Whitelist a DIFFERENT doc (using filter)
        // The first doc has errors but isn't in the whitelist, so should be ignored
        await assertNoReactiveTaskErrors({
            since,
            whitelist: [{ collection: 'test_assert_errors', filter: { _id: otherDoc.insertedId } }],
        });
    });
});
