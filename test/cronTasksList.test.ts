import * as assert from 'assert';
import { Collection } from 'mongodb';
import { cronTask, getCollection, getCronTasksList, init, stopCronTasks } from '../src/index';

const { getConnectionString } = require('../tools/testingDatabase');

describe('cronTasksList', () => {
    let cronCollection: Collection;

    beforeAll(async () => {
        await init({
            uri: getConnectionString(),
            runCronTasks: false,
        });
        cronCollection = getCollection('cronTasks');
    });

    afterAll(async () => {
        await stopCronTasks();
    });

    beforeEach(async () => {
        await cronCollection.deleteMany({});
    });

    it('should return only locally registered tasks', async () => {
        // Register a local task
        await cronTask('local-task', '1m', async () => {});

        // Add a "dead" task in DB (not registered)
        await cronCollection.insertOne({
            _id: 'dead-task' as any,
            interval: '1m',
            runSince: new Date(),
            runLog: [],
        });

        const result = await getCronTasksList({});
        assert.strictEqual(result.items.length, 1);
        assert.strictEqual(result.items[0]._id, 'local-task');
    });

    it('should still support filtering by text among local tasks', async () => {
        await cronTask('apple-task', '1m', async () => {});
        await cronTask('banana-task', '1m', async () => {});

        const result = await getCronTasksList({ filter: 'apple' });
        assert.strictEqual(result.items.length, 1);
        assert.strictEqual(result.items[0]._id, 'apple-task');
    });

    it('should correctly calculate task status and map item details', async () => {
        const failedTask = 'failed-task';
        const runningTask = 'running-task';
        const scheduledTask = 'scheduled-task';

        await cronTask(failedTask, '1m', async () => {});
        await cronTask(runningTask, '1m', async () => {});
        await cronTask(scheduledTask, '1m', async () => {});

        const now = new Date();
        await cronCollection.deleteMany({}); // clear what was inserted by cronTask calls
        await cronCollection.insertMany([
            {
                _id: failedTask as any,
                interval: '1m',
                runSince: new Date(now.getTime() - 60000),
                runLog: [
                    {
                        startedAt: new Date(now.getTime() - 70000),
                        finishedAt: new Date(now.getTime() - 65000),
                        error: 'Something went wrong',
                    },
                ],
            },
            {
                _id: runningTask as any,
                interval: '1m',
                runSince: new Date(now.getTime() - 10000),
                lockedTill: new Date(now.getTime() + 20000),
                runLog: [],
            },
            {
                _id: scheduledTask as any,
                interval: '1m',
                runSince: new Date(now.getTime() + 30000),
                runImmediately: true,
                runLog: [],
            },
        ]);

        const { items } = await getCronTasksList({});

        const failedItem = items.find((i: any) => i._id === failedTask);
        assert.ok(failedItem, 'Failed item should be found');
        assert.strictEqual(failedItem.status, 'failed');
        assert.ok(failedItem.lastRun, 'Failed item should have lastRun');
        assert.strictEqual(failedItem.lastRun.error, 'Something went wrong');

        const runningItem = items.find((i: any) => i._id === runningTask);
        assert.ok(runningItem, 'Running item should be found');
        assert.strictEqual(runningItem.status, 'running');

        const scheduledItem = items.find((i: any) => i._id === scheduledTask);
        assert.ok(scheduledItem, 'Scheduled item should be found');
        assert.strictEqual(scheduledItem.status, 'scheduled');
    });

    it('should support pagination and sorting', async () => {
        const taskIds = ['task-a', 'task-b', 'task-c'];
        for (const id of taskIds) {
            await cronTask(id, '1m', async () => {});
        }

        const now = new Date();
        // Clear and force specific runSince dates
        await cronCollection.deleteMany({});
        await cronCollection.insertMany(
            taskIds.map((id, i) => ({
                _id: id as any,
                interval: '1m',
                runSince: new Date(now.getTime() + i * 3600000),
                runLog: [],
            })),
        );

        // Test sorting by runSince
        const sorted = await getCronTasksList({
            sort: { field: 'nextRunAt' as any, direction: -1 },
        });
        assert.strictEqual(sorted.items[0]._id, 'task-c');

        // Test pagination
        const paged = await getCronTasksList({ limit: 1, skip: 1 });
        assert.strictEqual(paged.items.length, 1);
        assert.strictEqual(paged.total, 3);
    });
});
