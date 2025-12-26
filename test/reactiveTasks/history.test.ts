import { noop } from 'lodash';
import { Collection, Document, ObjectId } from 'mongodb';
import { createSandbox } from 'sinon';
import { ReactiveTaskRepository } from '../../src/reactiveTasks/ReactiveTaskRepository';
import { ReactiveTaskRetryStrategy } from '../../src/reactiveTasks/ReactiveTaskRetryStrategy';
import { ReactiveTaskInternal, ReactiveTaskRecord } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { getNewInstance } from '../testHelpers';

describe('ReactiveTask History', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let repository: ReactiveTaskRepository<any>;
    let tasksCollection: Collection<ReactiveTaskRecord<any>>;
    let sourceCollection: Collection<Document>;

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        tasksCollection = instance.mongodash.getCollection('history_tasks');
        sourceCollection = instance.mongodash.getCollection('history_source');
        repository = new ReactiveTaskRepository(tasksCollection);
        await repository.initPromise;
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    function createTaskDef(overrides: Partial<ReactiveTaskInternal<Document>> = {}): ReactiveTaskInternal<Document> {
        return {
            task: 'history-task',
            sourceCollection: sourceCollection,
            tasksCollection: tasksCollection,
            initPromise: Promise.resolve(),
            debounce: 100,
            retryStrategy: new ReactiveTaskRetryStrategy({ type: 'fixed', interval: '100ms', maxAttempts: 5 }),
            handler: async (_context: any) => {
                // noop
            },
            ...overrides,
        } as any;
    }

    it('should track lastSuccess and executionHistory', async () => {
        const doc = { _id: new ObjectId(), value: 1 };
        const taskDef = createTaskDef();
        const taskId = new ObjectId();

        await tasksCollection.insertOne({
            _id: taskId,
            task: taskDef.task,
            sourceDocId: doc._id,
            status: 'processing', // simulating it was locked
            attempts: 1,
            scheduledAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            lastObservedValues: null,
            lastError: null,
            lockExpiresAt: new Date(Date.now() + 5000),
        } as any);

        const taskRecord = (await tasksCollection.findOne({ _id: taskId }))!;

        // 1. Successful execution
        await repository.finalizeTask(taskRecord, taskDef.retryStrategy, undefined, 100, { durationMs: 50 });

        let updatedTask = (await tasksCollection.findOne({ _id: taskId }))!;
        expect(updatedTask.status).toBe('completed');
        expect(updatedTask.lastSuccess).toBeDefined();
        expect(updatedTask.lastSuccess?.durationMs).toBe(50);
        expect(updatedTask.executionHistory).toHaveLength(1);
        expect(updatedTask.executionHistory![0].status).toBe('completed');
        expect(updatedTask.executionHistory![0].durationMs).toBe(50);

        // 2. Failed execution
        // Simulate re-locking (update status back to processing)
        await tasksCollection.updateOne({ _id: taskId }, { $set: { status: 'processing' } });
        updatedTask = (await tasksCollection.findOne({ _id: taskId }))!;

        const error = new Error('Test failure');
        await repository.finalizeTask(updatedTask, taskDef.retryStrategy, error, 100, { durationMs: 20 });

        updatedTask = (await tasksCollection.findOne({ _id: taskId }))!;
        // Should preserve lastSuccess
        expect(updatedTask.lastSuccess).toBeDefined();
        expect(updatedTask.lastSuccess?.durationMs).toBe(50); // From previous success

        // Should append to history
        expect(updatedTask.executionHistory).toHaveLength(2);
        expect(updatedTask.executionHistory![1].status).toBe('failed');
        expect(updatedTask.executionHistory![1].error).toBe('Test failure');
        expect(updatedTask.executionHistory![1].durationMs).toBe(20);
    });

    it('should cap executionHistory at 5 items (default)', async () => {
        const doc = { _id: new ObjectId(), value: 1 };
        const taskDef = createTaskDef();
        const taskId = new ObjectId();

        await tasksCollection.insertOne({
            _id: taskId,
            task: taskDef.task,
            sourceDocId: doc._id,
            status: 'processing',
            attempts: 1,
            scheduledAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            lastObservedValues: null,
            lastError: null,
            lockExpiresAt: new Date(Date.now() + 5000),
        } as any);

        let taskRecord = (await tasksCollection.findOne({ _id: taskId }))!;

        // Add 10 executions
        for (let i = 0; i < 10; i++) {
            // Simulate re-locking if needed (though finalizeTask works on _id regardless of status in DB,
            // conceptually we are processing)
            await repository.finalizeTask(
                taskRecord,
                taskDef.retryStrategy,
                undefined,
                100,
                { durationMs: i },
                5, // explicitly pass default 5 as repository logic doesn't know about taskDef defaults here
                // Wait, here in test we are calling repository manually.
                // If we omit argument, it uses default from repository signature which I changed to 5.
            );
            // Re-fetch to get latest state for next call?
            // Actually finalizeTask uses the ID, so we don't strictly need to refetch taskRecord
            // UNLESS finalizeTask relies on properties of taskRecord that changed?
            // implementation:
            // let firstErrorAt = taskRecord.firstErrorAt;
            // It READS from the passed record.
            // If we don't update key fields like firstErrorAt (which we don't for success), it might be okay.
            // But for correctness let's refetch or update the in-mem object.
            taskRecord = (await tasksCollection.findOne({ _id: taskId }))!;
        }

        const updatedTask = (await tasksCollection.findOne({ _id: taskId }))!;
        expect(updatedTask.executionHistory).toHaveLength(5);
        // Last one should be i=9 (durationMs = 9)
        expect(updatedTask.executionHistory![4].durationMs).toBe(9);
        // First one should be i=5 (durationMs = 5) because 0-4 were sliced off
        expect(updatedTask.executionHistory![0].durationMs).toBe(5);
    });

    it('should respect custom executionHistoryLimit', async () => {
        const doc = { _id: new ObjectId(), value: 1 };
        const taskDef = createTaskDef({ executionHistoryLimit: 3 });
        const taskId = new ObjectId();

        await tasksCollection.insertOne({
            _id: taskId,
            task: taskDef.task,
            sourceDocId: doc._id,
            status: 'processing',
            attempts: 1,
            scheduledAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            lastObservedValues: null,
            lastError: null,
            lockExpiresAt: new Date(Date.now() + 5000),
        } as any);

        let taskRecord = (await tasksCollection.findOne({ _id: taskId }))!;

        // Add 10 executions
        for (let i = 0; i < 10; i++) {
            await repository.finalizeTask(
                taskRecord,
                taskDef.retryStrategy,
                undefined,
                100,
                { durationMs: i },
                3, // pass custom limit explicitly
            );
            taskRecord = (await tasksCollection.findOne({ _id: taskId }))!;
        }

        const updatedTask = (await tasksCollection.findOne({ _id: taskId }))!;
        expect(updatedTask.executionHistory).toHaveLength(3);
        // Last one i=9
        expect(updatedTask.executionHistory![2].durationMs).toBe(9);
        // First one i=7
        expect(updatedTask.executionHistory![0].durationMs).toBe(7);
    });
});
