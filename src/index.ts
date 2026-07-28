import { Collection } from 'mongodb';
import { init as initCronTasks, InitOptions as CronTasksInitOptions } from './cronTasks';
import { getCollection, init as initGetCollection, InitOptions as GetCollectionInitOptions, reset as getCollectionReset } from './getCollection';
import { init as initMongoClient, InitOptions as GetMongoClientInitOptions } from './getMongoClient';
import { GlobalsCollection } from './globalsCollection';
import { rejectInitPromise, resolveInitPromise } from './initPromise';
import { defaultOnError, OnError, setGlobalOnError } from './OnError';
import { defaultOnInfo, OnInfo, setGlobalOnInfo } from './OnInfo';
import { createIntervalFunction } from './parseInterval';
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
    getRegisteredCronTaskIds,
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
    CODE_REACTIVE_TASK_CLEANUP,
    CODE_REACTIVE_TASK_DEFER_IGNORED,
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_INITIALIZED,
    CODE_REACTIVE_TASK_LEADER_LOCK_LOST,
    CODE_REACTIVE_TASK_LEGACY_MIGRATION,
    CODE_REACTIVE_TASK_LOCK_LOST,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STOPPED,
    CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
    CODE_REACTIVE_TASK_STARTED,
    CODE_REACTIVE_TASK_THREW_AFTER_COMPLETION,
    countReactiveTasks,
    getPrometheusMetrics,
    getReactiveTasks,
    PagedResult,
    PaginationOptions,
    reactiveTask,
    ReactiveTask,
    ReactiveTaskHandler,
    ReactiveTaskQuery,
    ReactiveTaskRecord,
    ReactiveTaskStatus,
    retryReactiveTasks,
    startReactiveTasks,
    stopReactiveTasks,
    TaskConditionFailedError,
    _scheduler,
} from './reactiveTasks';
export { OperationalTaskController, serveDashboard } from './task-management';
export * from './testing';
export { isLockAlreadyAcquiredError, LockAlreadyAcquiredError, withLock, WithLockOptions } from './withLock';
export { PostCommitHook, registerPostCommitHook, withTransaction } from './withTransaction';

let initCalled = false;
/**
 * Set once init() has started configuring the one-shot sub-systems (cron,
 * reactive tasks). Past this point a failed init() cannot be retried cleanly.
 */
let subsystemsConfigured = false;

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

    try {
        await initInternal(options);
        resolveInitPromise();
    } catch (err) {
        // Before the one-shot sub-system config: reset the guard so the caller
        // can retry init() (typical: app up before MongoDB is reachable). After
        // it a clean retry is impossible, so keep the guard and reject the
        // initPromise - awaiting registrations get the real error, never a hang.
        if (!subsystemsConfigured) {
            initCalled = false;
        } else {
            rejectInitPromise(err as Error);
        }
        throw err;
    }
}

/**
 * Validate the options that are pure configuration - no I/O, no side effects -
 * BEFORE any sub-system is handed its one-shot config. A typo here would
 * otherwise throw from deep inside initReactiveTasks, past the point where
 * init() can still be retried, leaving `initPromise` pending forever and every
 * task registration hanging silently.
 */
function validatePureOptions(options: InitOptions): void {
    if (options.cronExpressionParserOptions?.endDate) {
        throw new Error("The 'endDate' parameter of the cron-parser package is not supported yet.");
    }
    if (options.reactiveTaskCleanupInterval !== undefined) {
        // Throws for a non-positive / unparsable interval.
        createIntervalFunction(options.reactiveTaskCleanupInterval);
    }
}

async function initInternal(options: InitOptions): Promise<void> {
    validatePureOptions(options);

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

    subsystemsConfigured = true;
    initCronTasks({
        runCronTasks: options.runCronTasks ?? true,
        cronTaskConcurrency: options.cronTaskConcurrency ?? 1,
        cronExpressionParserOptions: options.cronExpressionParserOptions ?? {},
        cronTaskCaller: options.cronTaskCaller ?? taskCaller,
        cronTaskFilter: options.cronTaskFilter ?? (() => true),
    });
    initReactiveTasks({
        ...options,
        globalsCollection: globalsCollection,
        reactiveTaskCaller: options.reactiveTaskCaller ?? taskCaller,
    });
}
