import { noop } from 'lodash';
import { Collection, Document } from 'mongodb';
import { getNewInstance } from '../testHelpers';

describe('Reactive Tasks Clearing', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let sourceCollection: Collection<Document>;
    let tasksCollection: Collection<Document>;

    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        sourceCollection = instance.mongodash.getCollection('clearing_source');
        tasksCollection = instance.mongodash.getCollection('clearing_source_tasks');
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('should clear tasks that no longer match the filter after grace period', async () => {
        const taskName = 'clearingTask';

        await instance.mongodash.reactiveTask({
            task: taskName,
            collection: sourceCollection,
            filter: { active: true },
            cleanupPolicy: {
                deleteWhen: 'sourceDocumentDeletedOrNoLongerMatching',
                keepFor: '100ms',
            },
            debounce: 10000, // Stay pending
            handler: async () => {
                // noop
            },
        });

        await instance.mongodash.startReactiveTasks();

        // 1. Insert matching document
        await sourceCollection.insertOne({ _id: 'doc1' as any, active: true });

        // Wait for task to be created
        let task;
        for (let i = 0; i < 20; i++) {
            task = await tasksCollection.findOne({ sourceDocId: 'doc1' as any });
            if (task) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(task).toBeDefined();

        // 2. Update document to NO LONGER match filter
        await sourceCollection.updateOne({ _id: 'doc1' as any }, { $set: { active: false } });

        // 3. Wait > 100ms (grace period)
        await new Promise((resolve) => setTimeout(resolve, 500));

        // 4. Manually trigger periodic cleanup
        const scheduler = (instance.mongodash as any)._scheduler;
        const planner = (scheduler as any).taskPlanner;
        const reconciler = (planner as any).reconciler;

        // Force reset the nextCleanupTime to ensure it runs
        (reconciler as any).nextCleanupTime = 0;
        (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
        await reconciler.performPeriodicCleanup(() => false);

        // 5. Verify task is deleted
        task = await tasksCollection.findOne({ sourceDocId: 'doc1' as any });
        expect(task).toBeNull();
    });

    it('should NOT clear tasks if grace period has not passed', async () => {
        const taskName = 'noClearingTask';

        await instance.mongodash.reactiveTask({
            task: taskName,
            collection: sourceCollection,
            filter: { active: true },
            cleanupPolicy: {
                deleteWhen: 'sourceDocumentDeletedOrNoLongerMatching',
                keepFor: '10s', // Long grace period
            },
            handler: async () => {
                // noop
            },
        });

        await instance.mongodash.startReactiveTasks();

        // 1. Insert matching document
        await sourceCollection.insertOne({ _id: 'doc2' as any, active: true });

        // Wait for task to be created
        let task;
        for (let i = 0; i < 20; i++) {
            task = await tasksCollection.findOne({ sourceDocId: 'doc2' as any });
            if (task) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(task).not.toBeNull();

        // 2. Update document to NO LONGER match filter
        await sourceCollection.updateOne({ _id: 'doc2' as any }, { $set: { active: false } });

        const debugTask = await tasksCollection.findOne({ sourceDocId: 'doc2' as any });
        console.log('DEBUG: Task before cleanup:', JSON.stringify(debugTask, null, 2));
        console.log('DEBUG: Date.now():', Date.now());

        // 3. Trigger periodic cleanup
        const scheduler = (instance.mongodash as any)._scheduler;
        const planner = (scheduler as any).taskPlanner;
        const reconciler = (planner as any).reconciler;
        (reconciler as any).nextCleanupTime = 0;
        (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
        await reconciler.performPeriodicCleanup(() => false);

        // 4. Verify task is STILL THERE (grace period not reached)
        task = await tasksCollection.findOne({ sourceDocId: 'doc2' as any });
        expect(task).not.toBeNull();
    }, 10000);

    it('should clear tasks when document fails filter due to $$NOW', async () => {
        const taskName = 'nowClearingTask';

        await instance.mongodash.reactiveTask({
            task: taskName,
            collection: sourceCollection,
            // Only match if expiresAt is in the future
            filter: { $expr: { $gt: ['$expiresAt', '$$NOW'] } },
            cleanupPolicy: {
                deleteWhen: 'sourceDocumentDeletedOrNoLongerMatching',
                keepFor: '100ms',
            },
            debounce: 10000, // Stay pending
            handler: async () => {
                // noop
            },
        });

        await instance.mongodash.startReactiveTasks();

        // 1. Insert document that expires VERY SOON (500ms from now)
        const expiresAt = new Date(Date.now() + 500);
        await sourceCollection.insertOne({ _id: 'doc3' as any, expiresAt });

        // Wait for task to be created
        let task;
        for (let i = 0; i < 20; i++) {
            task = await tasksCollection.findOne({ sourceDocId: 'doc3' as any });
            if (task) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(task).toBeDefined();

        // 2. Wait for document to expire AND grace period
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // 3. Trigger periodic cleanup
        const scheduler = (instance.mongodash as any)._scheduler;
        const planner = (scheduler as any).taskPlanner;
        const reconciler = (planner as any).reconciler;
        (reconciler as any).nextCleanupTime = 0;
        (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
        await reconciler.performPeriodicCleanup(() => false);

        // 4. Verify task is deleted
        task = await tasksCollection.findOne({ sourceDocId: 'doc3' as any });
        expect(task).toBeNull();
    }, 10000);

    describe('deleteWhen strategies', () => {
        it('should delete task when source document is deleted (sourceDocumentDeleted)', async () => {
            const taskName = 'sourceDeletedTask';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                filter: { active: true },
                cleanupPolicy: {
                    deleteWhen: 'sourceDocumentDeleted',
                    keepFor: '100ms',
                },
                debounce: 10000,
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // Insert and wait for task
            await sourceCollection.insertOne({ _id: 'srcDel1' as any, active: true });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'srcDel1' as any });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // Delete source document
            await sourceCollection.deleteOne({ _id: 'srcDel1' as any });

            // Wait for grace period
            await new Promise((r) => setTimeout(r, 200));

            // Trigger cleanup
            const scheduler = (instance.mongodash as any)._scheduler;
            const reconciler = (scheduler as any).taskPlanner.reconciler;
            (reconciler as any).nextCleanupTime = 0;
            (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
            await reconciler.performPeriodicCleanup(() => false);

            // Should be deleted
            task = await tasksCollection.findOne({ sourceDocId: 'srcDel1' as any });
            expect(task).toBeNull();
        });

        it('should NOT delete task when filter no longer matches with sourceDocumentDeleted strategy', async () => {
            const taskName = 'noFilterDeleteTask';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                filter: { active: true },
                cleanupPolicy: {
                    deleteWhen: 'sourceDocumentDeleted', // Only delete when source is deleted
                    keepFor: '100ms',
                },
                debounce: 10000,
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // Insert and wait for task
            await sourceCollection.insertOne({ _id: 'noFiltDel1' as any, active: true });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'noFiltDel1' as any });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // Update to no longer match filter
            await sourceCollection.updateOne({ _id: 'noFiltDel1' as any }, { $set: { active: false } });

            // Wait for grace period
            await new Promise((r) => setTimeout(r, 200));

            // Trigger cleanup
            const scheduler = (instance.mongodash as any)._scheduler;
            const reconciler = (scheduler as any).taskPlanner.reconciler;
            (reconciler as any).nextCleanupTime = 0;
            (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
            await reconciler.performPeriodicCleanup(() => false);

            // Should still exist (only deletes when source is deleted)
            task = await tasksCollection.findOne({ sourceDocId: 'noFiltDel1' as any });
            expect(task).not.toBeNull();
        });

        it('should never delete task with never strategy', async () => {
            const taskName = 'neverDeleteTask';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                filter: { active: true },
                cleanupPolicy: {
                    deleteWhen: 'never',
                },
                debounce: 10000,
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // Insert and wait for task
            await sourceCollection.insertOne({ _id: 'neverDel1' as any, active: true });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'neverDel1' as any });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // Delete source document
            await sourceCollection.deleteOne({ _id: 'neverDel1' as any });

            // Wait
            await new Promise((r) => setTimeout(r, 200));

            // Trigger cleanup
            const scheduler = (instance.mongodash as any)._scheduler;
            const reconciler = (scheduler as any).taskPlanner.reconciler;
            (reconciler as any).nextCleanupTime = 0;
            (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
            await reconciler.performPeriodicCleanup(() => false);

            // Should still exist with 'never' strategy
            task = await tasksCollection.findOne({ sourceDocId: 'neverDel1' as any });
            expect(task).not.toBeNull();
        });
    });

    describe('grace period calculation', () => {
        it('should respect grace period based on updatedAt', async () => {
            const taskName = 'graceUpdatedAt';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                filter: { active: true },
                cleanupPolicy: {
                    deleteWhen: 'sourceDocumentDeletedOrNoLongerMatching',
                    keepFor: '2s', // 2 second grace period
                },
                debounce: 10000,
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // Insert and wait for task
            await sourceCollection.insertOne({ _id: 'graceUp1' as any, active: true });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'graceUp1' as any });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // Update to no longer match
            await sourceCollection.updateOne({ _id: 'graceUp1' as any }, { $set: { active: false } });

            // Wait less than grace period (500ms < 2s)
            await new Promise((r) => setTimeout(r, 500));

            // Trigger cleanup
            const scheduler = (instance.mongodash as any)._scheduler;
            const reconciler = (scheduler as any).taskPlanner.reconciler;
            (reconciler as any).nextCleanupTime = 0;
            (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
            await reconciler.performPeriodicCleanup(() => false);

            // Should still exist (within grace period)
            task = await tasksCollection.findOne({ sourceDocId: 'graceUp1' as any });
            expect(task).not.toBeNull();
        });
    });

    describe('default behavior', () => {
        it('should use sourceDocumentDeleted as default when cleanupPolicy not specified', async () => {
            const taskName = 'defaultBehavior';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                filter: { active: true },
                // No cleanupPolicy specified - should use defaults
                debounce: 10000,
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // Insert and wait for task
            await sourceCollection.insertOne({ _id: 'defBeh1' as any, active: true });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'defBeh1' as any });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // Update to no longer match filter
            await sourceCollection.updateOne({ _id: 'defBeh1' as any }, { $set: { active: false } });

            // Trigger cleanup with 0 interval (should still be within 24h default grace period)
            const scheduler = (instance.mongodash as any)._scheduler;
            const reconciler = (scheduler as any).taskPlanner.reconciler;
            (reconciler as any).nextCleanupTime = 0;
            (reconciler as any).internalOptions.getNextCleanupDate = () => new Date(0);
            await reconciler.performPeriodicCleanup(() => false);

            // Task should still exist - filter mismatch doesn't trigger cleanup with default sourceDocumentDeleted
            task = await tasksCollection.findOne({ sourceDocId: 'defBeh1' as any });
            expect(task).not.toBeNull();
        });
    });

    describe('Real-time deletion protection', () => {
        it('should NOT delete completed tasks instantly (preserved by grace period)', async () => {
            const taskName = 'historyPreservedTask';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                cleanupPolicy: {
                    deleteWhen: 'sourceDocumentDeleted',
                    keepFor: '10s', // 10s grace period
                },
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // 1. Create source doc and wait for completion
            await sourceCollection.insertOne({ _id: 'docReal2' as any });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'docReal2' as any, status: 'completed' });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // 2. Delete source doc
            await sourceCollection.deleteOne({ _id: 'docReal2' as any });

            // Wait a bit
            await new Promise((r) => setTimeout(r, 1000));

            // 3. Verify task STILL EXISTS (within grace period)
            task = await tasksCollection.findOne({ sourceDocId: 'docReal2' as any });
            expect(task).not.toBeNull();
            expect(task?.status).toBe('completed');
        }, 20000);

        it('should protect tasks with "never" strategy from instant deletion', async () => {
            const taskName = 'neverDelTask';

            await instance.mongodash.reactiveTask({
                task: taskName,
                collection: sourceCollection,
                cleanupPolicy: {
                    deleteWhen: 'never',
                },
                debounce: 10000,
                handler: async () => {},
            });

            await instance.mongodash.startReactiveTasks();

            // 1. Create source doc and wait for task
            await sourceCollection.insertOne({ _id: 'docReal3' as any });
            let task;
            for (let i = 0; i < 20; i++) {
                task = await tasksCollection.findOne({ sourceDocId: 'docReal3' as any });
                if (task) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            expect(task).toBeDefined();

            // 2. Delete source doc
            await sourceCollection.deleteOne({ _id: 'docReal3' as any });

            // Wait significantly
            await new Promise((r) => setTimeout(r, 1000));

            // 3. Verify task STILL EXISTS
            task = await tasksCollection.findOne({ sourceDocId: 'docReal3' as any });
            expect(task).not.toBeNull();
        }, 20000);
    });

    describe('reactiveTaskCleanupInterval configuration', () => {
        it('should parse duration string for cleanup interval', () => {
            const { ReactiveTaskScheduler } = require('../../src/reactiveTasks/index');
            const scheduler = new ReactiveTaskScheduler();
            scheduler.configure({
                reactiveTaskCleanupInterval: '12h',
            });

            expect(scheduler.internalOptions.getNextCleanupDate).toBeDefined();
            // Check calling it
            const next = scheduler.internalOptions.getNextCleanupDate();
            expect(next.getTime()).toBeGreaterThan(Date.now());
        });

        it('should parse milliseconds for cleanup interval', () => {
            const { ReactiveTaskScheduler } = require('../../src/reactiveTasks/index');
            const scheduler = new ReactiveTaskScheduler();
            scheduler.configure({
                reactiveTaskCleanupInterval: 3600000, // 1 hour
            });

            expect(scheduler.internalOptions.getNextCleanupDate).toBeDefined();
        });

        it('should parse cron expression for cleanup interval', () => {
            const { ReactiveTaskScheduler } = require('../../src/reactiveTasks/index');
            const scheduler = new ReactiveTaskScheduler();
            scheduler.configure({
                reactiveTaskCleanupInterval: 'CRON 0 3 * * *', // Daily at 3 AM
            });

            expect(scheduler.internalOptions.getNextCleanupDate).toBeDefined();
        });

        it('should throw error for invalid cron expression', () => {
            jest.resetModules();

            const { ReactiveTaskScheduler } = require('../../src/reactiveTasks/index');
            const scheduler = new ReactiveTaskScheduler();

            expect(() => {
                scheduler.configure({
                    reactiveTaskCleanupInterval: 'CRON invalid',
                });
            }).toThrow(/Invalid interval/);
        });

        it('should throw error for invalid duration string', () => {
            jest.resetModules();

            const { ReactiveTaskScheduler } = require('../../src/reactiveTasks/index');
            const scheduler = new ReactiveTaskScheduler();

            expect(() => {
                scheduler.configure({
                    reactiveTaskCleanupInterval: 'invalid',
                });
            }).toThrow(/Invalid interval/);
        });
    });
});
