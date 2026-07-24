import { ObjectId } from 'mongodb';
import { getNewInstance } from '../testHelpers';

// Exercises ReactiveTaskManager query building (getReactiveTasks / countReactiveTasks)
// across filter shapes. Records are seeded directly so the assertions are
// deterministic and do not depend on the change stream / workers.
describe('reactive task querying', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let API: typeof instance.mongodash;

    const taskName = 'query-test-task';
    const sourceCollectionName = 'query_source_items';
    const tasksCollectionName = 'query_source_items_tasks';

    const completedId = new ObjectId();
    const pendingId = new ObjectId();
    const failedId = new ObjectId();
    const srcCompleted = new ObjectId();
    const srcFailed = new ObjectId();

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
        API = instance.mongodash;

        await API.reactiveTask({
            task: taskName,
            collection: sourceCollectionName,
            handler: async () => undefined,
        });

        const now = new Date();
        await API.getCollection(tasksCollectionName).insertMany([
            // Completed task: lastError present but null (the #24 regression case)
            {
                _id: completedId,
                task: taskName,
                sourceDocId: srcCompleted,
                status: 'completed',
                attempts: 1,
                nextRunAt: null,
                dueAt: now,
                createdAt: now,
                updatedAt: now,
                lastError: null,
            },
            // Pending task: no lastError field at all
            {
                _id: pendingId,
                task: taskName,
                sourceDocId: new ObjectId(),
                status: 'pending',
                attempts: 0,
                nextRunAt: now,
                dueAt: now,
                createdAt: now,
                updatedAt: now,
            },
            // Failed task: non-null lastError
            {
                _id: failedId,
                task: taskName,
                sourceDocId: srcFailed,
                status: 'failed',
                attempts: 3,
                nextRunAt: null,
                dueAt: now,
                createdAt: now,
                updatedAt: now,
                lastError: 'Intentional failure',
            },
        ] as never);
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('hasError:false returns completed (lastError:null) and pending tasks, not failed', async () => {
        const res = await API.getReactiveTasks({ task: taskName, hasError: false });
        const ids = res.items.map((i) => String(i._id)).sort();
        expect(ids).toEqual([String(completedId), String(pendingId)].sort());
        expect(await API.countReactiveTasks({ task: taskName, hasError: false })).toBe(2);
    });

    it('hasError:true returns only tasks with a non-null lastError', async () => {
        const res = await API.getReactiveTasks({ task: taskName, hasError: true });
        expect(res.items.map((i) => String(i._id))).toEqual([String(failedId)]);
        expect(await API.countReactiveTasks({ task: taskName, hasError: true })).toBe(1);
    });

    it('supports array status, and errorMessage as string or RegExp', async () => {
        const byStatus = await API.getReactiveTasks({ task: taskName, status: ['failed', 'completed'] });
        expect(byStatus.total).toBe(2);

        const byStringMsg = await API.getReactiveTasks({ task: taskName, errorMessage: 'Intentional' });
        expect(byStringMsg.items.map((i) => String(i._id))).toEqual([String(failedId)]);

        const byRegexMsg = await API.getReactiveTasks({ task: taskName, errorMessage: /intentional/i });
        expect(byRegexMsg.items.map((i) => String(i._id))).toEqual([String(failedId)]);
    });

    it('supports _id as hex string, array of ids, and sourceDocFilter by id', async () => {
        const byHex = await API.getReactiveTasks({ task: taskName, _id: completedId.toHexString() });
        expect(byHex.items.map((i) => String(i._id))).toEqual([String(completedId)]);

        const byArray = await API.getReactiveTasks({ task: taskName, _id: [completedId.toHexString(), failedId.toHexString()] });
        expect(byArray.total).toBe(2);

        const bySource = await API.getReactiveTasks({ task: taskName, sourceDocFilter: { _id: srcFailed } });
        expect(bySource.items.map((i) => String(i._id))).toEqual([String(failedId)]);
    });

    it('throws for an unknown task name', async () => {
        await expect(API.getReactiveTasks({ task: 'does-not-exist' })).rejects.toThrow(/not found in registry/);
    });

    it('throws for a complex sourceDocFilter on getReactiveTasks (retry-only)', async () => {
        await expect(API.getReactiveTasks({ task: taskName, sourceDocFilter: { isVip: true } as never })).rejects.toThrow(/does not support complex/);
    });
});
