import { getNewInstance } from '../testHelpers';
import { Collection, Document, ObjectId } from 'mongodb';
import { createReusableWaitableStub } from '../testHelpers';
import * as _debug from 'debug';

const debug = _debug('mongodash:tests:retryPolicy');

describe('reactiveTasks - Retry Policy', () => {
    let instance: {
        mongodash: {
            startReactiveTasks: () => Promise<void>;
            stopReactiveTasks: () => Promise<void>;
            reactiveTask: (def: any) => Promise<void>;
            getCollection: (name: string) => Collection<Document>;
        };
        initInstance: () => Promise<void>;
        cleanUpInstance: () => Promise<void>;
    };

    beforeEach(async () => {
        instance = await getNewInstance();
        await instance.initInstance();
    });

    afterEach(async () => {
        await instance.mongodash.stopReactiveTasks();
        await instance.cleanUpInstance();
    });

    const setupTestTask = async (testId: string, policy: any) => {
        const collection = instance.mongodash.getCollection(`retryTask_${testId}`);
        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug(`Processing task ${testId}`, doc._id);
            throw new Error('Forced failure');
        }, 10000); // Higher timeout for retries

        await instance.mongodash.reactiveTask({
            collection,
            task: `${testId}Task`,
            handler,
            retryPolicy: policy,
            debounce: 50, // fast debounce
        });
        await instance.mongodash.startReactiveTasks();

        return { collection, handler, waitForNextCall };
    };

    it('should respect linear retry policy', async () => {
        const policy = { type: 'linear', interval: '200ms' };
        const { collection, waitForNextCall } = await setupTestTask('linear', policy);

        await collection.insertOne({ status: 'pending' });

        // First attempt (immediate after debounce)
        await waitForNextCall();
        const time1 = Date.now();

        // Second attempt (should be ~200ms later)
        await waitForNextCall();
        const time2 = Date.now();

        const diff = time2 - time1;
        debug(`Retry delay: ${diff}ms`);
        expect(diff).toBeGreaterThan(100); // Allowing some margin
        // Upper bound is hard in CI, but checking it waited is enough.
    });

    it('should stop after maxAttempts', async () => {
        const policy = { type: 'fixed', interval: '10ms', maxAttempts: 3 };
        const { collection, waitForNextCall } = await setupTestTask('maxAttempts', policy);

        await collection.insertOne({ status: 'pending' });

        await waitForNextCall(); // 1
        await waitForNextCall(); // 2
        await waitForNextCall(); // 3

        const tasksCollection = instance.mongodash.getCollection(`retryTask_maxAttempts_tasks`);

        // Wait a bit for finalization
        await new Promise((r) => setTimeout(r, 200));

        const task = await tasksCollection.findOne({});
        expect(task).not.toBeNull();
        expect(task!.status).toEqual('failed');
        expect(task!.attempts).toEqual(3);
    });

    it('should stop after maxDuration', async () => {
        // This is hard to test with real time without waiting too long.
        // We can simulate it by providing a very short maxDuration.
        const policy = { type: 'fixed', interval: '100ms', maxDuration: '50ms' };
        // 1st attempt at T0. Fails. next retry at T0+100ms.
        // at T0+100ms, elapsed is 100ms > 50ms. Should fail immediately?
        // Wait. determineNextRetry is called at T0.
        // At T0, firstErrorAt is T0. Elapsed = 0.
        // It schedules retry at T0+100ms.
        // At T0+100ms, worker picks it up. attempts=2. Fails.
        // finalizeTask called. firstErrorAt is T0. Now is T0+100+. Elapsed > 50ms.
        // Should mark as failed.

        const { collection, waitForNextCall } = await setupTestTask('maxDuration', policy);

        await collection.insertOne({ status: 'pending' });

        await waitForNextCall(); // 1st attempt

        // 2nd attempt invocation
        await waitForNextCall();

        const tasksCollection = instance.mongodash.getCollection(`retryTask_maxDuration_tasks`);
        await new Promise((r) => setTimeout(r, 200));

        const task = await tasksCollection.findOne({});
        expect(task!.status).toEqual('failed');
        // Depending on timing, it might fail at attempt 2.
        expect(task!.attempts).toBeGreaterThan(1);
    });

    it('should use default exponential policy when no policy is defined', async () => {
        // Create task WITHOUT retryPolicy or retryBackoffMs
        const taskId = 'defaultPolicy';
        const collection = instance.mongodash.getCollection(`retryTask_${taskId}`);
        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {
            throw new Error('Failure');
        }, 10000);

        await instance.mongodash.reactiveTask({
            collection,
            task: `${taskId}Task`,
            handler,
            debounce: 50,
            // No policy defined
        });
        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({ status: 'pending' });

        // Attempt 1 -> Fails.
        // Default policy: Exponential, min 10s.
        // Should wait at least 8s (allow some margin) before next retry.

        await waitForNextCall();
        const time1 = Date.now();

        // Warning: Waiting 10s in test is slow.
        // We can inspect the scheduledAt in DB instead of waiting.
        await new Promise((r) => setTimeout(r, 500)); // wait for DB update

        const tasksCollection = instance.mongodash.getCollection(`retryTask_${taskId}_tasks`);
        const task = await tasksCollection.findOne({});

        expect(task).not.toBeNull();
        expect(task!.status).toBe('pending');
        expect(task!.attempts).toBe(1);

        // scheduledAt should be roughly time1 + 10s
        const scheduledDelay = task!.scheduledAt.getTime() - time1;
        // Should be around 10000ms. Allow margin.
        expect(scheduledDelay).toBeGreaterThan(9000);
        expect(scheduledDelay).toBeLessThan(15000);
    });

    it('should respect resetRetriesOnDataChange flag', async () => {
        // 1. Define task with resetRetriesOnDataChange: false
        const uniqueSuffix = Math.random().toString(36).substring(7);
        const taskId = `reset_retries_${uniqueSuffix}`;
        const sourceCollection = instance.mongodash.getCollection(`retryTask_${taskId}`);

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {
            throw new Error('Fail');
        }, 10000);

        await instance.mongodash.reactiveTask({
            task: `${taskId}Task`,
            collection: sourceCollection,
            handler,
            retryPolicy: {
                type: 'fixed',
                interval: '100ms',
                resetRetriesOnDataChange: false, // Should NOT reset firstErrorAt
            },
            debounce: 50,
        });
        await instance.mongodash.startReactiveTasks();

        // 2. Insert doc -> Fail
        const docId = new ObjectId();
        await sourceCollection.insertOne({ _id: docId, val: 1 });
        await waitForNextCall();
        await new Promise((r) => setTimeout(r, 100)); // Allow finalizeTask to write to DB

        const tasksCollection = instance.mongodash.getCollection(`retryTask_${taskId}_tasks`);
        const task1 = await tasksCollection.findOne({});
        expect(task1).not.toBeNull();
        expect(task1!.firstErrorAt).toBeTruthy();
        const firstErrorAt1 = task1!.firstErrorAt!;

        // 3. Update doc -> Fail again
        // Wait a bit to ensure time difference
        await new Promise((r) => setTimeout(r, 10));
        await sourceCollection.updateOne({ _id: docId }, { $set: { val: 2 } });

        // Wait for reconciliation and next failure
        // We need to wait for the task to be re-processed.
        await waitForNextCall();
        // Depending on timing/debounce, might need another wait or check directly.
        await new Promise((r) => setTimeout(r, 100)); // Allow finalizeTask to write to DB

        const task2 = await tasksCollection.findOne({});
        expect(task2).not.toBeNull();
        expect(task2!.firstErrorAt).toBeTruthy();
        // Should be the SAME firstErrorAt because resetRetriesOnDataChange is false
        const t1 = firstErrorAt1.getTime();
        const t2 = task2!.firstErrorAt!.getTime();
        expect(Math.abs(t2 - t1)).toBeLessThan(50); // Allow slight drift if any, but should be same
        expect(task2!.attempts).toBeGreaterThan(0);
    });

    it('should respect series retry policy with increasing intervals', async () => {
        // Series policy: [100ms, 300ms, 500ms]
        // 1st retry after 100ms, 2nd after 300ms, 3rd (and beyond) after 500ms
        const policy = { type: 'series', intervals: ['100ms', '300ms'], maxAttempts: 3 };
        const { collection, waitForNextCall } = await setupTestTask('series', policy);

        await collection.insertOne({ status: 'pending' });

        // First attempt
        await waitForNextCall();
        const time1 = Date.now();

        // Second attempt (should be ~100ms later - first interval)
        await waitForNextCall();
        const time2 = Date.now();

        const diff1 = time2 - time1;
        debug(`Series retry delay 1: ${diff1}ms`);
        expect(diff1).toBeGreaterThan(50); // Allow margin, expect ~100ms

        // Third attempt (should be ~300ms later - second interval)
        await waitForNextCall();
        const time3 = Date.now();

        const diff2 = time3 - time2;
        debug(`Series retry delay 2: ${diff2}ms`);
        expect(diff2).toBeGreaterThan(200); // Allow margin, expect ~300ms

        // Verify task failed after maxAttempts
        const tasksCollection = instance.mongodash.getCollection('retryTask_series_tasks');
        await new Promise((r) => setTimeout(r, 200));

        const task = await tasksCollection.findOne({});
        expect(task!.status).toEqual('failed');
        expect(task!.attempts).toEqual(3);
    });

    it('should reuse last interval in series retry policy if attempts exceed intervals length', async () => {
        // Series policy: [100ms, 300ms]
        // 1st retry: 100ms
        // 2nd retry: 300ms
        // 3rd retry: 300ms (reused)
        const policy = { type: 'series', intervals: ['100ms', '300ms'], maxAttempts: 4 };
        const { collection, waitForNextCall } = await setupTestTask('series_reuse', policy);

        await collection.insertOne({ status: 'pending' });

        // First attempt (immediate)
        await waitForNextCall();
        const time1 = Date.now();

        // 1st Retry (expect ~100ms)
        await waitForNextCall();
        const time2 = Date.now();
        const diff1 = time2 - time1;
        debug(`Series reuse retry 1: ${diff1}ms`);
        expect(diff1).toBeGreaterThan(50); // Margin for 100ms

        // 2nd Retry (expect ~300ms)
        await waitForNextCall();
        const time3 = Date.now();
        const diff2 = time3 - time2;
        debug(`Series reuse retry 2: ${diff2}ms`);
        expect(diff2).toBeGreaterThan(200); // Margin for 300ms

        // 3rd Retry (expect ~300ms REUSED)
        await waitForNextCall();
        const time4 = Date.now();
        const diff3 = time4 - time3;
        debug(`Series reuse retry 3: ${diff3}ms`);
        expect(diff3).toBeGreaterThan(200); // Margin for 300ms

        // Verify fail after 4 attempts
        const tasksCollection = instance.mongodash.getCollection('retryTask_series_reuse_tasks');
        await new Promise((r) => setTimeout(r, 200));

        const task = await tasksCollection.findOne({});
        expect(task!.status).toEqual('failed');
        expect(task!.attempts).toEqual(4);
    });

    it('should use cron retry policy for scheduled retries', async () => {
        // Use a cron expression that triggers every second
        const policy = { type: 'cron', expression: '* * * * * *', maxAttempts: 2 };
        const { collection, waitForNextCall } = await setupTestTask('cron', policy);

        await collection.insertOne({ status: 'pending' });

        // First attempt
        await waitForNextCall();

        // Second attempt (should be within ~1-2 seconds - next cron tick)
        const start = Date.now();
        await waitForNextCall();
        const elapsed = Date.now() - start;

        debug(`Cron retry delay: ${elapsed}ms`);
        // Cron schedules for the next second boundary, so wait should be 0-1000ms
        expect(elapsed).toBeLessThan(2500); // Allow margin for CI

        // Verify task failed after maxAttempts
        const tasksCollection = instance.mongodash.getCollection('retryTask_cron_tasks');
        await new Promise((r) => setTimeout(r, 200));

        const task = await tasksCollection.findOne({});
        expect(task!.status).toEqual('failed');
        expect(task!.attempts).toEqual(2);
    });
});
