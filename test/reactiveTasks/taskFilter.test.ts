import _debug from 'debug';
import { noop } from 'lodash';
import { Document } from 'mongodb';
import * as sinon from 'sinon';
import { createSandbox } from 'sinon';
import { createReusableWaitableStub, getNewInstance } from '../testHelpers';

const debug = _debug('mongodash:reactiveTasks:filterTest');

describe('reactiveTasks filtering', () => {
    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);
    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should only process tasks allowed by the filter', async () => {
        // Initialize with filter that only allows 'allowedTask'
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
            reactiveTaskFilter: ({ task }: { task: string }) => task === 'allowedTask',
        } as any);

        const collection = instance.mongodash.getCollection('filterTestTasks');

        // Handler for allowed task
        const { stub: allowedHandler, waitForNextCall: waitForAllowed } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing allowed task', doc._id);
        });

        // Handler for ignored task
        const { stub: ignoredHandler, expectNoCall: expectNoIgnored } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing ignored task', doc._id);
        });

        // Register allowed task
        await instance.mongodash.reactiveTask({
            collection,
            task: 'allowedTask',
            handler: allowedHandler,
            debounce: 0,
        });

        // Register ignored task
        await instance.mongodash.reactiveTask({
            collection,
            task: 'ignoredTask',
            handler: ignoredHandler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert document for allowed task
            // Note: Both tasks watch the same collection, so inserting one doc triggers both tasks (conceptually)
            // But since we filter by task name, only 'allowedTask' should be processed.
            // Wait, reactiveTask definitions are separate.
            // If I insert a document, both tasks are "triggered" in the sense that they are in the registry.
            // The planner will plan both tasks (create task records).
            // The worker should only pick up 'allowedTask'.

            await collection.insertOne({ _id: 'doc1' } as Document);

            // Expect allowedHandler to be called
            await waitForAllowed(2000);
            sinon.assert.calledOnce(allowedHandler);

            // Expect ignoredHandler NOT to be called
            await expectNoIgnored(1000);
            sinon.assert.notCalled(ignoredHandler);

            // Verify that the ignored task is actually in the DB (planned) but not processed
            const tasksCollection = instance.mongodash.getCollection('filterTestTasks_tasks');
            const ignoredTaskRecord = await tasksCollection.findOne({ task: 'ignoredTask', sourceDocId: 'doc1' });

            if (!ignoredTaskRecord) throw new Error('Ignored task record should exist (planned)');
            // Status should be 'pending' (or 'processing_dirty' if it was somehow picked up but it shouldn't be)
            // It should be 'pending' because the worker never picked it up.
            expect(ignoredTaskRecord.status).toBe('pending');

            const allowedTaskRecord = await tasksCollection.findOne({ task: 'allowedTask', sourceDocId: 'doc1' });
            if (!allowedTaskRecord) throw new Error('Allowed task record should exist');
            expect(allowedTaskRecord.status).toBe('completed');
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);

    it('should not process any task if filter rejects all', async () => {
        // Initialize with filter that rejects everything
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
            reactiveTaskFilter: () => false,
        } as any);

        const collection = instance.mongodash.getCollection('filterRejectAllTasks');

        const { stub: handler, expectNoCall } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing task', doc._id);
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'rejectedTask',
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            await collection.insertOne({ _id: 'doc1' } as Document);

            // Expect handler NOT to be called
            await expectNoCall(1000);
            sinon.assert.notCalled(handler);

            // Verify that the task is actually in the DB (planned) but not processed
            const tasksCollection = instance.mongodash.getCollection('filterRejectAllTasks_tasks');
            const taskRecord = await tasksCollection.findOne({ task: 'rejectedTask', sourceDocId: 'doc1' });

            if (!taskRecord) throw new Error('Task record should exist (planned)');
            expect(taskRecord.status).toBe('pending');
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 10000);
});
