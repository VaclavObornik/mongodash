// import * as _debug from 'debug';
import { CronExpressionOptions } from 'cron-parser';
import { Collection, Document, Filter } from 'mongodb';
import { createContinuousLock } from './createContinuousLock';
import { getCollection } from './getCollection';
import { initPromise } from './initPromise';
import { CompatibleFindOneAndUpdateOptions, CompatibleModifyResult } from './mongoCompatibility';
import { OnError } from './OnError';
import { OnInfo } from './OnInfo';
import { createIntervalFunction } from './parseInterval';

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

    nextTaskTimeoutId: <ReturnType<typeof setTimeout> | null>null,

    working: false,

    _collection: <Collection<TaskDocument> | null>null,

    get collection(): Collection<TaskDocument> {
        if (!this._collection) {
            this._collection = getCollection<TaskDocument>('cronTasks');
        }
        return this._collection;
    },

    enforcedTasks: <Array<EnforcedTask>>[],

    shouldRun: true,

    ensureIndexPromise: <Promise<unknown> | null>null,

    cronExpressionParserOptions: <CronExpressionOptions>{},
};

export interface CronTaskCaller {
    <T>(task: () => Promise<T>): Promise<T> | T;
}

export interface CronTaskFilter {
    ({ taskId }: { taskId: TaskId }): boolean;
}

let taskCaller: CronTaskCaller;
let taskFilter: CronTaskFilter;
let onError: OnError;
let onInfo: OnInfo;

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
        $and: [{ _id: { $in: Array.from(state.tasks.keys()).filter((taskId) => taskFilter({ taskId })) } }, getUnlockedFilter()],
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

    if (!enforcedTask && !state.shouldRun) {
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
    const stopContinuousLock = createContinuousLock(state.collection, task.taskId, 'lockedTill', lockTime, onError);

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
        await taskCaller(processTheTask);
    } catch (err) {
        // todo revise why we need to do this
        // this should fix situations when the _taskCaller has a problem
        await stopContinuousLock();
        onError(err as Error);
    }
}

/** can never throw */
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

function runATask(): void {
    debug('runATask called');
    state.working = true;
    (async () => {
        await initPromise;
        const enforcedTask = state.enforcedTasks.shift() || null; // there can be no enforced task
        let task: Task | null = null;
        const countOfTasks = state.tasks.size;

        try {
            task = await findATaskToRun(enforcedTask);

            if (!task) {
                debug('no pending task found');
                return; // the finally statement will be called anyway
            }

            await processTask(task, enforcedTask);
        } catch (error) {
            debug(`Catch error ${error} `);
            if (enforcedTask) {
                enforcedTask.reject(error as Error);
            } else {
                onError(error as Error);
            }
        } finally {
            const shouldTriggerNext = () => state.shouldRun || !!state.enforcedTasks.length;
            if (shouldTriggerNext()) {
                // if there was no task, wait for standard time,
                // but try find another one when one has finished
                // or a new task has been registered
                const aTaskHasBeenRegistered = () => state.tasks.size !== countOfTasks;
                let waitTime = 0;
                if (!task && !aTaskHasBeenRegistered() && !state.enforcedTasks.length) {
                    waitTime = await getWaitTimeByNextTask();
                    // a task can be registered in the meanwhile
                    if (aTaskHasBeenRegistered() || state.enforcedTasks.length) {
                        waitTime = 0;
                    }
                }

                // should we still trigger next?
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

export type InitOptions = {
    runCronTasks: boolean;
    cronExpressionParserOptions: CronExpressionOptions;
    onError: OnError;
    onInfo: OnInfo;
    cronTaskCaller: CronTaskCaller;
    cronTaskFilter: CronTaskFilter;
};

export function init(initOptions: InitOptions): void {
    if (initOptions.cronExpressionParserOptions.endDate) {
        throw new Error("The 'endDate' parameter of the cron-parser package is not supported yet.");
    }
    state.shouldRun = initOptions.runCronTasks;
    onError = initOptions.onError;
    onInfo = initOptions.onInfo;
    taskCaller = initOptions.cronTaskCaller;
    taskFilter = initOptions.cronTaskFilter;
    state.cronExpressionParserOptions = initOptions.cronExpressionParserOptions;
}

function ensureStarted(): void {
    // terminate waiting if there is any
    if (state.nextTaskTimeoutId) {
        clearTimeout(state.nextTaskTimeoutId);
        state.nextTaskTimeoutId = null;
    }

    if (!state.working) {
        debug('STARTING LOOP');
        runATask();
    }
    // else the loop is already set
}

export function stopCronTasks(): void {
    debug('STOPPING CRON TASKS');
    state.shouldRun = false;
    if (state.nextTaskTimeoutId) {
        clearTimeout(state.nextTaskTimeoutId);
    }
}

export function startCronTasks(): void {
    state.shouldRun = true;
    if (state.tasks.size) {
        ensureStarted();
    }
}

export async function scheduleCronTaskImmediately(taskId: TaskId): Promise<void> {
    const { matchedCount } = await state.collection.updateOne({ _id: taskId }, { $set: { runImmediately: true } });
    if (!matchedCount) {
        throw new Error(`No task with id "${taskId}" is registered.`);
    }
    if (state.shouldRun && state.tasks.has(taskId)) {
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

    if (state.shouldRun) {
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
 * Triggers a cron task immediately.
 * Alias for scheduleCronTaskImmediately but returns the new state or confirmation.
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
