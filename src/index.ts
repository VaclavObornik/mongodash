import { init as initCronTasks, InitOptions as CronTasksInitOptions } from './cronTasks';
import { init as initReactiveTasks, InitOptions as ReactiveTasksInitOptions } from './reactiveTasks';
import { getCollection, init as initGetCollection, InitOptions as GetCollectionInitOptions } from './getCollection';
import { init as initMongoClient, InitOptions as GetMongoClientInitOptions } from './getMongoClient';
import { defaultOnError, OnError, secureOnError } from './OnError';
import { defaultOnInfo, OnInfo, secureOnInfo } from './OnInfo';
import { init as withLockInit } from './withLock';
import { init as initWithTransaction } from './withTransaction';
import { resolveInitPromise } from './initPromise';
import { Collection } from 'mongodb';
import { GlobalsCollection } from './globalsCollection';
export {
    cronTask,
    Interval,
    runCronTask,
    scheduleCronTaskImmediately,
    startCronTasks,
    stopCronTasks,
    TaskFunction,
    TaskId,
    CODE_CRON_TASK_STARTED,
    CODE_CRON_TASK_FINISHED,
    CODE_CRON_TASK_SCHEDULED,
    CODE_CRON_TASK_FAILED,
    getCronTasksList,
    triggerCronTask,
    CronTaskQuery,
    CronPagedResult,
    CronTaskRecord,
    CronTaskStatus,
} from './cronTasks';
export { getCollection } from './getCollection';
export { getMongoClient } from './getMongoClient';
export { OnError } from './OnError';
export { withLock, isLockAlreadyAcquiredError, WithLockOptions, LockAlreadyAcquiredError } from './withLock';
export { withTransaction, registerPostCommitHook, PostCommitHook } from './withTransaction';
export {
    reactiveTask,
    ReactiveTask,
    ReactiveTaskHandler,
    TaskConditionFailedError,
    startReactiveTasks,
    stopReactiveTasks,
    getPrometheusMetrics,
    _scheduler,
    CODE_REACTIVE_TASK_STARTED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_PLANNER_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STOPPED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
    CODE_REACTIVE_TASK_LEADER_LOCK_LOST,
    getReactiveTasks,
    countReactiveTasks,
    retryReactiveTasks,
} from './reactiveTasks';
export { processInBatches, ProcessInBatchesOptions, ProcessInBatchesResult } from './processInBatches';
export { serveDashboard, OperationalTaskController } from './task-management';

let initCalled = false;

type PackageOptions = {
    onError?: OnError;
    onInfo?: OnInfo;
    taskCaller?: TaskCaller;
};

export interface TaskCaller {
    <T>(task: () => Promise<T>): Promise<T> | T;
}

export type InitOptions = PackageOptions &
    GetMongoClientInitOptions &
    Partial<CronTasksInitOptions> &
    Partial<GetCollectionInitOptions> &
    Partial<Omit<ReactiveTasksInitOptions, 'globalsCollection'>> & {
        globalsCollection?: string | Collection;
    };

export async function init(options: InitOptions): Promise<void> {
    if (initCalled) {
        throw new Error('init method can be called only once.');
    }
    initCalled = true;

    const onError = options.onError ? secureOnError(options.onError) : defaultOnError;
    const onInfo = options.onInfo ? secureOnInfo(options.onInfo) : defaultOnInfo;
    const taskCaller = options.taskCaller || ((task) => task());

    await initMongoClient(options);

    initGetCollection({ collectionFactory: options.collectionFactory ?? null });

    let globalsCollection: GlobalsCollection;
    if (!options.globalsCollection || typeof options.globalsCollection === 'string') {
        globalsCollection = getCollection(options.globalsCollection ?? '_mongodash_globals') as unknown as GlobalsCollection;
    } else {
        globalsCollection = options.globalsCollection as unknown as GlobalsCollection;
    }

    withLockInit({ onError });

    initWithTransaction({ onError, onInfo });

    initCronTasks({
        runCronTasks: options.runCronTasks ?? true,
        cronExpressionParserOptions: options.cronExpressionParserOptions ?? {},
        onError,
        onInfo,
        cronTaskCaller: options.cronTaskCaller ?? taskCaller,
        cronTaskFilter: options.cronTaskFilter ?? (() => true),
    });

    initReactiveTasks({
        ...options,
        globalsCollection: globalsCollection,
        onError,
        onInfo,
        reactiveTaskCaller: options.reactiveTaskCaller ?? taskCaller,
    });

    resolveInitPromise();
}
