import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { CODE_MANUAL_TRIGGER } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { getNewInstance } from '../testHelpers';

describe('Dashboard Logging', () => {
    const { mongodash, initInstance, cleanUpInstance } = getNewInstance();

    let onInfoSpy: any;

    beforeAll(async () => {
        onInfoSpy = jest.fn();
        await initInstance({
            onInfo: onInfoSpy,
        });
    });

    afterAll(async () => {
        await cleanUpInstance();
    });

    it('should log manual intervention when triggering a cron task', async () => {
        const OperationalTaskController = mongodash.OperationalTaskController;
        const controller = new OperationalTaskController(mongodash._scheduler);
        const taskId = 'test-cron-task';

        // Insert a dummy task into the cronTasks collection so triggerCronTask finds it
        await mongodash.getCollection('cronTasks').insertOne({
            _id: taskId,
            schedule: '0 * * * *',
            handler: 'test',
            runImmediately: false,
        } as any);

        await controller.triggerCronTask({ taskId });

        expect(onInfoSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                code: CODE_MANUAL_TRIGGER,
                action: 'triggerCron',
                taskId: taskId,
            }),
        );
    });

    it('should log manual intervention when retrying reactive tasks', async () => {
        const OperationalTaskController = mongodash.OperationalTaskController;
        const controller = new OperationalTaskController(mongodash._scheduler);

        // Define a query
        const query = { status: 'failed' };

        await controller.retryReactiveTasks({ status: 'failed' });

        expect(onInfoSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                code: CODE_MANUAL_TRIGGER,
                action: 'retry',
                params: { status: 'failed' },
            }),
        );
    });
});
