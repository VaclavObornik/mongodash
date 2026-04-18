// import * as _debug from 'debug';
import { CronExpressionOptions } from 'cron-parser';
import { Collection, Document, Filter } from 'mongodb';
import { ConcurrentRunner } from './ConcurrentRunner';
import { createContinuousLock } from './createContinuousLock';
import { getCollection } from './getCollection';
import { initPromise } from './initPromise';
import { CompatibleFindOneAndUpdateOptions, CompatibleModifyResult } from './mongoCompatibility';
import { onError } from './OnError';
import { onInfo } from './OnInfo';
import { createIntervalFunction } from './parseInterval';

export interface InitOptions {
    runCronTasks: boolean;
    /**
     * Maximum number of cron tasks this instance will execute in parallel.
     *
     * The default of `1` preserves the historical behaviour: one task is
     * processed at a time per instance. Raise it when you have many
     * independent cron tasks and want to avoid head-of-line blocking (a
     * long-running task delaying unrelated ones).
     *
     * Tasks with the same id are always serialised via the per-task lock
     * (`lockedTill`), so raising this does not cause a single task to run
     * twice in parallel.
     */
    cronTaskConcurrency: number;
    cronExpressionParserOptions: CronExpressionOptions;
    cronTaskCaller: CronTaskCaller;
    cronTaskFilter: CronTaskFilter;
}

export function init(options: InitOptions): void {
    if (state.working || state.runner) {
        throw new Error('Cron tasks are already running');
    }

    state.runCronTasks = options.runCronTasks;
    if (options.cronExpressionParserOptions.endDate) {
        throw new Error("The 'endDate' parameter of the cron-parser package is not supported yet.");
    }
    state.cronExpressionParserOptions = options.cronExpressionParserOptions;
    state.cronTaskCaller = options.cronTaskCaller;
    state.cronTaskFilter = options.cronTaskFilter;

    const concurrency = Math.max(1, options.cronTaskConcurrency | 0);
    state.concurrency = concurrency;
    if (concurrency > 1) {
        state.runner = new ConcurrentRunner({ concurrency }, (error) => onError(error));
    }

    if (state.runCronTasks) {
        onInfo({ message: 'Cron tasks processing started', code: CODE_CRON_TASK_STARTED });
        if (state.tasks.size) {
            ensureStarted();
        }
    }
}

export const CODE_CRON_TASK_STARTED = 'cronTaskStarted';
export const CODE_CRON_TASK_FINISHED = 'cronTaskFinished';
export const CODE_CRON_TASK_SCHEDULED = 'cronTaskScheduled';
export const CODE_CRON_TASK_FAILED = 'cronTaskFailed';

// const debug = _debug('mongodash:cronTasks');
const debug = (..._args: unknown[]) => {};

export type TaskFunction = () => Promise<unknown> | void;
export type ScalarInterval = number | string;
export type StaticInterval = ScalarInterval | Date;
export type IntervalFunction = () => StaticInterval | Promise<StaticInterval>;
export type Interval = ScalarInterval | IntervalFunction;
export type TaskId = string;
export type CronTaskStatus = 'locked' | 'running' | 'idle' | 'failed' | 'scheduled';

export interface CronTaskRecord {
    _id: TaskId;
    status: CronTaskStatus;
    nextRunAt: Date;
    runImmediately: boolean;
    lockedTill: Date | null;
    lastRun: {
        startedAt: Date;
        finishedAt: Date | null;
        error: string | null;
        durationMs?: number;
    } | null;
    isRegistered: boolean; // True if the task is registered in this instance
}

export interface CronTaskQuery {
    filter?: string; // Search by task ID
    limit?: number;
    skip?: number;
    sort?: { field: keyof CronTaskRecord; direction: 1 | -1 };
}

export interface CronPagedResult<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}

type Task = { taskId: TaskId; task: TaskFunction; intervalFunction: IntervalFunction };

type RunLogEntry = {
    startedAt: Date;
    finishedAt: Date | null;
    error: string | null;
};

class TaskDocument implements Document {
    public runImmediately = false;

    public runLog = <RunLogEntry[]>[];

    public lockedTill: Date | null = null;

    constructor(
        public _id: TaskId,
        public runSince: Date,
    ) {}
}

type EnforcedTask = {
    taskId: TaskId;
    resolve: () => void;
    reject: (reason: Error) => void;
};

const noTaskWaitTime = 5 * 1000;

