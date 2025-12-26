import { noop } from 'lodash';
import { getNewInstance } from '../testHelpers';

describe('ReactiveTaskScheduler - Error Handling', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    describe('configure()', () => {
        it('should throw error when configure is called after initialization', async () => {
            await instance.initInstance({
                globalsCollection: '_mongodash_globals',
                onError: noop,
                onInfo: noop,
            });

            // initInstance already calls configure, so calling it again should throw
            expect(() => {
                (instance.mongodash as any)._scheduler.configure({});
            }).toThrow('Cannot configure scheduler after initialization.');
        });
    });

    describe('addTask()', () => {
        it('should throw error when adding task after scheduler has started', async () => {
            await instance.initInstance({
                globalsCollection: '_mongodash_globals',
                onError: noop,
                onInfo: noop,
            });

            const collection = instance.mongodash.getCollection('errorTest');

            // Register a task first
            await instance.mongodash.reactiveTask({
                collection,
                task: 'firstTask',
                handler: async () => {},
                debounce: 0,
            });

            // Start the scheduler
            await instance.mongodash.startReactiveTasks();

            try {
                // Attempt to add another task after start should throw
                await expect(
                    instance.mongodash.reactiveTask({
                        collection,
                        task: 'secondTask',
                        handler: async () => {},
                        debounce: 0,
                    }),
                ).rejects.toThrow('Cannot add task after scheduler has started.');
            } finally {
                await instance.mongodash.stopReactiveTasks();
            }
        }, 10000);

        it('should throw error when adding duplicate task name', async () => {
            await instance.initInstance({
                globalsCollection: '_mongodash_globals',
                onError: noop,
                onInfo: noop,
            });

            const collection = instance.mongodash.getCollection('duplicateTest');

            // Register first task
            await instance.mongodash.reactiveTask({
                collection,
                task: 'uniqueTask',
                handler: async () => {},
                debounce: 0,
            });

            // Attempt to register with same name should throw
            await expect(
                instance.mongodash.reactiveTask({
                    collection,
                    task: 'uniqueTask',
                    handler: async () => {},
                    debounce: 0,
                }),
            ).rejects.toThrow("Task with name 'uniqueTask' already exists.");
        }, 10000);
    });

    describe('start()', () => {
        it('should be idempotent - calling start multiple times is safe', async () => {
            await instance.initInstance({
                globalsCollection: '_mongodash_globals',
                onError: noop,
                onInfo: noop,
            });

            const collection = instance.mongodash.getCollection('startTest');

            await instance.mongodash.reactiveTask({
                collection,
                task: 'startTask',
                handler: async () => {},
                debounce: 0,
            });

            // Start multiple times - should not throw
            await instance.mongodash.startReactiveTasks();
            await instance.mongodash.startReactiveTasks();
            await instance.mongodash.startReactiveTasks();

            // Clean up
            await instance.mongodash.stopReactiveTasks();
        }, 10000);

        it('should throw error when start is called without configure', async () => {
            // We need to init instance for cleanup, but we test a fresh scheduler
            await instance.initInstance({
                globalsCollection: '_mongodash_globals',
                onError: noop,
                onInfo: noop,
            });

            // Create a fresh scheduler instance that is NOT configured

            const { ReactiveTaskScheduler } = require('../../src/reactiveTasks/index');
            const freshScheduler = new ReactiveTaskScheduler();

            await expect(freshScheduler.start()).rejects.toThrow('Scheduler is not configured. Call configure() first.');
        }, 10000);
    });

    describe('stop()', () => {
        it('should be idempotent - calling stop multiple times is safe', async () => {
            await instance.initInstance({
                globalsCollection: '_mongodash_globals',
                onError: noop,
                onInfo: noop,
            });

            const collection = instance.mongodash.getCollection('stopTest');

            await instance.mongodash.reactiveTask({
                collection,
                task: 'stopTask',
                handler: async () => {},
                debounce: 0,
            });

            await instance.mongodash.startReactiveTasks();

            // Stop multiple times - should not throw
            await instance.mongodash.stopReactiveTasks();
            await instance.mongodash.stopReactiveTasks();
            await instance.mongodash.stopReactiveTasks();
        }, 10000);

        it('should be safe to call stop without start', async () => {
            await instance.initInstance({
                onError: noop,
                onInfo: noop,
            });

            // Stop without start - should not throw
            await instance.mongodash.stopReactiveTasks();
        }, 10000);
    });
});
