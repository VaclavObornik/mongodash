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
            }).toThrow(/Cannot configure reactive task scheduler/);
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

describe('ReactiveTaskScheduler - Replica Set Check', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let mockDb: any;
    let mockClient: any;

    beforeEach(async () => {
        // Reset cache to ensure fresh imports and isolation from previous tests
        jest.resetModules();

        // Setup default mocks
        mockDb = {
            command: jest.fn().mockResolvedValue({ setName: 'rs0' }),
            watch: jest.fn().mockReturnValue({
                on: jest.fn(),
                close: jest.fn(),
            }),
            collection: jest.fn().mockReturnValue({
                createIndex: jest.fn(),
                findOne: jest.fn(),
                updateOne: jest.fn(),
            }),
            databaseName: 'test_db',
        };

        mockClient = {
            db: jest.fn().mockReturnValue(mockDb),
        };

        // Mock the module BEFORE importing anything else that might depend on it
        jest.mock('../../src/getMongoClient', () => ({
            getMongoClient: jest.fn(() => mockClient),
            init: jest.fn(), // We don't want real init either
        }));

        // Re-import helper which likely imports mongodash/index etc.
        const helpers = require('../testHelpers');
        instance = helpers.getNewInstance();
    });

    afterEach(async () => {
        jest.unmock('../../src/getMongoClient');
        if (instance) {
            await instance.cleanUpInstance();
        }
    });

    it('should resolve start() when connected to a replica set (hello returns setName)', async () => {
        const { getMongoClient } = require('../../src/getMongoClient');
        getMongoClient.mockReturnValue(mockClient); // Ensure it returns our client

        await instance.initInstance({
            globalsCollection: '_mongodash_globals',
            onError: noop,
            onInfo: noop,
        });

        // Add a dummy task so planner tries to start
        const collection = instance.mongodash.getCollection('rsCheckTest');
        await instance.mongodash.reactiveTask({
            collection,
            task: 'testTask',
            handler: async () => {},
            debounce: 0,
        });

        // Should success
        await expect(instance.mongodash.startReactiveTasks()).resolves.not.toThrow();
        await instance.mongodash.stopReactiveTasks();
    }, 10000);

    it('should reject start() when NOT connected to a replica set (hello returns no setName)', async () => {
        const { getMongoClient } = require('../../src/getMongoClient');

        // Change mock for this test
        mockDb.command.mockResolvedValue({}); // No setName
        getMongoClient.mockReturnValue(mockClient);

        await instance.initInstance({
            globalsCollection: '_mongodash_globals',
            onError: noop,
            onInfo: noop,
        });

        // Add a dummy task
        const collection = instance.mongodash.getCollection('rsCheckTestFail');
        await instance.mongodash.reactiveTask({
            collection,
            task: 'testTask2',
            handler: async () => {},
            debounce: 0,
        });

        // Should fail
        await expect(instance.mongodash.startReactiveTasks()).rejects.toThrow('Reactive tasks can only be started when connected to a MongoDB Replica Set.');
    }, 10000);
});
