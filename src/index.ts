import { Collection } from 'mongodb';
import { init as initCronTasks, InitOptions as CronTasksInitOptions } from './cronTasks';
import { getCollection, init as initGetCollection, InitOptions as GetCollectionInitOptions, reset as getCollectionReset } from './getCollection';
import { init as initMongoClient, InitOptions as GetMongoClientInitOptions } from './getMongoClient';
import { GlobalsCollection } from './globalsCollection';
import { resolveInitPromise } from './initPromise';
import { defaultOnError, OnError, setGlobalOnError } from './OnError';
import { defaultOnInfo, OnInfo, setGlobalOnInfo } from './OnInfo';
import { init as initReactiveTasks, InitOptions as ReactiveTasksInitOptions } from './reactiveTasks';
import { reset as withLockReset } from './withLock';
export {
    CODE_CRON_TASK_FAILED,
    CODE_CRON_TASK_FINISHED,
    CODE_CRON_TASK_SCHEDULED,
    CODE_CRON_TASK_STARTED,
    CronPagedResult,
    cronTask,
    CronTaskQuery,
    CronTaskRecord,
    CronTaskStatus,
    getCronTasksList,
    Interval,
    runCronTask,
    scheduleCronTaskImmediately,
    startCronTasks,
    stopCronTasks,
    TaskFunction,
    TaskId,
    triggerCronTask,
} from './cronTasks';
export { getCollection } from './getCollection';
export { getMongoClient } from './getMongoClient';
export { OnError } from './OnError';
export { processInBatches, ProcessInBatchesOptions, ProcessInBatchesResult } from './processInBatches';
export {
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_LEADER_LOCK_LOST,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STOPPED,
    CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
    CODE_REACTIVE_TASK_STARTED,
    countReactiveTasks,
    getPrometheusMetrics,
    getReactiveTasks,
    reactiveTask,
    ReactiveTask,
    ReactiveTaskHandler,
    retryReactiveTasks,
    startReactiveTasks,
    stopReactiveTasks,
    TaskConditionFailedError,
    _scheduler,
} from './reactiveTasks';
export { OperationalTaskController, serveDashboard } from './task-management';
export { isLockAlreadyAcquiredError, LockAlreadyAcquiredError, withLock, WithLockOptions } from './withLock';
export { PostCommitHook, registerPostCommitHook, withTransaction } from './withTransaction';

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

    // effective default handling is inside setters (or logic below)
    // Actually, secureWrap is handled in setters now.
    setGlobalOnError(options.onError || defaultOnError);
    setGlobalOnInfo(options.onInfo || defaultOnInfo);

    // We still need local variables for some init functions that expect them?
    // Or we refactor init functions too? Plan says "refactor consumers".
    // For now, let's keep passing `onError` variables but initialized from globals?
    // NO, the plan says "remove passing if feasible".

    const taskCaller = options.taskCaller || ((task) => task());

    await initMongoClient(options);

    getCollectionReset(); // Ensure clean state
    initGetCollection({ collectionFactory: options.collectionFactory ?? null });

    let globalsCollection: GlobalsCollection;
    if (!options.globalsCollection || typeof options.globalsCollection === 'string') {
        globalsCollection = getCollection(options.globalsCollection ?? '_mongodash_globals') as unknown as GlobalsCollection;
    } else {
        globalsCollection = options.globalsCollection as unknown as GlobalsCollection;
    }

    withLockReset();

    initCronTasks({
        runCronTasks: options.runCronTasks ?? true,
        cronExpressionParserOptions: options.cronExpressionParserOptions ?? {},
        cronTaskCaller: options.cronTaskCaller ?? taskCaller,
        cronTaskFilter: options.cronTaskFilter ?? (() => true),
    });
    initReactiveTasks({
        ...options,
        globalsCollection: globalsCollection,
        reactiveTaskCaller: options.reactiveTaskCaller ?? taskCaller,
    });

    resolveInitPromise();
}
