import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { ObjectId } from 'mongodb';
import { ReactiveTaskHandler } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { getNewInstance } from '../testHelpers';

const COLLECTION_NAME = 'test_flow_control_docs';
const TASK_NAME_DEFER = 'test_defer_flow';
const TASK_NAME_THROTTLE = 'test_throttle_flow';
const TASK_NAME_DEFER_DATE = 'test_defer_date';
const TASK_NAME_THROTTLE_DATE = 'test_throttle_date';

describe('Reactive Tasks Flow Control (Defer/Throttle)', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let API: typeof instance.mongodash;
    // collection variable removed as we use specific collections
    let processedIdsDefer: Set<string>;
    let processedIdsThrottle: Set<string>;
    let processedState: Map<string, boolean>;

    const TASKS_COLLECTION_NAME = COLLECTION_NAME + '_tasks';

    // Handler 1: Defer by number (1000ms)
    const deferHandler: ReactiveTaskHandler = async (context: any) => {
        const _doc = await context.getDocument();
        const docId = context.docId.toString();
        // Use in-memory state to avoid triggering change stream update (which would cancel deferral)
        if (!processedState.get(docId)) {
            context.deferCurrent(1000);
            processedState.set(docId, true);
        } else {
            if (processedIdsDefer) processedIdsDefer.add(docId);
        }
    };

    // Handler 2: Throttle by number (2000ms)
    const throttleHandler: ReactiveTaskHandler = async (context: any) => {
        const _doc = await context.getDocument();
        // Use context.docId
        if (processedIdsThrottle) processedIdsThrottle.add(context.docId.toString());
        context.throttleAll(2000);
    };

    // Handler 3: Defer by Date (Now + 1000ms)
    const deferDateHandler: ReactiveTaskHandler = async (context: any) => {
        const _doc = await context.getDocument();
        const docId = context.docId.toString();
        if (!processedState.get(docId)) {
            context.deferCurrent(new Date(Date.now() + 1000));
            processedState.set(docId, true);
        } else {
            if (processedIdsDefer) processedIdsDefer.add(docId);
        }
    };

    // Handler 4: Throttle by Date (Now + 2000ms)
    const throttleDateHandler: ReactiveTaskHandler = async (context: any) => {
        const _doc = await context.getDocument();
        if (processedIdsThrottle) processedIdsThrottle.add(context.docId.toString());
        // Throttle until now + 2000ms using Date object
        context.throttleAll(new Date(Date.now() + 2000));
    };

    beforeAll(async () => {
        instance = getNewInstance();
        API = instance.mongodash;

        // Reduce polling interval for faster tests
        (API._scheduler as any).internalOptions.minPollMs = 10;
        (API._scheduler as any).internalOptions.maxPollMs = 50;

        await instance.initInstance({
            reactiveTaskConcurrency: 5,
            monitoring: { enabled: false },
        });

        const db = API.getMongoClient().db();
        // Create collections
        await db.createCollection(COLLECTION_NAME + '_defer');
        await db.createCollection(COLLECTION_NAME + '_throttle');
        await db.createCollection(COLLECTION_NAME + '_defer_date');
        await db.createCollection(COLLECTION_NAME + '_throttle_date');

        await API.reactiveTask({
            collection: COLLECTION_NAME + '_defer',
            task: TASK_NAME_DEFER,
            handler: deferHandler,
        });

        await API.reactiveTask({
            collection: COLLECTION_NAME + '_throttle',
            task: TASK_NAME_THROTTLE,
            handler: throttleHandler,
        });

        await API.reactiveTask({
            collection: COLLECTION_NAME + '_defer_date',
            task: TASK_NAME_DEFER_DATE,
            handler: deferDateHandler,
        });

        await API.reactiveTask({
            collection: COLLECTION_NAME + '_throttle_date',
            task: TASK_NAME_THROTTLE_DATE,
            handler: throttleDateHandler,
        });

        await API.startReactiveTasks();
    });

    beforeEach(() => {
        processedIdsDefer = new Set<string>();
        processedIdsThrottle = new Set<string>();
        processedState = new Map<string, boolean>();
    });

    afterEach(async () => {
        const db = API.getMongoClient().db();
        await db.collection(COLLECTION_NAME + '_defer').deleteMany({});
        await db.collection(COLLECTION_NAME + '_throttle').deleteMany({});
        await db.collection(COLLECTION_NAME + '_defer_date').deleteMany({});
        await db.collection(COLLECTION_NAME + '_throttle_date').deleteMany({});

        await db.collection(TASKS_COLLECTION_NAME).deleteMany({});
    });

    afterAll(async () => {
        await instance.cleanUpInstance();
    });

    async function waitForTask(db: any, taskName: string, tasksCollectionName: string, predicate: (task: any) => boolean = (_t) => true): Promise<any> {
        const start = Date.now();
        while (Date.now() - start < 10000) {
            const task = await db.collection(tasksCollectionName).findOne({ task: taskName });
            if (task && predicate(task)) return task;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`Timeout waiting for task ${taskName} in ${tasksCollectionName}`);
    }

    it('should defer a task correctly (deferCurrent - number)', async () => {
        const start = Date.now();
        const db = API.getMongoClient().db();
        const doc = { _id: new ObjectId(), type: 'defer' };
        await db.collection(COLLECTION_NAME + '_defer').insertOne(doc);

        const tasksCollection = COLLECTION_NAME + '_defer_tasks';
        const taskAfterDefer = await waitForTask(
            db,
            TASK_NAME_DEFER,
            tasksCollection,
            (task) => task.status === 'pending' && task.nextRunAt.getTime() >= start + 500,
        );

        // At this point we know the task matches the predicate (pending and deferred)

        // Check sourceDocId equality (handling string/Object mismatch if any)
        expect(taskAfterDefer.sourceDocId.toString()).toBe(doc._id.toString());
        // Status should be pending because deferOne resets it to pending
        expect(taskAfterDefer.status).toBe('pending');
        expect(taskAfterDefer.attempts).toBe(0); // attempts not incremented

        // Check nextRunAt is in future relative to start
        // deferred by 1000ms.
        // nextRunAt should be close to start + 1000.
        expect(taskAfterDefer.nextRunAt.getTime()).toBeGreaterThanOrEqual(start + 500);

        // Wait until deferred time passes (1000ms deferred)
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // It should be processed now
        // Wait for it to be processed (status: completed)
        let processedTask: any;
        for (let i = 0; i < 50; i++) {
            processedTask = await db.collection(tasksCollection).findOne({ _id: taskAfterDefer._id });
            if (processedTask.status === 'completed') break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(processedTask.status).toBe('completed');
        expect(processedIdsDefer.has(doc._id.toString())).toBe(true);
    }, 15000);

    async function waitForDeferral(db: any, taskName: string, tasksCollectionName: string): Promise<any> {
        const start = Date.now();
        while (Date.now() - start < 10000) {
            const task = await db.collection(tasksCollectionName).findOne({ task: taskName });
            if (task && task.dueAt) return task;
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`Timeout waiting for deferral of task ${taskName} in ${tasksCollectionName}`);
    }

    it('should defer a task correctly (deferCurrent - Date)', async () => {
        const start = Date.now();
        const db = API.getMongoClient().db();
        const doc = { _id: new ObjectId(), type: 'defer_date' };
        await db.collection(COLLECTION_NAME + '_defer_date').insertOne(doc);

        const tasksCollection = COLLECTION_NAME + '_defer_date_tasks';
        const taskAfterDefer = await waitForDeferral(db, TASK_NAME_DEFER_DATE, tasksCollection);

        expect(taskAfterDefer).toBeDefined();
        // Status should be pending because deferOne resets it to pending
        expect(taskAfterDefer.status).toBe('pending');

        // nextRunAt should be approx start + 1000 (Date.now() + 1000 in worker)
        expect(taskAfterDefer.nextRunAt.getTime()).toBeGreaterThanOrEqual(start + 500);
        expect(taskAfterDefer.attempts).toBe(0);
        expect(taskAfterDefer.dueAt).toBeDefined();
        // nextRunAt should be in the future
        expect(taskAfterDefer.nextRunAt.getTime()).toBeGreaterThan(Date.now());

        // Wait until deferred time passes (1000ms deferred)
        // Ensure we wait enough time for worker to pick it up
        await new Promise((resolve) => setTimeout(resolve, 1500));

        let taskCompleted: any;
        for (let i = 0; i < 50; i++) {
            taskCompleted = await db.collection(tasksCollection).findOne({ sourceDocId: doc._id, task: TASK_NAME_DEFER_DATE });
            if (taskCompleted?.status === 'completed') break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(taskCompleted?.status).toBe('completed');
        expect(processedIdsDefer.has(doc._id.toString())).toBe(true);
    }, 15000);

    it('should throttle tasks correctly (throttleAll - number)', async () => {
        const db = API.getMongoClient().db();
        // First doc - sets throttle
        const doc1 = { _id: new ObjectId(), type: 'throttle' };
        await db.collection(COLLECTION_NAME + '_throttle').insertOne(doc1);

        // Wait for first doc to run and throttle
        let attempts = 0;
        while (processedIdsThrottle.size === 0 && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
        }
        expect(processedIdsThrottle.size).toBe(1);

        // Second doc - should be throttled (skipped)
        const doc2 = { _id: new ObjectId(), type: 'throttle' };
        await db.collection(COLLECTION_NAME + '_throttle').insertOne(doc2);

        // Wait a bit to ensure it had a chance to be picked up (and skipped)
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Expect exactly 1 to have run
        expect(processedIdsThrottle.size).toBe(1);

        // Wait for throttle to expire (2000ms total)
        await new Promise((resolve) => setTimeout(resolve, 2100));

        // Now remaining doc(s) should run
        await new Promise((resolve) => setTimeout(resolve, 1000));

        expect(processedIdsThrottle.size).toBe(2);
    }, 15000);

    it('should throttle tasks correctly (throttleAll - Date)', async () => {
        const db = API.getMongoClient().db();
        // First doc - sets throttle
        const doc1 = { _id: new ObjectId(), type: 'throttle_date' };
        await db.collection(COLLECTION_NAME + '_throttle_date').insertOne(doc1);

        // Wait for first doc to run and throttle
        let attempts = 0;
        while (processedIdsThrottle.size === 0 && attempts < 100) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
        }
        expect(processedIdsThrottle.size).toBe(1);

        // Second doc - should be throttled (skipped)
        const doc2 = { _id: new ObjectId(), type: 'throttle_date' };
        await db.collection(COLLECTION_NAME + '_throttle_date').insertOne(doc2);

        // Wait a bit to ensure it had a chance to be picked up (and skipped)
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Expect exactly 1 to have run
        expect(processedIdsThrottle.size).toBe(1);

        // Wait for throttle to expire (2000ms total)
        await new Promise((resolve) => setTimeout(resolve, 2100));

        // Now remaining doc(s) should run
        await new Promise((resolve) => setTimeout(resolve, 1000));

        expect(processedIdsThrottle.size).toBe(2);
    }, 15000);

    it('Index Verification: findAndLockNextTask should use efficient index', async () => {
        const query = {
            task: { $in: [TASK_NAME_DEFER] },
            $or: [
                {
                    status: { $in: ['pending', 'processing_dirty'] },
                    nextRunAt: { $lte: new Date(), $type: 'date' },
                },
            ],
        };

        const db = API.getMongoClient().db();
        // Ensure index exists (init created it)
        const explain = await db
            .collection(COLLECTION_NAME + '_defer_tasks')
            .find(query, { sort: { nextRunAt: 1 } })
            .explain();

        const winningPlan = (explain as any).queryPlanner?.winningPlan;
        expect(winningPlan).toBeDefined();

        const hasIxScan = JSON.stringify(winningPlan).includes('"stage":"IXSCAN"');
        expect(hasIxScan).toBe(true);
        expect(JSON.stringify(winningPlan)).not.toContain('"stage":"COLLSCAN"');
    }, 10000);
});
