// import * as _debug from 'debug';
import { parseExpression as parseCronExpression, ParserOptions as CronExpressionParserOptions } from 'cron-parser';
import { Collection, Filter, Document } from 'mongodb';
import parseDuration from 'parse-duration';
import { createContinuousLock } from './createContinuousLock';
import { getCollection } from './getCollection';
import { OnError } from './OnError';
import { initPromise } from './initPromise';
import { OnInfo } from './OnInfo';

export const CODE_CRON_TASK_STARTED = 'cronTaskStarted';
export const CODE_CRON_TASK_FINISHED = 'cronTaskFinished';
export const CODE_CRON_TASK_SCHEDULED = 'cronTaskScheduled';
export const CODE_CRON_TASK_FAILED = 'cronTaskFailed';

// const debug = _debug('mongodash:cronTasks');

export type TaskFunction = () => Promise<unknown> | void;
export type ScalarInterval = number | string;
export type StaticInterval = ScalarInterval | Date;
export type IntervalFunction = () => StaticInterval | Promise<StaticInterval>;
export type Interval = ScalarInterval | IntervalFunction;
export type TaskId = string;

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

    constructor(public _id: TaskId, public runSince: Date) {}
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

    cronExpressionParserOptions: <CronExpressionParserOptions>{},
};

export interface CronTaskCaller {
    <T>(task: () => Promise<T>): Promise<T> | T;
}

let _taskCaller: CronTaskCaller;
let _onError: OnError;
let _onInfo: OnInfo;

function dateInMillis(milliseconds: number) {
    return new Date(Date.now() + milliseconds);
}

const invalidIntervalMessage = `Invalid interval.`;

function createIntervalFunctionFromScalar(interval: ScalarInterval): () => Date {
    if (typeof interval === 'number') {
        if (!Number.isFinite(interval)) {
            throw new Error('Interval number has to be finite.');
        }
        return () => dateInMillis(interval);
    } else if (typeof interval !== 'string') {
        throw new Error(invalidIntervalMessage);
    }

    if (/^CRON /i.test(interval)) {
        try {
            const expression = interval.slice(5);
            const parsedExpression = parseCronExpression(expression, state.cronExpressionParserOptions);
            return () => parsedExpression.next().toDate();
        } catch (err) {
            throw new Error(`${invalidIntervalMessage} ${(err as Error).message}.`);
        }
    }

    const duration = parseDuration(interval);
    // debug('parsed duration: ', duration);
    if (typeof duration !== 'number') {
        throw new Error(invalidIntervalMessage);
    }
    return () => dateInMillis(duration);
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

    // debug(`runCronTask called for ${taskId}`);
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
        $and: [{ _id: { $in: Array.from(state.tasks.keys()) } }, getUnlockedFilter()],
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

    // debug('finding a task', JSON.stringify(filter, null, 2));

    const { value: document } = await state.collection.findOneAndUpdate(
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
        },
    );

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

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return state.tasks.get(document._id)!;
}

async function processTask(task: Task, enforcedTask: EnforcedTask | null) {
    const stopContinuousLock = createContinuousLock(state.collection, task.taskId, 'lockedTill', lockTime, _onError);

    const processTheTask = async () => {
        // debug(`processing task ${task.taskId}`);
        let taskError: Error | null = null;
        let nextRunDate: Date;
        let nextRunScheduled = false;

        const start = new Date();
        try {
            await (function mongoDashRunTaskNotCyclic() {
                _onInfo({ message: `Cron task '${task.taskId}' started.`, taskId: task.taskId, code: CODE_CRON_TASK_STARTED });
                return task.task();
            })();
            const duration = Date.now() - start.getTime();
            _onInfo({ message: `Cron task '${task.taskId}' finished in ${duration}ms.`, taskId: task.taskId, code: CODE_CRON_TASK_FINISHED, duration });
        } catch (err) {
            const duration = Date.now() - start.getTime();
            const reason = err instanceof Error ? err.message : `${err}`;
            _onInfo({ message: `Cron task '${task.taskId}' failed in ${duration}ms.`, taskId: task.taskId, code: CODE_CRON_TASK_FAILED, reason, duration });
            taskError = err as Error;
        }

        try {
            await stopContinuousLock(); // to avoid possibility of lock after the following document update

            nextRunDate = await getNextRunDate(task.intervalFunction);
            // debug(`scheduling task ${task.taskId} to run in ${nextRunDate.getTime() - Date.now()}ms`);

            await state.collection.updateOne(
                { _id: task.taskId },
                {
                    $set: {
                        runSince: nextRunDate,
                        lockedTill: null,
                        'runLog.0.error': taskError ? `${taskError}` : null,
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
                _onError(taskError);
            }

            // we want to inform about the scheduling after the
            if (nextRunScheduled) {
                _onInfo({
                    message: `Cron task '${task.taskId}' scheduled to ${nextRunDate!.toISOString()}.`,
                    taskId: task.taskId,
                    code: CODE_CRON_TASK_SCHEDULED,
                    nextRunDate: new Date(nextRunDate!.toISOString()),
                });
            }
        }
    };

    try {
        await _taskCaller(processTheTask);
    } catch (err) {
        _onError(err as Error);
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
        _onError(error as Error);
        return noTaskWaitTime;
    }
}

function runATask(): void {
    // debug('runATask called');
    state.working = true;
    (async () => {
        await initPromise;
        const enforcedTask = state.enforcedTasks.shift() || null; // there can be no enforced task
        let task: Task | null = null;
        const countOfTasks = state.tasks.size;

        try {
            task = await findATaskToRun(enforcedTask);

            if (!task) {
                // debug('no pending task found');
                return; // the finally statement will be called anyway
            }

            await processTask(task, enforcedTask);
        } catch (error) {
            // debug(`Catch error ${error}`);
            if (enforcedTask) {
                enforcedTask.reject(error as Error);
            } else {
                _onError(error as Error);
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
                    // debug(`SCHEDULING NEXT CHECK AFTER ${waitTime}ms`);
                    state.nextTaskTimeoutId = setTimeout(() => {
                        // debug("it's time!");
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
    cronExpressionParserOptions: CronExpressionParserOptions;
    onError: OnError;
    onInfo: OnInfo;
    cronTaskCaller: CronTaskCaller;
};

export function init({ runCronTasks, cronExpressionParserOptions, onError, onInfo, cronTaskCaller }: InitOptions): void {
    if (cronExpressionParserOptions.endDate) {
        throw new Error("The 'endDate' parameter of the cron-parser package is not supported yet.");
    }
    state.shouldRun = runCronTasks;
    _onError = onError;
    _onInfo = onInfo;
    _taskCaller = cronTaskCaller;
    state.cronExpressionParserOptions = cronExpressionParserOptions;
}

function ensureStarted(): void {
    // terminate waiting if there is any
    if (state.nextTaskTimeoutId) {
        clearTimeout(state.nextTaskTimeoutId);
        state.nextTaskTimeoutId = null;
    }

    if (!state.working) {
        // debug('STARTING LOOP');
        runATask();
    }
    // else the loop is already set
}

export function stopCronTasks(): void {
    // debug('STOPPING CRON TASKS');
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
    await state.collection.updateOne({ _id: document._id }, { $setOnInsert: document }, { upsert: true });

    state.tasks.set(taskId, {
        taskId,
        task,
        intervalFunction,
    });
    // debug(`task ${taskId} has been registered`);

    await ensureIndex();

    if (state.shouldRun) {
        ensureStarted();
    }
}