const state = {
    tasks: new Map<string, Task>(),

    // Legacy serial scheduler state (used when concurrency === 1).
    nextTaskTimeoutId: <ReturnType<typeof setTimeout> | null>null,
    working: false,

    // ConcurrentRunner state (used when concurrency > 1).
    runner: <ConcurrentRunner | null>null,
    runnerStarted: false,
    concurrency: 1,

    _collection: <Collection<TaskDocument> | null>null,

    get collection(): Collection<TaskDocument> {
        if (!this._collection) {
            this._collection = getCollection<TaskDocument>('cronTasks');
        }
        return this._collection;
    },

    enforcedTasks: <Array<EnforcedTask>>[],

    ensureIndexPromise: <Promise<unknown> | null>null,

    // Config
    runCronTasks: false,
    cronExpressionParserOptions: <CronExpressionOptions>{},
    cronTaskCaller: <CronTaskCaller | null>null,
    cronTaskFilter: <CronTaskFilter | null>null,
};

const CRON_SOURCE_NAME = '_cron_tasks';

export interface CronTaskCaller {
    <T>(task: () => Promise<T>): Promise<T> | T;
}

export interface CronTaskFilter {
    ({ taskId }: { taskId: TaskId }): boolean;
}

// Removed module-level vars that are now in state or imported
// let taskCaller: CronTaskCaller;
// let taskFilter: CronTaskFilter;
// let onError: OnError;
// let onInfo: OnInfo;

function createIntervalFunctionFromScalar(interval: ScalarInterval): () => Date {
    return createIntervalFunction(interval, { cronOptions: state.cronExpressionParserOptions });
}

async function getNextRunDate(intervalFunction: IntervalFunction): Promise<Date> {
    const maybeDate: StaticInterval = await intervalFunction();
    if (maybeDate instanceof Date) {
        return maybeDate;
    }

    return createIntervalFunctionFromScalar(maybeDate)();
}

export async function runCronTask(taskId: TaskId): Promise<void> {
    if (new Error().stack?.includes('mongoDashRunTaskNotCyclic')) {
        throw new Error('It is not possible to call runCronTask inside another running task. Use the scheduleCronTaskImmediately() function instead.');
    }

    debug(`runCronTask called for ${taskId}`);
    if (!state.tasks.has(taskId)) {
        throw new Error(`Cannot run unknown task '${taskId}'.`);
    }
    return new Promise((resolve, reject) => {
        state.enforcedTasks.push({ taskId, resolve, reject });
        ensureStarted();
    });
}

function ensureIndex() {
    if (!state.ensureIndexPromise) {
        state.ensureIndexPromise = Promise.all([
            state.collection.createIndex({ runSince: 1, _id: 1, lockedTill: 1 }, { name: 'runSinceIndex' }),
            state.collection.createIndex(
                { runImmediately: 1, _id: 1, lockedTill: 1 },
                { name: 'runImmediatelyIndex', partialFilterExpression: { runImmediately: { $eq: true } } },
            ),
        ]);
    }
    return state.ensureIndexPromise;
}

const lockTime = 5 * 60 * 1000;

function getLockDate() {
    return new Date(Date.now() + lockTime);
}

function getUnlockedFilter() {
    return { $or: [{ lockedTill: null }, { lockedTill: { $lt: new Date() } }] };
}

function getTasksToProcessFilter() {
    return {
        $and: [{ _id: { $in: Array.from(state.tasks.keys()).filter((taskId) => state.cronTaskFilter!({ taskId })) } }, getUnlockedFilter()],
    };
}

async function findATaskToRun(enforcedTask: EnforcedTask | null): Promise<Task | null> {
    let filter: Filter<TaskDocument>;

    if (enforcedTask) {
        filter = { $and: [{ _id: enforcedTask.taskId }, getUnlockedFilter()] };
    } else {
        filter = {
            $and: [{ $or: [{ runSince: { $lte: new Date() } }, { runImmediately: true }] }, getTasksToProcessFilter()],
        };
    }

    debug('finding a task', JSON.stringify(filter, null, 2));

    const result = await state.collection.findOneAndUpdate(
        filter,
        {
            $set: {
                lockedTill: getLockDate(),
                runImmediately: false,
            },
            $push: {
                runLog: {
                    $each: [{ startedAt: new Date(), finishedAt: null, error: null }],
                    $sort: { startedAt: -1 },
                    $slice: 5,
                },
            },
        },
        {
            sort: {
                runImmediately: -1, // prefer manual triggering
                runSince: 1, // prefer more delayed tasks
                'runLog.0.finishedAt': 1, // prefer tasks waiting longer
            },
            projection: { _id: true, runImmediately: true },
            includeResultMetadata: true,
        } as CompatibleFindOneAndUpdateOptions,
    );

    // Handle v4/v5+ compatibility
    const document = (result as unknown as CompatibleModifyResult).value;

    if (!document) {
        if (enforcedTask) {
            enforcedTask.reject(new Error('The task document not found or is locked right now.'));
        }
        return null;
    }

    if (!enforcedTask && !state.runCronTasks) {
        // the stopCronTasks has been called during finding a task, rollback the lock
        // we update runImmediately back only if it was truthy before
        const runImmediatelyUpdate = document.runImmediately ? { runImmediately: true } : null;
        await state.collection.updateOne(
            { _id: document._id },
            {
                $set: {
                    lockedTill: null,
                    ...runImmediatelyUpdate,
                },
                $pop: { runLog: -1 }, // remove last runLog entry (0 index)
            },
        );
        return null;
    }

    return state.tasks.get(document._id)!;
}

