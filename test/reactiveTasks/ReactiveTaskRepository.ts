import { noop } from 'lodash';
import { Collection, Document, ObjectId } from 'mongodb';
import { createSandbox } from 'sinon';
import { ReactiveTaskRepository } from '../../src/reactiveTasks/ReactiveTaskRepository';
import { ReactiveTaskRetryStrategy } from '../../src/reactiveTasks/ReactiveTaskRetryStrategy';
import { ReactiveTaskInternal, ReactiveTaskRecord } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { getNewInstance } from '../testHelpers';

describe('ReactiveTaskRepository', () => {
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
        tasksCollection = instance.mongodash.getCollection('repository_tasks');
        sourceCollection = instance.mongodash.getCollection('repository_source');
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
            task: 'test-task',
            sourceCollection: sourceCollection,
            tasksCollection: tasksCollection,
            initPromise: Promise.resolve(),
            debounce: 100,
            debounceMs: 100,
            retryStrategy: new ReactiveTaskRetryStrategy({ type: 'fixed', interval: '1s' }),
            executionHistoryLimit: 5,
            handler: async () => {
                // noop
            },
            cleanupPolicyParsed: {
                deleteWhen: 'sourceDocumentDeleted',
                keepForMs: 86400000, // 24h
            },
            repository: repository,
            ...overrides,
        };
    }

    describe('findAndLockNextTask', () => {
        it('should lock tasks exclusively among concurrent workers', async () => {
            const taskDef = createTaskDef();
            const docs = Array.from({ length: 10 }, () => ({ _id: new ObjectId() }));

            // Create 10 tasks directly
            const tasks = docs.map((doc) => ({
                _id: new ObjectId(),
                task: taskDef.task,
                sourceDocId: doc._id,
                status: 'pending',
                attempts: 0,
                scheduledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                lastObservedValues: null,
                lastError: null,
                lockExpiresAt: null,
            }));
            await tasksCollection.insertMany(tasks as any);

            // Verify created
            expect(await tasksCollection.countDocuments()).toBe(10);

            // Wait for debounce (scheduledAt) - not needed as we set scheduledAt to now
            // await new Promise((resolve) => setTimeout(resolve, 150));

            // Simulate 5 concurrent workers trying to lock tasks
            const workers = Array.from({ length: 5 }, () => repository.findAndLockNextTask([taskDef], { visibilityTimeoutMs: 5000 }));

            const lockedTasks = await Promise.all(workers);
            const validTasks = lockedTasks.filter((t: unknown) => t !== null);

            // Should have locked 5 distinct tasks
            expect(validTasks).toHaveLength(5);
            const ids = validTasks.map((t: any) => t._id.toString());
            const uniqueIds = new Set(ids);
            expect(uniqueIds.size).toBe(5);

            // Verify DB state
            const processingCount = await tasksCollection.countDocuments({ status: 'processing' });
            expect(processingCount).toBe(5);
        });
    });

    describe('finalizeTask', () => {
        it('should handle "dirty" state correctly (concurrency between processing and new update)', async () => {
            const doc = { _id: new ObjectId(), value: 1 };
            const taskDef = createTaskDef();

            // 1. Create task
            const taskId = new ObjectId();
            await tasksCollection.insertOne({
                _id: taskId,
                task: taskDef.task,
                sourceDocId: doc._id,
                status: 'pending',
                attempts: 0,
                scheduledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                lastObservedValues: null,
                lastError: null,
                lockExpiresAt: null,
            } as any);

            // 2. Lock task (processing)
            const taskRecord = await repository.findAndLockNextTask([taskDef], { visibilityTimeoutMs: 5000 });
            expect(taskRecord).not.toBeNull();
            expect(taskRecord!.status).toBe('processing');

            // 3. Simulate new update arriving while processing (marks as processing_dirty)
            // We simulate what the aggregation pipeline would do: update status to processing_dirty
            await tasksCollection.updateOne({ _id: taskId }, { $set: { status: 'processing_dirty', updatedAt: new Date() } });

            const dirtyTask = await tasksCollection.findOne({ _id: taskId });
            expect(dirtyTask!.status).toBe('processing_dirty');

            // 4. Finalize task (worker finished)
            await repository.finalizeTask(taskRecord!, new ReactiveTaskRetryStrategy({ type: 'fixed', interval: '1s', maxAttempts: 5 }), undefined, 100);

            // 5. Should be reset to pending, NOT completed
            const finalTask = await tasksCollection.findOne({ _id: taskId });
            expect(finalTask!.status).toBe('pending');
            // Attempts should be reset because it's a "new" task effectively?
            // finalizeTask does NOT reset attempts if processing_dirty, it keeps them?
            // Wait, finalizeTask implementation:
            // if processing_dirty -> pending.
            // attempts: not touched in the $cond for processing_dirty?
            // Let's check finalizeTask implementation.
            // It sets status, scheduledAt, completedAt, lockExpiresAt, lastError.
            // It does NOT set attempts in the update.
            // So attempts remain as they were (which was incremented by findAndLockNextTask).
            // So it should be 1.
            expect(finalTask!.attempts).toBe(1);
        });

        it('should reschedule task immediately if updated while processing', async () => {
            const doc = { _id: new ObjectId(), value: 1 };
            const taskDef = createTaskDef();

            // 1. Create task
            const taskId = new ObjectId();
            await tasksCollection.insertOne({
                _id: taskId,
                task: taskDef.task,
                sourceDocId: doc._id,
                status: 'pending',
                attempts: 0,
                scheduledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                lastObservedValues: null,
                lastError: null,
                lockExpiresAt: null,
            } as any);

            // 2. Lock task
            const taskRecord = await repository.findAndLockNextTask([taskDef], { visibilityTimeoutMs: 5000 });
            expect(taskRecord).not.toBeNull();

            // 3. Simulate update while processing
            await tasksCollection.updateOne({ _id: taskId }, { $set: { status: 'processing_dirty', updatedAt: new Date() } });

            // 4. Finalize
            await repository.finalizeTask(taskRecord!, new ReactiveTaskRetryStrategy({ type: 'fixed', interval: '1s', maxAttempts: 5 }), undefined, 100);

            // 5. Verify it is pending and scheduledAt is roughly NOW + debounce (not delayed by backoff)
            const finalTask = await tasksCollection.findOne({ _id: taskId });
            expect(finalTask!.status).toBe('pending');

            const now = Date.now();
            const scheduledAt = finalTask!.scheduledAt.getTime();
            // scheduledAt should be updatedAt + debounce
            // updatedAt was set in step 3 (roughly now).
            // debounce is 100.
            // So scheduledAt should be roughly now + 100.
            expect(Math.abs(now + 100 - scheduledAt)).toBeLessThan(1000);

            // 6. Should be lockable again (after debounce)
            // We need to wait for debounce
            await new Promise((resolve) => setTimeout(resolve, 150));

            const nextTask = await repository.findAndLockNextTask([taskDef], { visibilityTimeoutMs: 5000 });
            expect(nextTask).not.toBeNull();
            expect(nextTask!._id.toString()).toBe(taskId.toString());
        });
    });
});
