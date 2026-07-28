import { ObjectId } from 'mongodb';
import { CronTaskQuery, getCronTasksList, scheduleCronTaskImmediately } from '../../src/cronTasks';
import { ReactiveTaskScheduler } from '../../src/reactiveTasks/index';
import { ReactiveTaskManager } from '../../src/reactiveTasks/ReactiveTaskManager';
import { OperationalTaskController } from '../../src/task-management/OperationalTaskController';

// Mock `getCronTasksList` and `scheduleCronTaskImmediately` from `../cronTasks`
// Jest mocking
jest.mock('../../src/cronTasks', () => ({
    getCronTasksList: jest.fn(),
    scheduleCronTaskImmediately: jest.fn(),
}));

jest.mock('../../src/getMongoClient', () => ({
    getMongoClient: () => ({ db: () => ({ databaseName: 'unit-test-db' }) }),
}));

describe('OperationalTaskController', () => {
    let scheduler: ReactiveTaskScheduler;
    let taskManager: ReactiveTaskManager;
    let controller: OperationalTaskController;

    beforeEach(() => {
        taskManager = {
            getTasks: jest.fn().mockResolvedValue({ items: [], total: 0 }),
            getTaskStats: jest.fn().mockResolvedValue({ statuses: [], errorCount: 0 }),
            retryTasks: jest.fn().mockResolvedValue({ modifiedCount: 1, matchedCount: 1 }),
            getAllTaskStats: jest.fn().mockResolvedValue({}),
        } as unknown as ReactiveTaskManager;

        scheduler = {
            getTaskManager: jest.fn().mockReturnValue(taskManager),
            getRegistry: jest.fn().mockReturnValue({ getAllTasks: () => [] }),
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
                    sort: { field: 'nextRunAt', direction: 1 },
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
                    sort: { field: 'nextRunAt', direction: 1 },
                },
            );
        });

        it('should clamp limit=0 (MongoDB "unlimited") back to the default', async () => {
            await controller.getReactiveTasks({ limit: 0, skip: 0 });
            expect(taskManager.getTasks).toHaveBeenCalledWith({}, expect.objectContaining({ limit: 50, skip: 0 }));
        });

        it('should clamp an oversized limit to the maximum and a negative skip to 0', async () => {
            await controller.getReactiveTasks({ limit: 9999, skip: -3 });
            expect(taskManager.getTasks).toHaveBeenCalledWith({}, expect.objectContaining({ limit: 500, skip: 0 }));
        });

        it('should clamp a negative/NaN limit', async () => {
            await controller.getReactiveTasks({ limit: -5 });
            expect(taskManager.getTasks).toHaveBeenCalledWith({}, expect.objectContaining({ limit: 1 }));

            await controller.getReactiveTasks({ limit: 'abc' as unknown as number });
            expect(taskManager.getTasks).toHaveBeenLastCalledWith({}, expect.objectContaining({ limit: 50 }));
        });

        it('should map hasError string flag to a boolean query', async () => {
            await controller.getReactiveTasks({ hasError: 'true' });
            expect(taskManager.getTasks).toHaveBeenCalledWith(expect.objectContaining({ hasError: true }), expect.any(Object));

            await controller.getReactiveTasks({ hasError: 'false' });
            expect(taskManager.getTasks).toHaveBeenLastCalledWith(expect.objectContaining({ hasError: false }), expect.any(Object));
        });

        it('should short-circuit to an empty page for a collection with no registered tasks', async () => {
            const result = await controller.getReactiveTasks({ collection: 'unknown-collection', limit: 9999, skip: 2 });

            expect(result).toEqual({
                items: [],
                total: 0,
                limit: 500,
                offset: 2,
                stats: { statuses: [], errorCount: 0 },
            });
            expect(taskManager.getTasks).not.toHaveBeenCalled();
            expect(taskManager.getTaskStats).not.toHaveBeenCalled();
        });

        it('should map a known collection to its task names', async () => {
            (scheduler.getRegistry as jest.Mock).mockReturnValue({
                getAllTasks: () => [
                    { task: 'task-a', sourceCollection: { collectionName: 'orders' } },
                    { task: 'task-b', sourceCollection: { collectionName: 'orders' } },
                    { task: 'task-c', sourceCollection: { collectionName: 'users' } },
                ],
            });

            await controller.getReactiveTasks({ collection: 'orders' });
            expect(taskManager.getTasks).toHaveBeenCalledWith(expect.objectContaining({ task: ['task-a', 'task-b'] }), expect.any(Object));
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

        it('should pass errorMessage and _id filters to retryTasks', async () => {
            await controller.retryReactiveTasks({ errorMessage: 'boom', _id: 'record-1' });

            expect(taskManager.retryTasks).toHaveBeenCalledWith({
                errorMessage: 'boom',
                _id: 'record-1',
            });
        });
    });

    describe('getInfo', () => {
        it('should aggregate reactive task stats, sort tasks by name and map cron tasks', async () => {
            (scheduler.getRegistry as jest.Mock).mockReturnValue({
                getAllTasks: () => [
                    // Intentionally out of order to exercise the name sort.
                    { task: 'zeta', sourceCollection: { collectionName: 'orders' } },
                    { task: 'alpha', sourceCollection: { collectionName: 'users' } },
                ],
            });
            (taskManager.getAllTaskStats as jest.Mock).mockResolvedValue({
                zeta: {
                    statuses: [
                        { _id: 'completed', count: 1 },
                        { _id: 'success', count: 2 },
                        { _id: 'failed', count: 3 },
                        { _id: 'processing', count: 4 },
                        { _id: 'processing_dirty', count: 5 },
                        { _id: 'pending', count: 6 },
                        { _id: 'some-unknown-status', count: 7 },
                    ],
                    // errorCount deliberately missing to exercise the || 0 fallback
                },
                // 'alpha' deliberately missing to exercise the stats fallback
            });
            (getCronTasksList as jest.Mock).mockResolvedValue({
                items: [
                    { _id: 'cron-with-error', status: 'failed', lastRun: { error: 'kaboom' }, nextRunAt: new Date(1) },
                    { _id: 'cron-never-run', status: 'idle', nextRunAt: new Date(2) },
                ],
            });

            const info = await controller.getInfo();

            expect(info.databaseName).toBe('unit-test-db');
            expect(info.reactiveTasks).toEqual([
                { name: 'alpha', collection: 'users', stats: { success: 0, failed: 0, processing: 0, pending: 0, error: 0 } },
                { name: 'zeta', collection: 'orders', stats: { success: 3, failed: 3, processing: 9, pending: 6, error: 0 } },
            ]);
            expect(info.cronTasks).toEqual([
                { id: 'cron-with-error', status: 'failed', lastRunError: 'kaboom', nextRunAt: new Date(1) },
                { id: 'cron-never-run', status: 'idle', lastRunError: undefined, nextRunAt: new Date(2) },
            ]);
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
        it('should call scheduleCronTaskImmediately with taskId', async () => {
            await controller.triggerCronTask({ taskId: 'cron-1' });
            expect(scheduleCronTaskImmediately).toHaveBeenCalledWith('cron-1');
        });

        it('should throw if taskId is missing', async () => {
            await expect(controller.triggerCronTask({} as any)).rejects.toThrow('taskId is required');
        });
    });
});
