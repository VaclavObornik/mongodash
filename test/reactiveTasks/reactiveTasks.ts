import _debug from 'debug';
import { noop } from 'lodash';
import { Document } from 'mongodb';
import * as sinon from 'sinon';
import { createSandbox } from 'sinon';
import {
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STARTED,
    CODE_REACTIVE_TASK_STARTED,
    REACTIVE_TASK_META_DOC_ID,
} from '../../src/reactiveTasks/ReactiveTaskTypes';
import { createReusableWaitableStub, getNewInstance } from '../testHelpers';

const debug = _debug('mongodash:reactiveTasks');

describe('reactiveTasks', () => {
    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);
    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    /*
     1. watch collection for instant changes
     2. works even without special emitter
     3. separate mechanism
            1. task creator
                a) need to run regularly to not miss any document
                    i) what if somebody insert a cursorField with old value?
                    ii) is there any native mongodb way of collection cursor outside the documents?
                b) we can use aggregation pipeline with emit ($out) of changed documents to tasks collection
                    i) note the $out replaces existing documents, which might not be desired if it is locked by task a processor
                c) can be speed up by watching origin collection changes
                d) one thing is check if a document needs to check, another is to schedule task if necessary
            2. task processor
                a) how to detect there was a change needs processing?
                b) use lock to prevent concurrent processing
    */

    it('should process concurrent tasks one by one', async () => {
        await instance.initInstance();
        const collection = instance.mongodash.getCollection('loyaltyBenefitUsage');

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'loyaltyPartnerWebhookSender',
            // filter: { billStatus: 'pending', _id: { $gte: ObjectId.createFromTime(Date.now() / 1000 - 1000) } },
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({
            _id: 1,
            billStatus: 'pending',
            keepLoyaltyUsage: false,
        } as Document);

        await waitForNextCall(2000);
    }, 10000);

    it('should respect consumer filter', async () => {
        await instance.initInstance();
        const collection = instance.mongodash.getCollection('filteredTasks');

        const {
            stub: handler,
            waitForNextCall,
            expectNoCall,
        } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'filteredTask',
            filter: { $eq: ['$status', 'active'] },
            handler,
            debounce: 0,
        });
        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert document that DOES NOT match filter
            await collection.insertOne({ _id: 1, status: 'inactive', data: 'ignore me' } as Document);

            // Wait a bit to ensure no task is generated
            await expectNoCall(500);
            sinon.assert.notCalled(handler);

            // 2. Update document to MATCH filter
            await collection.updateOne({ _id: 1 } as Document, { $set: { status: 'active' } });

            // Should generate task
            const [context] = await waitForNextCall(2000);
            const doc = await context.getDocument();
            expect(doc.status).toBe('active');
            sinon.assert.calledOnce(handler);

            // 3. Update document to NOT MATCH filter again
            await collection.updateOne({ _id: 1 } as Document, { $set: { status: 'inactive' } });

            // Wait a bit to ensure no task is generated
            await expectNoCall(500);
            // Handler count should remain 1
            sinon.assert.calledOnce(handler);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should handle multiple tasks with different filters', async () => {
        await instance.initInstance();
        const collection = instance.mongodash.getCollection('multiTaskTasks');

        const { stub: handlerA, waitForNextCall: waitForNextCallA } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task A', JSON.stringify(doc, null, 2));
        });
        const { stub: handlerB, waitForNextCall: waitForNextCallB } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task B', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'taskA',
            filter: { $eq: ['$type', 'A'] },
            handler: handlerA,
            debounce: 0,
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'taskB',
            filter: { $eq: ['$type', 'B'] },
            handler: handlerB,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert doc for task A
            await collection.insertOne({ _id: 'docA', type: 'A', data: 'for A' } as Document);

            // Expect handlerA to be called, but not B
            const [contextA] = await waitForNextCallA(2000);
            const docA = await contextA.getDocument();
            expect(docA.type).toBe('A');
            sinon.assert.calledOnce(handlerA);
            sinon.assert.notCalled(handlerB);

            // 2. Insert doc for task B
            await collection.insertOne({ _id: 'docB', type: 'B', data: 'for B' } as Document);

            // Expect handlerB to be called, handlerA count remains 1
            const [contextB] = await waitForNextCallB(2001);
            const docB = await contextB.getDocument();
            expect(docB.type).toBe('B');
            sinon.assert.calledOnce(handlerB);
            sinon.assert.calledOnce(handlerA);

            // 3. Update doc for task A
            await collection.updateOne({ _id: 'docA' } as Document, { $set: { data: 'for A updated' } });

            // Expect handlerA to be called again
            const [contextA2] = await waitForNextCallA(2002);
            const docA2 = await contextA2.getDocument();
            expect(docA2.data).toBe('for A updated');
            sinon.assert.calledTwice(handlerA);
            sinon.assert.calledOnce(handlerB);

            // 4. Update doc for task B
            await collection.updateOne({ _id: 'docB' } as Document, { $set: { data: 'for B updated' } });

            // Expect handlerB to be called again
            const [contextB2] = await waitForNextCallB(2003);
            const docB2 = await contextB2.getDocument();
            expect(docB2.data).toBe('for B updated');
            sinon.assert.calledTwice(handlerB);
            sinon.assert.calledTwice(handlerA);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should debounce multiple updates', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('debounceTasks');

        const {
            stub: handler,
            waitForNextCall,
            expectNoCall,
        } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'debounceTask',
            handler,
            // debounce is set globally in initInstance, or we can override here if supported
            // But wait, debounce IS supported in reactiveTask options!
            // So we don't strictly need it in initInstance, but we need initInstance anyway.
            debounce: 500,
        });
        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Trigger multiple updates quickly
            await collection.insertOne({ _id: 'doc1', data: 'v1' } as Document);
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { data: 'v2' } });
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { data: 'v3' } });

            // 2. Wait for processing (should be only one call with latest data)
            const [context] = await waitForNextCall(2000);
            const doc = await context.getDocument();

            expect(doc.data).toBe('v3');
            sinon.assert.calledOnce(handler);

            // Ensure no more calls happen
            await expectNoCall(500);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should retry failed tasks', async () => {
        // Configure scheduler with fast retry
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('retryTasks');
        let attempts = 0;

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {
            attempts++;
            debug(`Processing task attempt ${attempts}`);
            if (attempts <= 2) {
                throw new Error('Temporary failure');
            }
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'retryTask',
            handler,
            debounce: 0,
            retryPolicy: { type: 'linear', interval: '100ms' },
        });

        await instance.mongodash.startReactiveTasks();

        try {
            await collection.insertOne({ _id: 'doc1' } as Document);

            // 1. First attempt (fails)
            await waitForNextCall(2000);

            // 2. Second attempt (fails)
            await waitForNextCall(2000);

            // 3. Third attempt (succeeds)
            await waitForNextCall(2000);

            expect(attempts).toBe(3);
            sinon.assert.calledThrice(handler);

            // Verify task status in DB
            // We need to wait a bit for the update to happen after handler returns
            await new Promise((resolve) => setTimeout(resolve, 500));

            // Access internal tasks collection to verify
            const tasksCollection = instance.mongodash.getCollection('retryTasks_tasks');
            const taskRecord = await tasksCollection.findOne({ sourceDocId: 'doc1' });
            if (!taskRecord) throw new Error('Task document not found');
            expect(taskRecord.status).toBe('completed');
            expect(taskRecord.attempts).toBe(3);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should move failed tasks to DLQ (failed status)', async () => {
        // Configure scheduler with maxAttempts = 3 and fast retry
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('dlqTasks');
        let attempts = 0;

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {
            attempts++;
            debug(`Processing DLQ task attempt ${attempts}`);
            throw new Error('Permanent failure');
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'dlqTask',
            handler,
            debounce: 0,
            retryPolicy: { type: 'fixed', interval: '50ms', maxAttempts: 3 },
        });

        await instance.mongodash.startReactiveTasks();

        try {
            await collection.insertOne({ _id: 'doc1' } as Document);

            // 1. First attempt
            await waitForNextCall(2000);
            // 2. Second attempt
            await waitForNextCall(2000);
            // 3. Third attempt
            await waitForNextCall(2000);

            expect(attempts).toBe(3);

            // Wait for final update
            await new Promise((resolve) => setTimeout(resolve, 500));

            const tasksCollection = instance.mongodash.getCollection('dlqTasks_tasks');
            const taskRecord = await tasksCollection.findOne({ sourceDocId: 'doc1' });
            if (!taskRecord) throw new Error('Task document not found');

            expect(taskRecord.status).toBe('failed');
            expect(taskRecord.attempts).toBe(3);
            expect(taskRecord.lastError).toBe('Permanent failure');
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should recover stuck tasks (visibility timeout)', async () => {
        // Manually handle initialization to preserve the mock across module resets
        jest.resetModules();
        const noop = () => {};

        // 1. Setup Mock for createContinuousLock
        jest.doMock('../../src/createContinuousLock', () => ({
            createContinuousLock: () => {
                // Return a no-op stop function.
                // Crucially, this does NOT schedule any lock prolongation.
                return async () => {};
            },
        }));

        // 2. Load dependencies manually (after mock)
        const mongodash = require('../../src');
        const { getConnectionString, cleanTestingDatabases } = require('../../tools/testingDatabase');
        const { createReusableWaitableStub } = require('../testHelpers');

        await cleanTestingDatabases();

        // 3. Configure scheduler with default settings (long visibility timeout)
        await mongodash.init({
            uri: getConnectionString(),
            onError: noop,
            onInfo: noop,
            reactiveTaskConcurrency: 5,
        });

        const collection = mongodash.getCollection('recoveryTasks');

        let attempts = 0;
        let releaseTask!: () => void;
        const taskBlockingPromise = new Promise<void>((resolve) => {
            releaseTask = resolve;
        });

        // Handler logic
        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {
            attempts++;
            if (attempts === 1) {
                // First run: The worker thinks it has a lock (default 5 mins)
                // But we want to simulate a "stuck" task where the lock is lost/expired.
                // We manually expire the lock in the DB *after* the task has started.

                // Wait a tiny bit to ensure the initial lock write by the worker has happened
                await new Promise((r) => setTimeout(r, 100));

                // Force expire the lock in the DB
                await mongodash
                    .getCollection('recoveryTasks_tasks')
                    .updateOne({ sourceDocId: _context.docId }, { $set: { lockExpiresAt: new Date(Date.now() - 1000) } } as any);

                // Now block indefinitely
                await taskBlockingPromise;
            }
            // Second run (recovery): finish successfully
        });

        // Register the task
        await mongodash.reactiveTask({
            collection,
            task: 'recoveryTask',
            handler,
            debounce: 0,
        });

        // 4. Start the system
        // This will pick up the task, run handler (attempt 1), and HANG.
        // Because lock is not prolonged, it will expire in 1000ms + margin.
        await mongodash.startReactiveTasks();

        // Insert a document to trigger the task
        await collection.insertOne({ _id: 'doc1', data: 'test' });

        // Wait for 1st attempt to start
        await waitForNextCall(5000);
        expect(attempts).toBeGreaterThanOrEqual(1);

        // 5. Wait for recovery
        // Wait significantly longer than visibilityTimeoutMs + max poll interval
        await new Promise((resolve) => setTimeout(resolve, 8000));

        // Wait for the 2nd attempt
        await waitForNextCall(5000);

        expect(attempts).toBeGreaterThanOrEqual(2);

        expect(attempts).toBeGreaterThanOrEqual(2);

        // Cleanup
        if (releaseTask) releaseTask(); // Unblock the first zombie run
        await mongodash.stopReactiveTasks();
        await mongodash.getMongoClient().close();

        // Restore mocks
        jest.dontMock('../../src/createContinuousLock');
    }, 20000);

    it('should handle leader election with multiple instances', async () => {
        // 1. Start first instance (Leader)
        await instance.initInstance({
            globalsCollection: '_mongodash_globals',
            onError: (err: any) => console.error('Leader Error:', err),
            onInfo: noop,
        } as any);

        // Explicitly clean globals to ensure no ghost locks
        const globals = instance.mongodash.getCollection('_mongodash_globals');
        await globals.deleteMany({});

        // Register dummy task to avoid empty pipeline error
        await instance.mongodash.reactiveTask({
            collection: instance.mongodash.getCollection('dummy_leader'),
            task: 'dummy_leader',
            handler: async (_context: any) => noop(),
        });

        await instance.mongodash.startReactiveTasks();

        // 2. Start second instance (Follower)
        const instance2 = getNewInstance();
        try {
            await instance2.initInstance(
                {
                    globalsCollection: '_mongodash_globals',
                    onError: noop,
                    onInfo: noop,
                } as any,
                true,
            ); // skipClean = true

            // Register dummy task to avoid empty pipeline error
            await instance2.mongodash.reactiveTask({
                collection: instance2.mongodash.getCollection('dummy'),
                task: 'dummy',
                handler: async (_context: any) => noop(),
            });

            await instance2.mongodash.startReactiveTasks();

            // Wait for election to settle
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // Verify that only one is leader (we can check logs or internal state if exposed,
            // but here we can check the lock document in DB)
            const globalsCollection = instance.mongodash.getCollection('_mongodash_globals');
            const metaDoc = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);

            if (!metaDoc) throw new Error('Meta document not found');
            expect(metaDoc.lock).toBeDefined();
            const leaderInstanceId = metaDoc.lock.instanceId;
            expect(leaderInstanceId).toBeDefined();

            // 3. Stop the leader (Assuming instance 1 is leader as it started first)
            await instance.mongodash.stopReactiveTasks();

            // At this point, the leader should have gracefully released the lock.
            // Instance 2 polls periodically (default interval might be 1000ms-5000ms?)
            // We verify eventually instance2 takes over.

            // Wait for instance2 to pick it up
            // We poll until we see a new leader
            let newLeaderInstanceId: string | undefined;
            for (let i = 0; i < 10; i++) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                const currentMeta = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
                if (currentMeta?.lock?.instanceId && currentMeta.lock.instanceId !== leaderInstanceId) {
                    newLeaderInstanceId = currentMeta.lock.instanceId;
                    break;
                }
            }

            if (!newLeaderInstanceId) {
                const finalMeta = await globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID } as any);
                console.error('Final meta doc:', JSON.stringify(finalMeta, null, 2));
                throw new Error('Timeout waiting for new leader election');
            }

            console.log('New Leader ID:', newLeaderInstanceId);
            expect(newLeaderInstanceId).toBeDefined();
            expect(newLeaderInstanceId).not.toBe(leaderInstanceId);
        } finally {
            // Cleanup instance2
            await instance2.cleanUpInstance();
        }
    }, 20000);

    it('should use reactiveTaskCaller to wrap task execution', async () => {
        const callerStub = sinon.stub().callsFake(async (task) => {
            debug('Caller wrapper started');
            await task();
            debug('Caller wrapper finished');
        });

        await instance.initInstance({
            onError: noop,
            onInfo: noop,
            reactiveTaskCaller: callerStub,
        });
        const collection = instance.mongodash.getCollection('callerTasks');

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'callerTask',
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            await collection.insertOne({ _id: 'doc1' } as Document);

            await waitForNextCall(2000);

            sinon.assert.calledOnce(handler);
            sinon.assert.calledOnce(callerStub);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should use generic taskCaller as default for reactive tasks', async () => {
        const callerStub = sinon.stub().callsFake(async (task) => {
            debug('Generic caller wrapper started');
            await task();
            debug('Generic caller wrapper finished');
        });

        // Initialize with generic taskCaller
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
            taskCaller: callerStub,
        } as any); // cast to any because taskCaller is new in InitOptions
        const collection = instance.mongodash.getCollection('genericCallerTasks');

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'genericCallerTask',
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            await collection.insertOne({ _id: 'doc1' } as Document);

            await waitForNextCall(2000);

            sinon.assert.calledOnce(handler);
            sinon.assert.calledOnce(callerStub);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should log task events (started, finished, failed)', async () => {
        const onInfoStub = sinon.stub();
        const onErrorStub = sinon.stub();

        await instance.initInstance({
            onError: onErrorStub,
            onInfo: onInfoStub,
        });
        const collection = instance.mongodash.getCollection('loggingTasks');

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            if (doc.shouldFail) {
                throw new Error('Task failed intentionally');
            }
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'loggingTask',
            handler,
            debounce: 0,
            retryPolicy: { type: 'linear', interval: '100ms' },
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Successful task
            await collection.insertOne({ _id: 'successDoc' } as Document);
            await waitForNextCall(2000);
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Check logs for success
            // onInfo should be called with started and finished
            const startedCalls = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_STARTED);
            const finishedCalls = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_FINISHED);

            expect(startedCalls.length).toBeGreaterThanOrEqual(1);
            expect(finishedCalls.length).toBeGreaterThanOrEqual(1);

            expect(startedCalls[0].args[0].taskId).toBeDefined();
            expect(finishedCalls[0].args[0].taskId).toBeDefined();
            expect(finishedCalls[0].args[0].duration).toBeDefined();

            // 2. Failed task
            onInfoStub.resetHistory();
            await collection.insertOne({ _id: 'failDoc', shouldFail: true } as Document);

            // Wait for handler to be called (it throws)
            await waitForNextCall(2000);

            // Wait a bit for logging to happen in catch block
            await new Promise((resolve) => setTimeout(resolve, 100));

            const startedCallsFail = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_STARTED);
            const failedCalls = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_FAILED);

            expect(startedCallsFail.length).toBeGreaterThanOrEqual(1);
            expect(failedCalls.length).toBeGreaterThanOrEqual(1);

            expect(failedCalls[0].args[0].taskId).toBeDefined();
            expect(failedCalls[0].args[0].reason).toBe('Task failed intentionally');
            expect(failedCalls[0].args[0].duration).toBeDefined();
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should log planner events (started, reconciliation)', async () => {
        const onInfoStub = sinon.stub();
        const onErrorStub = sinon.stub();

        await instance.initInstance({
            onError: onErrorStub,
            onInfo: onInfoStub,
        });
        const collection = instance.mongodash.getCollection('loggingPlannerTasks');

        // Explicitly clean globals to ensure no ghost locks and force reconciliation
        const globals = instance.mongodash.getCollection('_mongodash_globals');
        await globals.deleteMany({});

        const { stub: handler } = createReusableWaitableStub(async () => noop());

        await instance.mongodash.reactiveTask({
            collection,
            task: 'loggingPlannerTask',
            handler,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // Check logs for planner start and reconciliation
            const startedCalls = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_PLANNER_STARTED);
            const reconciliationStartedCalls = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED);
            const reconciliationFinishedCalls = onInfoStub
                .getCalls()
                .filter((call) => call.args[0].code === CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED);

            expect(startedCalls.length).toBeGreaterThanOrEqual(1);
            expect(reconciliationStartedCalls.length).toBeGreaterThanOrEqual(1);
            expect(reconciliationFinishedCalls.length).toBeGreaterThanOrEqual(1);

            expect(reconciliationStartedCalls[0].args[0].taskCount).toBeDefined();
            expect(reconciliationStartedCalls[0].args[0].taskCount).toBeDefined();
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);
});
