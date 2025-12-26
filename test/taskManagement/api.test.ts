import { OperationalTaskController } from '../../src/task-management/OperationalTaskController';
import { ReactiveTaskScheduler } from '../../src/reactiveTasks/index';
import { ReactiveTaskManager } from '../../src/reactiveTasks/ReactiveTaskManager';
import { CronTaskQuery } from '../../src/cronTasks';

// Mock `getCronTasksList` and `triggerCronTask` from `../cronTasks`
// Jest mocking
jest.mock('../../src/cronTasks', () => ({
    getCronTasksList: jest.fn(),
    triggerCronTask: jest.fn(),
}));
import { getCronTasksList, triggerCronTask } from '../../src/cronTasks';
import { ObjectId } from 'mongodb';

describe('OperationalTaskController', () => {
    let scheduler: ReactiveTaskScheduler;
    let taskManager: ReactiveTaskManager;
    let controller: OperationalTaskController;

    beforeEach(() => {
        taskManager = {
            getTasks: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            getTaskStats: jest.fn().mockResolvedValue({ statuses: [], errorCount: 0 }),
            retryTasks: jest.fn(),
        } as unknown as ReactiveTaskManager;

        scheduler = {
            getTaskManager: jest.fn().mockReturnValue(taskManager),
        } as unknown as ReactiveTaskScheduler;

        controller = new OperationalTaskController(scheduler);
        jest.clearAllMocks();
    });

    describe('getReactiveTasks', () => {
        it('should remove lastObservedValues from response', async () => {
            (taskManager.getTasks as jest.Mock).mockResolvedValue({
                items: [{ task: 'test', lastObservedValues: { secret: 123 } }],
                total: 1,
            });

            const result = await controller.getReactiveTasks({});
            expect(result.items[0].lastObservedValues).toBeUndefined();
        });
        it('should call taskManager.getTasks with correct query and pagination', async () => {
            const params = {
                limit: 10,
                skip: 5,
                task: 'test-task',
                status: 'failed',
                errorMessage: 'error',
            };

            await controller.getReactiveTasks(params);

            expect(scheduler.getTaskManager).toHaveBeenCalled();
            expect(taskManager.getTasks).toHaveBeenCalledWith(
                {
                    task: 'test-task',
                    status: ['failed'],
                    errorMessage: 'error',
                },
                {
                    limit: 10,
                    skip: 5,
                    sort: { field: 'scheduledAt', direction: 1 },
                },
            );
        });

        it('should use defaults for limit and skip', async () => {
            await controller.getReactiveTasks({});
            expect(taskManager.getTasks).toHaveBeenCalledWith(
                {},
                {
                    limit: 50,
                    skip: 0,
                    sort: { field: 'scheduledAt', direction: 1 },
                },
            );
        });
    });

    describe('getReactiveTasks - Smart ID Matching', () => {
        it('should handle simple string ID', async () => {
            const id = 'some-string-id';
            await controller.getReactiveTasks({ sourceDocId: id });

            expect(taskManager.getTasks).toHaveBeenCalledWith(
                expect.objectContaining({
                    sourceDocFilter: { _id: { $in: ['some-string-id'] } },
                }),
                expect.any(Object),
            );
        });

        it('should handle numeric-looking string ID', async () => {
            const id = '12345';
            await controller.getReactiveTasks({ sourceDocId: id });

            expect(taskManager.getTasks).toHaveBeenCalledWith(
                expect.objectContaining({
                    sourceDocFilter: {
                        _id: { $in: ['12345', 12345] },
                    },
                }),
                expect.any(Object),
            );
        });

        it('should handle valid hex string (ObjectId-like)', async () => {
            const hex = '507f1f77bcf86cd799439011';
            await controller.getReactiveTasks({ sourceDocId: hex });

            const callArgs = (taskManager.getTasks as jest.Mock).mock.calls[0][0];
            const filterIds = callArgs.sourceDocFilter._id['$in'];

            expect(filterIds).toHaveLength(2);
            expect(filterIds).toContain(hex);
            expect(filterIds.some((id: any) => id instanceof ObjectId && id.toHexString() === hex)).toBe(true);
        });
    });

    describe('retryReactiveTasks', () => {
        it('should call taskManager.retryTasks with correct query', async () => {
            const body = { task: 'test', status: 'failed' };
            await controller.retryReactiveTasks(body);
            expect(taskManager.retryTasks).toHaveBeenCalledWith({
                task: 'test',
                status: 'failed',
            });
        });

        it('should handle sourceDocId in retry', async () => {
            const body = { task: 'test', sourceDocId: '123' };
            await controller.retryReactiveTasks(body);

            expect(taskManager.retryTasks).toHaveBeenCalledWith(
                expect.objectContaining({
                    task: 'test',
                    sourceDocFilter: { _id: { $in: ['123', 123] } },
                }),
            );
        });
    });

    describe('getCronTasks', () => {
        it('should call getCronTasksList with correct parameters', async () => {
            const params: CronTaskQuery = {
                filter: 'test',
                limit: 20,
                skip: 10,
                sort: { field: 'nextRunAt', direction: 1 },
            };

            await controller.getCronTasks(params);

            expect(getCronTasksList).toHaveBeenCalledWith({
                filter: 'test',
                limit: 20,
                skip: 10,
                sort: { field: 'nextRunAt', direction: 1 },
            });
        });
    });

    describe('triggerCronTask', () => {
        it('should call triggerCronTask with taskId', async () => {
            await controller.triggerCronTask({ taskId: 'cron-1' });
            expect(triggerCronTask).toHaveBeenCalledWith('cron-1');
        });

        it('should throw if taskId is missing', async () => {
            await expect(controller.triggerCronTask({} as any)).rejects.toThrow('taskId is required');
        });
    });
});