async function processTask(task: Task, enforcedTask: EnforcedTask | null) {
    const stopContinuousLock = createContinuousLock(state.collection, task.taskId, 'lockedTill', lockTime);

    const processTheTask = async () => {
        debug(`processing task ${task.taskId} `);
        let taskError: Error | null = null;
        let nextRunDate: Date;
        let nextRunScheduled = false;

        const start = new Date();
        try {
            function mongoDashRunTaskNotCyclic() {
                onInfo({ message: `Cron task '${task.taskId}' started.`, taskId: task.taskId, code: CODE_CRON_TASK_STARTED });
                return task.task();
            }
            await mongoDashRunTaskNotCyclic();
            const duration = Date.now() - start.getTime();
            onInfo({ message: `Cron task '${task.taskId}' finished in ${duration} ms.`, taskId: task.taskId, code: CODE_CRON_TASK_FINISHED, duration });
        } catch (err) {
            const duration = Date.now() - start.getTime();
            const reason = err instanceof Error ? err.message : `${err} `;
            onInfo({ message: `Cron task '${task.taskId}' failed in ${duration} ms.`, taskId: task.taskId, code: CODE_CRON_TASK_FAILED, reason, duration });
            taskError = err as Error;
        }

        try {
            await stopContinuousLock(); // to avoid possibility of lock after the following document update

            nextRunDate = await getNextRunDate(task.intervalFunction);
            debug(`scheduling task ${task.taskId} to run in ${nextRunDate.getTime() - Date.now()} ms`);

            await state.collection.updateOne(
                { _id: task.taskId },
                {
                    $set: {
                        runSince: nextRunDate,
                        lockedTill: null,
                        'runLog.0.error': taskError ? `${taskError} ` : null,
                        'runLog.0.finishedAt': new Date(),
                    },
                },
            );

            nextRunScheduled = true;
        } finally {
            if (enforcedTask) {
                if (taskError) {
                    enforcedTask.reject(taskError);
                } else {
                    enforcedTask.resolve();
                }
            } else if (taskError) {
                onError(taskError);
            }

            // we want to inform about the scheduling after the
            if (nextRunScheduled) {
                onInfo({
                    message: `Cron task '${task.taskId}' scheduled to ${nextRunDate!.toISOString()}.`,
                    taskId: task.taskId,
                    code: CODE_CRON_TASK_SCHEDULED,
                    nextRunDate: new Date(nextRunDate!.toISOString()),
                });
            }
        }
    };

    try {
        await state.cronTaskCaller!(processTheTask);
    } catch (err) {
        // todo revise why we need to do this
        // this should fix situations when the _taskCaller has a problem
        await stopContinuousLock();
        onError(err as Error);
    }
}

/** Can never throw. */
async function getWaitTimeByNextTask(): Promise<number> {
    try {
        const nextTask = await state.collection.findOne(getTasksToProcessFilter(), {
            projection: { runSince: 1 },
            sort: { runSince: 1 },
        });

        if (!nextTask) {
            return noTaskWaitTime;
        }

        const timeToNext = nextTask.runSince.getTime() - Date.now();
        return Math.min(Math.max(timeToNext, 0), noTaskWaitTime);
    } catch (error) {
        onError(error as Error);
        return noTaskWaitTime;
    }
}

// --- Serial scheduler (concurrency === 1) --------------------------------
// This is the historical single-loop implementation. It is used verbatim
// when `cronTaskConcurrency` is 1 (the default) so existing behaviour -
// including exact wake-up timing that several tests assert on - is
// preserved byte-for-byte.

