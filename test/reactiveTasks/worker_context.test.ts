import { Document, ObjectId } from 'mongodb';
import * as sinon from 'sinon';
import { createReusableWaitableStub, getNewInstance, wait, waitUntil } from '../testHelpers';

describe('Reactive Task Worker Context', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance({
            onError: (err) => console.error('Error:', err),
            onInfo: () => {}, // silence info
        });
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('should support lazy fetching with session', async () => {
        const collection = instance.mongodash.getCollection('lazyFetchTask');
        const taskId = 'lazyFetchTask';

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            // Verify docId availability
            expect(context.docId).toBeDefined();

            // Start a session
            const session = instance.mongodash.getMongoClient().startSession();
            try {
                // Fetch with session
                const doc = await context.getDocument({ session });
                expect(doc).toBeDefined();
                expect(doc.status).toBe('pending');
            } finally {
                await session.endSession();
            }
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: taskId,
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        const docId = new ObjectId();
        await collection.insertOne({ _id: docId, status: 'pending' } as Document);

        await waitForNextCall(2000);
        sinon.assert.calledOnce(handler);
    });

    it('should skip task if filter no longer matches (Race Condition Guard)', async () => {
        const collection = instance.mongodash.getCollection('raceConditionTask');
        const taskId = 'raceConditionTask';

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            // Simulate race: Document changed BEFORE we fetch
            await collection.updateOne({ _id: context.docId }, { $set: { status: 'processed' } });

            // This should throw TaskConditionFailedError internally
            await context.getDocument();
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: taskId,
            handler,
            filter: { status: 'pending' },
            debounce: 0,
            retryPolicy: { type: 'linear', interval: '10ms' }, // fast retry if it failed (but it shouldn't)
        });

        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({ _id: new ObjectId(), status: 'pending' } as Document);

        // Fetch verification:
        // The handler is called.
        // inside handler: update happens.
        // getDocument throws.
        // Worker catches and logs "Skipped".
        // Task marked as completed.

        await waitForNextCall(2000);

        // Verify task status in DB is 'completed' (not failed)
        // Use waitUntil because the update inside the handler might trigger re-planning
        const tasksCol = instance.mongodash.getCollection(`${taskId}_tasks`);
        await waitUntil(
            async () => {
                const task = await tasksCol.findOne({});
                return task?.status === 'completed';
            },
            { timeoutMs: 5000, message: 'Task should eventually be completed (skipped due to filter mismatch)' },
        );
    });

    it('should skip task if watched values mismatch (Optimistic Locking)', async () => {
        const collection = instance.mongodash.getCollection('optimisticLockTask');
        const taskId = 'optimisticLockTask';

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            // Verify watched values presence
            expect(context.watchedValues).toBeDefined();

            if (context.watchedValues.version === 1) {
                // Simulate race: Document version changed
                await collection.updateOne({ _id: context.docId }, { $set: { version: 2 } });

                // This should throw because context.watchedValues (v1) != sourceDoc (v2)
                await context.getDocument();
            }
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: taskId,
            handler,
            // Simple projection
            watchProjection: { version: 1 },
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({ _id: new ObjectId(), version: 1, data: 'foo' } as Document);

        await waitForNextCall(2000);
        await wait(500);

        // Verify task status is 'completed' (skipped)
        // We use waitUntil because the update inside the handler might trigger another planning
        // that could set the status back to pending temporarily if processing_dirty was reached.
        const tasksCol = instance.mongodash.getCollection(`${taskId}_tasks`);
        await waitUntil(
            async () => {
                const task = await tasksCol.findOne({});
                return task?.status === 'completed';
            },
            { timeoutMs: 5000, message: 'Task should eventually be completed (skipped)' },
        );
    });

    it('should handle complex watch projections (dotted paths)', async () => {
        const collection = instance.mongodash.getCollection('complexProjectionTask');
        const taskId = 'complexProjectionTask';

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            expect(context.watchedValues).toEqual({ meta: { version: 1 } }); // Structure unflattened
            const doc = await context.getDocument();
            expect(doc.meta.version).toBe(1);
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: taskId,
            handler,
            watchProjection: { 'meta.version': 1 },
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({ _id: new ObjectId(), meta: { version: 1, other: 'ignore' } } as Document);

        await waitForNextCall(2000);
        sinon.assert.calledOnce(handler);
    });

    it('hould detect mismatch in complex watch projections', async () => {
        const collection = instance.mongodash.getCollection('complexMismatchTask');
        const taskId = 'complexMismatchTask';

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            if (context.watchedValues?.meta?.version === 1) {
                // Change data
                await collection.updateOne({ _id: context.docId }, { $set: { 'meta.version': 2 } });
                await context.getDocument();
            }
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: taskId,
            handler,
            watchProjection: { 'meta.version': 1 },
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();
        await collection.insertOne({ _id: new ObjectId(), meta: { version: 1 } } as Document);

        await waitForNextCall(2000);

        const tasksCol = instance.mongodash.getCollection(`${taskId}_tasks`);
        await waitUntil(
            async () => {
                const task = await tasksCol.findOne({});
                return task?.status === 'completed';
            },
            { timeoutMs: 5000, message: 'Task should eventually be completed (it might retry if marked dirty during race)' },
        );
        // expect(task?.status).toBe('completed'); // skipped
    });
    it('should log full error object via onError when task fails', async () => {
        // Re-initialize for this test to control onError (beforeEach sets a custom one that bypasses setOnError)
        await instance.cleanUpInstance();
        instance = getNewInstance();
        await instance.initInstance({
            onInfo: () => {}, // silence info
            // Do NOT pass onError, so it uses the wrapper from testHelpers that respects setOnError
        });

        const collection = instance.mongodash.getCollection('errorLoggingTask');
        const taskId = 'errorLoggingTask';

        const errorToThrow = new Error('Intentional Failure for Logging Test');
        (errorToThrow as any).customProperty = 'foobar';

        const errorSpy = sinon.spy();
        instance.setOnError(errorSpy);

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async () => {
            throw errorToThrow;
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: taskId,
            handler,
            retryPolicy: { type: 'linear', interval: '10ms', maxAttempts: 1 },
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({ _id: new ObjectId(), status: 'pending' } as Document);

        // Wait for handler to accept call (and fail)
        await waitForNextCall(2000);

        // Wait a bit for async error handling
        await wait(200);

        // Verify onError was called with the exact error object
        sinon.assert.calledWith(errorSpy, errorToThrow);
        const loggedError = errorSpy.firstCall.args[0];
        expect(loggedError).toBe(errorToThrow);
        expect(loggedError.message).toBe('Intentional Failure for Logging Test');
        expect(loggedError.customProperty).toBe('foobar');
    });
});
