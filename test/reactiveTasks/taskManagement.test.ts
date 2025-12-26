import { ObjectId } from 'mongodb';
import { setTimeout } from 'timers/promises';
import { getNewInstance } from '../testHelpers';

describe('Reactive Task Management', function () {
    let instance: ReturnType<typeof getNewInstance>;
    let API: typeof instance.mongodash;

    const taskName = 'dlq-test-task';
    const sourceCollectionName = 'dlq_source_items';
    const tasksCollectionName = 'dlq_source_items_tasks';

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
        API = instance.mongodash;

        const db = API.getMongoClient().db();
        try {
            await db.createCollection(sourceCollectionName);
        } catch {
            /* ignore */
        }
        try {
            await db.createCollection(tasksCollectionName);
        } catch {
            /* ignore */
        }

        await API.reactiveTask({
            task: taskName,
            collection: sourceCollectionName,
            handler: async (context: any) => {
                const doc = await context.getDocument();
                if (doc.shouldFail) {
                    throw new Error('Intentional failure');
                }
            },
            retryPolicy: {
                maxAttempts: 1,
                type: 'fixed',
                interval: '1s',
            },
            debounce: 0,
        });

        await API.startReactiveTasks();
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    describe('A. Standard Lifecycle (DLQ)', () => {
        it('should list failed tasks', async () => {
            const db = API.getMongoClient().db();
            await db.collection(sourceCollectionName).insertOne({ shouldFail: true });

            let failed = false;
            for (let i = 0; i < 40; i++) {
                const tasks = await API.getReactiveTasks({ task: taskName, status: 'failed' });
                if (tasks.items.length > 0) {
                    failed = true;
                    break;
                }
                await setTimeout(100);
            }
            expect(failed).toBe(true);

            const count = await API.countReactiveTasks({ task: taskName, status: 'failed' });
            expect(count).toBe(1);
        });

        it('should manually retry failed tasks', async () => {
            const db = API.getMongoClient().db();
            const { insertedId } = await db.collection(sourceCollectionName).insertOne({ shouldFail: true });

            for (let i = 0; i < 40; i++) {
                const tasks = await API.getReactiveTasks({ task: taskName, status: 'failed' });
                if (tasks.items.length > 0) break;
                await setTimeout(100);
            }

            const res = await API.retryReactiveTasks({ task: taskName, status: 'failed' });
            expect(res.modifiedCount).toBe(1);

            const tasks = await API.getReactiveTasks({ task: taskName, sourceDocFilter: { _id: insertedId } });
            expect(tasks.items[0].status).toBe('pending');
            expect(tasks.items[0].attempts).toBeGreaterThan(0);
            expect(tasks.items[0].lastError).not.toBeNull();
        });
    });

    describe('B. Concurrency & Safety', () => {
        it('should mark processing task as processing_dirty when retried', async () => {
            const db = API.getMongoClient().db();
            const sourceDocId = (await db.collection(sourceCollectionName).insertOne({})).insertedId;

            await db.collection(tasksCollectionName).insertOne({
                task: taskName,
                sourceDocId,
                status: 'processing',
                attempts: 1,
                scheduledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                lockExpiresAt: new Date(Date.now() + 60000),
            } as any);

            const res = await API.retryReactiveTasks({ task: taskName, sourceDocFilter: { _id: sourceDocId } });
            expect(res.modifiedCount).toBe(1);

            const updatedTask = (await db.collection(tasksCollectionName).findOne({ sourceDocId })) as any;
            expect(updatedTask.status).toBe('processing_dirty');
            expect(updatedTask.attempts).toBe(1);
        });

        it('should preserve initialScheduledAt on retry', async () => {
            const db = API.getMongoClient().db();
            const sourceDocId = (await db.collection(sourceCollectionName).insertOne({})).insertedId;
            const pastDate = new Date(Date.now() - 10000);

            await db.collection(tasksCollectionName).insertOne({
                task: taskName,
                sourceDocId,
                status: 'failed',
                attempts: 5,
                scheduledAt: pastDate,
                initialScheduledAt: null,
                createdAt: pastDate,
                updatedAt: new Date(),
            } as any);

            await API.retryReactiveTasks({ task: taskName, sourceDocFilter: { _id: sourceDocId } });

            const task = (await db.collection(tasksCollectionName).findOne({ sourceDocId })) as any;
            expect(task.status).toBe('pending');
            expect(new Date(task.initialScheduledAt).getTime()).toEqual(pastDate.getTime());
            expect(task.scheduledAt.getTime()).toBeGreaterThan(pastDate.getTime());
        });
    });

    describe('C. Scalability & Batching', () => {
        it('should retry tasks using sourceDocFilter with batching', async () => {
            const db = API.getMongoClient().db();
            await API.stopReactiveTasks();

            const items = Array.from({ length: 1500 }).map((_, i) => ({ category: 'bulk', idx: i }));
            const insertRes = await db.collection(sourceCollectionName).insertMany(items);
            const insertedIds = Object.values(insertRes.insertedIds);

            const tasks = insertedIds.map((id) => ({
                task: taskName,
                sourceDocId: id,
                status: 'failed',
                attempts: 5,
                scheduledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
            }));
            await db.collection(tasksCollectionName).insertMany(tasks as any);

            const countFailed = await API.countReactiveTasks({ task: taskName, status: 'failed' });
            expect(countFailed).toBe(1500);

            const res = await API.retryReactiveTasks({
                task: taskName,
                sourceDocFilter: { category: 'bulk' },
            });

            expect(res.modifiedCount).toBe(1500);

            const countPending = await API.countReactiveTasks({ task: taskName, status: 'pending' });
            expect(countPending).toBe(1500);
        });
    });

    describe('D. Edge Cases', () => {
        it('should handle empty result set', async () => {
            const res = await API.retryReactiveTasks({ task: taskName, status: 'processing' });
            expect(res.modifiedCount).toBe(0);
        });

        it('should throw if task name is invalid', async () => {
            try {
                await API.retryReactiveTasks({ task: 'non-existent-task' });
                throw new Error('Should have thrown');
            } catch (e: any) {
                expect(e.message).toContain('not found');
            }
        });

        it('should retry ALL tasks if no filter provided', async () => {
            const db = API.getMongoClient().db();
            await db.collection(tasksCollectionName).insertOne({
                task: taskName,
                sourceDocId: 'custom-id',
                status: 'completed',
                attempts: 1,
                scheduledAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
            } as any);

            const res = await API.retryReactiveTasks({ task: taskName });
            expect(res.modifiedCount).toBe(1);

            const task = await db.collection(tasksCollectionName).findOne({ sourceDocId: 'custom-id' });
            expect(task).not.toBeNull();
            expect(task!.status).toBe('pending');
        });
    });

    describe('E. Multi-Collection Sorting', () => {
        const task2Name = 'sorted-task-2';
        const source2Name = 'sorted_source_2';

        beforeEach(async () => {
            const db = API.getMongoClient().db();
            try {
                await db.createCollection(source2Name);
            } catch {
                /* ignore */
            }

            await API.stopReactiveTasks();
            await API.reactiveTask({
                task: task2Name,
                collection: source2Name,
                handler: async () => {},
            });
        });

        it('should sort tasks across multiple collections', async () => {
            const db = API.getMongoClient().db();

            await db.collection(tasksCollectionName).insertOne({
                task: taskName,
                sourceDocId: 't1-1',
                scheduledAt: new Date('2024-01-01T10:00:00Z'),
                status: 'pending',
            } as any);

            await db.collection(source2Name + '_tasks').insertOne({
                task: task2Name,
                sourceDocId: 't2-1',
                scheduledAt: new Date('2024-01-01T09:00:00Z'), // Earlier
                status: 'pending',
            } as any);

            await db.collection(tasksCollectionName).insertOne({
                task: taskName,
                sourceDocId: 't1-2',
                scheduledAt: new Date('2024-01-01T11:00:00Z'), // Later
                status: 'pending',
            } as any);

            const res = await API.getReactiveTasks({ status: 'pending' }, { sort: { field: 'scheduledAt', direction: 1 } });

            expect(res.items).toHaveLength(3);
            expect(res.items[0].sourceDocId).toBe('t2-1');
            expect(res.items[1].sourceDocId).toBe('t1-1');
            expect(res.items[2].sourceDocId).toBe('t1-2');
        });
    });

    describe('F. Advanced Filtering & Stats (Consolidated API Tests)', () => {
        // We use OperationalTaskController directly to test API logic that isn't exposed by standard API.* methods
        // (because standard API methods use the lower-level ReactiveTaskManager directly, skipping Controller logic)
        let controller: any;

        beforeEach(() => {
            const scheduler = (API as any)._scheduler;
            const { OperationalTaskController } = API;
            controller = new OperationalTaskController(scheduler);
        });

        it('should filter by multiple statuses (Array)', async () => {
            const db = API.getMongoClient().db();
            await db.collection(tasksCollectionName).insertMany([
                { task: taskName, sourceDocId: new ObjectId(), status: 'failed' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'pending' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'processing' },
            ] as any);

            const res = await controller.getReactiveTasks({ task: taskName, status: 'failed, pending' });
            expect(res.items).toHaveLength(2);
            expect(res.items.map((i: any) => i.status).sort()).toEqual(['failed', 'pending']);
        });

        it('should filter by error message (Regex & String)', async () => {
            const db = API.getMongoClient().db();
            await db.collection(tasksCollectionName).insertMany([
                { task: taskName, sourceDocId: new ObjectId(), status: 'failed', lastError: 'Timeout error' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'failed', lastError: 'Connection refused' },
            ] as any);

            const res1 = await controller.getReactiveTasks({ task: taskName, errorMessage: 'Time' });
            expect(res1.items).toHaveLength(1);
            expect(res1.items[0].lastError).toBe('Timeout error');
        });

        it('should filter by hasError', async () => {
            const db = API.getMongoClient().db();
            await db.collection(tasksCollectionName).insertMany([
                { task: taskName, sourceDocId: new ObjectId(), status: 'failed', lastError: 'Err' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'completed' },
            ] as any);

            const res = await controller.getReactiveTasks({ task: taskName, hasError: 'true' });
            expect(res.items).toHaveLength(1);
            expect(res.items[0].lastError).toBeDefined();

            const res2 = await controller.getReactiveTasks({ task: taskName, hasError: 'false' });
            expect(res2.items).toHaveLength(1);
            expect(res2.items[0].status).toBe('completed');
        });

        it('should list tasks using different ID formats', async () => {
            const db = API.getMongoClient().db();
            const id1 = new ObjectId();

            await db.collection(tasksCollectionName).insertMany([
                { task: taskName, sourceDocId: id1, status: 'pending' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'pending' },
            ] as any);

            // Test string ID filtering for sourceDocId
            const res1 = await controller.getReactiveTasks({ task: taskName, sourceDocId: id1.toHexString() });
            expect(res1.items).toHaveLength(1);
        });

        it('should filter by collection name', async () => {
            const db = API.getMongoClient().db();
            const otherColl = 'other_collection';
            try {
                await db.createCollection(otherColl);
            } catch {}

            await API.stopReactiveTasks();
            await API.reactiveTask({
                task: 'other-task',
                collection: otherColl,
                handler: async () => {},
            });
            await API.startReactiveTasks();

            // Insert data for main task
            await db.collection(tasksCollectionName).insertOne({
                task: taskName,
                sourceDocId: new ObjectId(),
                status: 'pending',
            } as any);

            // Insert data for other task
            await db.collection(otherColl + '_tasks').insertOne({
                task: 'other-task',
                sourceDocId: new ObjectId(),
                status: 'pending',
            } as any);

            const res1 = await controller.getReactiveTasks({ collection: sourceCollectionName });
            expect(res1.items.length).toBeGreaterThan(0);
            const tasks1 = res1.items.map((t: any) => t.task);
            expect(tasks1).toContain(taskName);
            expect(tasks1).not.toContain('other-task');

            const res2 = await controller.getReactiveTasks({ collection: otherColl });
            expect(res2.items.length).toBeGreaterThan(0);
            const tasks2 = res2.items.map((t: any) => t.task);
            expect(tasks2).toContain('other-task');
            expect(tasks2).not.toContain(taskName);
        });

        it('should get aggregated info stats', async () => {
            const db = API.getMongoClient().db();
            await db.collection(tasksCollectionName).insertMany([
                { task: taskName, sourceDocId: new ObjectId(), status: 'failed', lastError: 'Err' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'failed', lastError: 'Err2' },
                { task: taskName, sourceDocId: new ObjectId(), status: 'completed' },
            ] as any);

            const info = await controller.getInfo();
            const taskStats = info.reactiveTasks.find((t: any) => t.name === taskName);
            expect(taskStats).toBeDefined();
            expect(taskStats!.stats.failed).toBe(2);
            expect(taskStats!.stats.success).toBe(1);
            expect(taskStats!.stats.error).toBe(2);
        });

        it('should throw on complex sourceDocFilter for getTasks', async () => {
            try {
                // Testing API behavior (Manager) directly for this exception
                await API.getReactiveTasks({ task: taskName, sourceDocFilter: { someField: 'val' } });
                throw new Error('Should have thrown');
            } catch (e: any) {
                expect(e.message).toContain('not support complex');
            }
        });
    });
});
