import _debug from 'debug';
import { Document, MongoError } from 'mongodb';
import { createSandbox } from 'sinon';
import { CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { createReusableWaitableStub, getNewInstance, wait } from '../testHelpers';

const debug = _debug('mongodash:reactiveTasks:resiliency');

describe('Reactive Tasks - Resiliency Test', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should recover from Change Stream error by restarting planner', async () => {
        const onInfoStub = sandbox.stub();
        await instance.initInstance({
            onError: (err) => console.error('Resiliency Test Error:', err),
            onInfo: onInfoStub,
        });

        const collection = instance.mongodash.getCollection('resiliencyTasks');
        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processed:', doc._id);
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'resiliencyTask',
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        // 1. Verify normal operation
        await collection.insertOne({ _id: 'doc1', status: 'A' } as Document);
        await waitForNextCall(2000);

        // 2. Simulate Change Stream Error
        // We need to access the dirty internals to mock the stream or trigger error
        // The Planner holds the stream.
        const scheduler = (instance.mongodash as any)._scheduler;
        const planner = scheduler.taskPlanner;

        expect(planner).toBeDefined();

        debug('Simulating Stream Error...');
        // Emitting 'error' on the change stream
        // planner.changeStream is private, but we can access it via cast on ANY or if exposed
        // Or we can mock the `onStreamError` callback?
        // No, we want to see if the callback is triggered AND system recovers.

        // Let's access the stream via `any`
        const stream = (planner as any).changeStream;
        if (!stream) throw new Error('Change stream not found on planner');

        // Emit error
        stream.emit('error', new MongoError('Simulated Stream Failure'));

        // 3. Verify Error Handling
        // The `onStreamError` callback should be called.
        // It should log CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR
        await wait(500);

        const errorLogs = onInfoStub.getCalls().filter((call) => call.args[0].code === CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR);
        expect(errorLogs.length).toBeGreaterThanOrEqual(1);

        // 4. Verify Recovery
        // The error handler in `ReactiveTaskScheduler` calls `leaderElector.forceLoseLeader()`.
        // This should cause:
        // a) Lose leader (stop planner, release lock)
        // b) Wait for next election cycle
        // c) Re-acquire leader (start planner, recreate stream)

        // Wait for re-election (minPollMs=200 + lockHeartbeatMs=10s might be too slow for test?)
        // The internal options has lockTtlMs=30s.
        // When forceLoseLeader is called, it should happen relatively fast.

        debug('Waiting for recovery...');
        // We can check if we can process another task.

        await collection.insertOne({ _id: 'doc2', status: 'B' } as Document);

        // This might take a few seconds for election to cycle
        await waitForNextCall(10000);

        // doc2 processed means we have a working leader and stream again!
    }, 20000);
});