function runATask(): void {
    debug('runATask called');
    state.working = true;
    (async () => {
        await initPromise;
        const enforcedTask = state.enforcedTasks.shift() || null;
        let task: Task | null = null;
        const countOfTasks = state.tasks.size;

        try {
            task = await findATaskToRun(enforcedTask);

            if (!task) {
                debug('no pending task found');
                return;
            }

            await processTask(task, enforcedTask);
        } catch (error) {
            debug(`Catch error ${error}`);
            if (enforcedTask) {
                enforcedTask.reject(error as Error);
            } else {
                onError(error as Error);
            }
        } finally {
            const shouldTriggerNext = () => state.runCronTasks || !!state.enforcedTasks.length;
            if (shouldTriggerNext()) {
                const aTaskHasBeenRegistered = () => state.tasks.size !== countOfTasks;
                let waitTime = 0;
                if (!task && !aTaskHasBeenRegistered() && !state.enforcedTasks.length) {
                    waitTime = await getWaitTimeByNextTask();
                    if (aTaskHasBeenRegistered() || state.enforcedTasks.length) {
                        waitTime = 0;
                    }
                }

                if (shouldTriggerNext()) {
                    debug(`SCHEDULING NEXT CHECK AFTER ${waitTime} ms`);
                    state.nextTaskTimeoutId = setTimeout(() => {
                        debug("it's time!");
                        state.nextTaskTimeoutId = null;
                        runATask();
                    }, waitTime);
                }
            }
            state.working = false;
        }
    })();
}

// --- Parallel scheduler (concurrency > 1) --------------------------------
// Wraps ConcurrentRunner around the same findATaskToRun / processTask
// primitives. Multiple workers poll the cron collection in parallel; each
// task is still serialised against itself via the per-taskId lockedTill
// mechanism, so raising concurrency never causes a single task to run
// twice simultaneously.

async function tryRunOneTaskViaRunner(): Promise<void> {
    await initPromise;
    const enforcedTask = state.enforcedTasks.shift() || null;
    let task: Task | null = null;

    try {
        task = await findATaskToRun(enforcedTask);
        if (!task) {
            debug('no pending task found');
            return;
        }

        await processTask(task, enforcedTask);
        // A task just completed - there may be another ready right now, so
        // poll again immediately instead of applying back-off.
        state.runner?.speedUp(CRON_SOURCE_NAME);
    } catch (error) {
        debug(`Catch error ${error}`);
        if (enforcedTask) {
            enforcedTask.reject(error as Error);
        } else {
            onError(error as Error);
        }
    } finally {
        if (!task && state.runner && state.runnerStarted && state.enforcedTasks.length === 0) {
            if (state.runCronTasks) {
                const waitMs = await getWaitTimeByNextTask();
                state.runner.setNextRunAt(CRON_SOURCE_NAME, Date.now() + waitMs);
            } else {
                // Mirror the serial scheduler: once runCronTasks has been
                // turned off and there is no enforced task to run we stop
                // polling entirely. A later runCronTask() / startCronTasks()
                // will re-enter ensureStarted which restarts the runner.
                state.runnerStarted = false;
                state.runner.stop().catch((err) => onError(err as Error));
            }
        }
    }
}

function ensureStarted(): void {
    if (state.runner) {
        // Parallel path.
        if (!state.runner.hasSource(CRON_SOURCE_NAME)) {
            state.runner.registerSource(CRON_SOURCE_NAME, {
                minPollMs: 200,
                maxPollMs: noTaskWaitTime,
                jitterMs: 100,
            });
        }
        if (!state.runnerStarted) {
            debug('STARTING RUNNER');
            state.runnerStarted = true;
            state.runner.start(() => tryRunOneTaskViaRunner());
        } else {
            state.runner.speedUp(CRON_SOURCE_NAME);
        }
        return;
    }

    // Serial path.
    if (state.nextTaskTimeoutId) {
        clearTimeout(state.nextTaskTimeoutId);
        state.nextTaskTimeoutId = null;
    }
    if (!state.working) {
        debug('STARTING LOOP');
        runATask();
    }
}

export function stopCronTasks(): void {
    debug('STOPPING CRON TASKS');
    state.runCronTasks = false;
    if (state.nextTaskTimeoutId) {
        clearTimeout(state.nextTaskTimeoutId);
        state.nextTaskTimeoutId = null;
    }
    if (state.runner && state.runnerStarted) {
        state.runnerStarted = false;
        // Fire and forget: the historical API is synchronous (returns void).
        // Any in-flight tasks will finish on their own; further polls will
        // not happen because runnerStarted is already cleared.
        state.runner.stop().catch((err) => onError(err as Error));
    }
}

