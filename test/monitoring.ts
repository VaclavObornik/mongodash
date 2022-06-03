/* eslint-disable @typescript-eslint/no-var-requires */
import * as assert from 'assert';
import { MongoClient } from 'mongodb';
import { Registry } from 'prom-client';
import { getNewInstance } from './testHelpers';
const { getConnectionString } = require('../tools/testingDatabase');

describe('monitoring', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let register: Registry;
    beforeEach(async () => {
        instance = getNewInstance();
        register = new Registry();
        await instance.initInstance({
            monitoring: {
                register,
                publishCronTasksStatistics: true,
                publishCronTasksSchedules: true,
                publishCronTasksStates: true,
            },
        });
    });

    it('should be possible to initialize monitoring', async () => {
        await instance.mongodash.cronTask('xxx', '1d', () => 1);
        await instance.mongodash.publishDatabaseMetrics({ maxTimeMS: 2000 });

        assert.deepStrictEqual(await register.getMetricsAsJSON(), [
            {
                aggregator: 'sum',
                help: 'report duration and states of each task',
                name: 'cron_task_duration',
                type: 'histogram',
                values: [],
            },
            {
                aggregator: 'sum',
                help: 'report time to next run of task',
                name: 'cron_task_scheduled_in_seconds',
                type: 'gauge',
                values: [{ labels: { taskId: 'xxx' }, value: 86400 }],
            },
        ]);
    });
});

/**
 * histogram, which shows the performed cron tasks with their statuses (->this will show history of performed tasks, results, times)
 *
 * Gouge with timestamps of: (-> this will show the current state and schedule)
 *  - nextRunTimestamp
 *  - lastStartTimestamp
 *  - lastEndTimestamp
 *
 *
 *  - runningForSeconds (-1 / 5) (should be based on process data, so we know the instance where is the job running on)
 *  - nextRunAt () (make sense only if runningForSeconds === -1) (should be got from database, what about interrupted?)
 *
 *
 *  States:
 *      - 'scheduled' - nextRunTimestamp - lastStartTimestamp > 0
 *      - 'running' - lastStartTimestamp - lastEndTimestamp >= 0
 *
 */