export function startCronTasks(): void {
    state.runCronTasks = true;
    if (state.tasks.size) {
        ensureStarted();
    }
}

export async function scheduleCronTaskImmediately(taskId: TaskId): Promise<void> {
    const { matchedCount } = await state.collection.updateOne({ _id: taskId }, { $set: { runImmediately: true } });
    if (!matchedCount) {
        throw new Error(`No task with id "${taskId}" is registered.`);
    }
    if (state.runCronTasks && state.tasks.has(taskId)) {
        ensureStarted();
    }
}

export async function cronTask(taskId: TaskId, interval: Interval, task: TaskFunction): Promise<void> {
    await initPromise;

    if (state.tasks.has(taskId)) {
        throw new Error(`The taskId '${taskId}' is already used.`);
    }

    const intervalFunction = typeof interval === 'function' ? interval : createIntervalFunctionFromScalar(interval);
    const nextRun = await getNextRunDate(intervalFunction);

    const document = new TaskDocument(taskId, nextRun);
    const { _id, ...documentWithoutId } = document;
    await state.collection.updateOne({ _id: document._id }, { $setOnInsert: documentWithoutId }, { upsert: true });

    state.tasks.set(taskId, {
        taskId,
        task,
        intervalFunction,
    });
    debug(`task ${taskId} has been registered`);

    await ensureIndex();

    // if the cron tasks are logically running, ensure the loop is running
    if (state.runCronTasks) {
        ensureStarted();
    }
}

/**
 * Lists cron tasks with pagination and sorting.
 */
export async function getCronTasksList(query: CronTaskQuery = {}): Promise<CronPagedResult<CronTaskRecord>> {
    const limit = query.limit ?? 50;
    const skip = query.skip ?? 0;

    let sortField = query.sort?.field || 'runSince';
    if (sortField === 'nextRunAt') sortField = 'runSince';
    const sort = { [sortField]: query.sort?.direction ?? 1 } as Record<string, 1 | -1>;

    let localTaskIds = Array.from(state.tasks.keys());

    if (query.filter) {
        const regex = new RegExp(query.filter, 'i');
        localTaskIds = localTaskIds.filter((id) => regex.test(id));
    }

    const filter: Filter<TaskDocument> = {
        _id: { $in: localTaskIds },
    };

    const [docs, total] = await Promise.all([
        state.collection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
        state.collection.countDocuments(filter),
    ]);

    const items: CronTaskRecord[] = docs.map((doc) => {
        const lastRun = doc.runLog[0] || null;
        let lastRunData = null;

        if (lastRun) {
            lastRunData = {
                startedAt: lastRun.startedAt,
                finishedAt: lastRun.finishedAt,
                error: lastRun.error,
                durationMs: lastRun.finishedAt ? lastRun.finishedAt.getTime() - lastRun.startedAt.getTime() : undefined,
            };
        }

        let status: CronTaskStatus = 'idle';
        if (doc.lockedTill && doc.lockedTill > new Date()) {
            status = 'locked';
            // We can assume 'running' if locked, unless just failed/finished and lock not released yet?
            // Actually 'lockedTill' is set during processing.
            // If we want to distinguish 'running' from just 'locked', it's hard without another field.
            // But 'locked' usually means running or zombie.
            status = 'running';
        } else if (doc.runImmediately) {
            status = 'scheduled';
        } else if (lastRun?.error) {
            // Only if the LATEST run failed and we are not currently running
            status = 'failed';
        }

        return {
            _id: doc._id,
            status,
            nextRunAt: doc.runSince,
            runImmediately: doc.runImmediately,
            lockedTill: doc.lockedTill,
            lastRun: lastRunData,
            isRegistered: state.tasks.has(doc._id),
        };
    });

    return {
        items,
        total,
        limit,
        offset: skip,
    };
}

/**
 * @deprecated Alias for {@link scheduleCronTaskImmediately}. Prefer that name for
 * clarity - it describes exactly what happens (the task is scheduled to run on
 * the next polling tick, not necessarily this very millisecond). This alias will
 * be removed in a future major version.
 */
export async function triggerCronTask(taskId: TaskId): Promise<void> {
    return scheduleCronTaskImmediately(taskId);
}
/**
 * Returns IDs of all registered cron tasks in this instance.
 */
export function getRegisteredCronTaskIds(): string[] {
    return Array.from(state.tasks.keys()).sort();
}
