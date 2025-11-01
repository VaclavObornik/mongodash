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

const noTaskWaitTime = 5 * 1000; // Time to wait if no tasks are due or available

const state = {
    tasks: new Map<string, Task>(),
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

    // --- New/Modified for concurrency ---
    activeTasksCount: 0,
    maxConcurrentTasks: 1, // Default, will be set in init
    isAttemptingToRunTasks: false, // Guards the main task acquisition loop
    nextScheduledCheckTimeoutId: <ReturnType<typeof setTimeout> | null>null, // For periodic checks
};

export interface CronTaskCaller {
    <T>(task: () => Promise<T>): Promise<T> | T;
}

export interface CronTaskFilter {
    ({ taskId }: { taskId: TaskId }): boolean;
}

let _taskCaller: CronTaskCaller;
let _taskFilter: CronTaskFilter;
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
        // debug(`Enforced task ${taskId} pushed. Queue size: ${state.enforcedTasks.length}`);
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

function getUnlockedFilter(): Filter<TaskDocument> {
    return { $or: [{ lockedTill: null }, { lockedTill: { $lt: new Date() } }] };
}

function getTasksToProcessFilter(): Filter<TaskDocument> {
    // This filter is for general task selection, not for enforced tasks
    return {
        $and: [{ _id: { $in: Array.from(state.tasks.keys()).filter((taskId) => _taskFilter({ taskId })) } }, getUnlockedFilter()],
    };
}

async function findATaskToRun(enforcedTask: EnforcedTask | null): Promise<Task | null> {
    let filter: Filter<TaskDocument>;
    const findOptions: any = {
        // Type any for sort, projection, includeResultMetadata
        projection: { _id: true, runImmediately: true }, // Ensure runImmediately is projected for rollback logic
        includeResultMetadata: true,
    };

    if (enforcedTask) {
        // debug(`Finding enforced task: ${enforcedTask.taskId}`);
        filter = { $and: [{ _id: enforcedTask.taskId }, getUnlockedFilter()] };
        // No specific sort for enforced tasks, as we target by ID.
    } else {
        // debug('Finding next available task');
        filter = {
            $and: [
                { $or: [{ runSince: { $lte: new Date() } }, { runImmediately: true }] },
                getTasksToProcessFilter(), // Applies _taskFilter and unlocked check
            ],
        };
        findOptions.sort = {
            runImmediately: -1,
            runSince: 1,
            'runLog.0.finishedAt': 1,
        };
    }

    // debug('finding a task with filter:', JSON.stringify(filter, null, 2));
    const { value: document } = await state.collection.findOneAndUpdate(
        filter,
        {
            $set: {
                lockedTill: getLockDate(),
                runImmediately: false, // Always set to false once picked up
            },
            $push: {
                runLog: {
                    $each: [{ startedAt: new Date(), finishedAt: null, error: null }],
                    $sort: { startedAt: -1 },
                    $slice: 5,
                },
            },
        },
        findOptions,
    );

    if (!document) {
        if (enforcedTask) {
            // debug(`Enforced task ${enforcedTask.taskId} not found or locked.`);
            enforcedTask.reject(new Error(`Task '${enforcedTask.taskId}' document not found or is locked.`));
        }
        return null;
    }

    // This rollback is for the case where stopCronTasks is called *during* this findOneAndUpdate operation.
    // It's a rare edge case. If an enforced task was being processed, it should proceed.
    if (!enforcedTask && !state.shouldRun) {
        // debug(`Stop called during task find for ${document._id}, rolling back lock.`);
        const runImmediatelyUpdate = document.runImmediately ? { runImmediately: true } : {}; // only set if it was true
        await state.collection.updateOne(
            { _id: document._id },
            {
                $set: {
                    lockedTill: null,
                    ...runImmediatelyUpdate,
                },
                $pop: { runLog: -1 },
            },
        );
        return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return state.tasks.get(document._id)!;
}

async function processTask(task: Task, enforcedTaskForThisInstance: EnforcedTask | null): Promise<void> {
    const stopContinuousLock = createContinuousLock(state.collection, task.taskId, 'lockedTill', lockTime, _onError);

    const processTheTaskActual = async () => {
        // debug(`processing task ${task.taskId}`);
        let taskError: Error | null = null;
        let nextRunDate: Date;
        let nextRunScheduled = false;
        const start = new Date();

        try {
            await (function mongoDashRunTaskNotCyclic() {
                // IIFE to ensure name for stack check
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
            await stopContinuousLock(); // Stop before DB update
            nextRunDate = await getNextRunDate(task.intervalFunction);
            // debug(`scheduling task ${task.taskId} to run in ${nextRunDate.getTime() - Date.now()}ms`);
            await state.collection.updateOne(
                { _id: task.taskId },
                {
                    $set: {
                        runSince: nextRunDate,
                        lockedTill: null, // Explicitly unlock
                        'runLog.0.error': taskError ? `${taskError}` : null,
                        'runLog.0.finishedAt': new Date(),
                    },
                },
            );
            nextRunScheduled = true;
        } finally {
            if (enforcedTaskForThisInstance) {
                if (taskError) {
                    enforcedTaskForThisInstance.reject(taskError);
                } else {
                    enforcedTaskForThisInstance.resolve();
                }
            } else if (taskError) {
                _onError(taskError);
            }

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
        await _taskCaller(processTheTaskActual);
    } catch (err) {
        // debug(`Error from _taskCaller or unhandled in processTheTaskActual for ${task.taskId}: ${err}`);
        await stopContinuousLock(); // Ensure lock is released if _taskCaller failed badly

        if (enforcedTaskForThisInstance) {
            try {
                enforcedTaskForThisInstance.reject(err as Error);
            } catch {
                /* already settled */
            }
        } else {
            _onError(err as Error);
        }
        // Do not re-throw here, as the orchestrator's .catch handles logging/generic error.
        // Re-throwing would make the orchestrator's .finally run twice for the activeTasksCount decrement.
    }
}

async function getWaitTimeByNextTask(): Promise<number> {
    try {
        const nextTaskDocument = await state.collection.findOne(
            {
                // Simpler filter for next due task, relies on _taskFilter being applied broadly
                $and: [
                    { _id: { $in: Array.from(state.tasks.keys()).filter((taskId) => _taskFilter({ taskId })) } },
                    // No need for unlocked filter here, just want the soonest runSince
                ],
            },
            {
                projection: { runSince: 1 },
                sort: { runSince: 1 },
            },
        );

        if (!nextTaskDocument || !nextTaskDocument.runSince) {
            return noTaskWaitTime;
        }
        const timeToNext = nextTaskDocument.runSince.getTime() - Date.now();
        return Math.min(Math.max(timeToNext, 0), noTaskWaitTime); // Cap wait time
    } catch (error) {
        _onError(error as Error);
        return noTaskWaitTime; // Fallback on error
    }
}

function orchestrateTaskExecution(): void {
    if (!state.shouldRun && state.enforcedTasks.length === 0) {
        // debug('Orchestrator: Cron stopped and no enforced tasks.');
        return;
    }

    if (state.isAttemptingToRunTasks) {
        // debug('Orchestrator: Already attempting to run tasks in this cycle.');
        return;
    }

    // Check for concurrency limit only if there are no enforced tasks demanding immediate attention.
    // An enforced task should try to run even if at max concurrency for regular tasks.
    if (state.activeTasksCount >= state.maxConcurrentTasks && state.enforcedTasks.length === 0) {
        // debug('Orchestrator: Max concurrency reached for regular tasks, no enforced tasks. Relying on tasks finishing or scheduled check.');
        return;
    }

    state.isAttemptingToRunTasks = true;
    // debug(`Orchestrator: Starting attempt. Active: ${state.activeTasksCount}, Max: ${state.maxConcurrentTasks}, Enforced: ${state.enforcedTasks.length}`);

    (async () => {
        await initPromise;
        let tasksLaunchedInThisCycle = 0;

        while (
            (state.shouldRun || state.enforcedTasks.length > 0) && // Process if cron is running OR enforced tasks exist
            (state.activeTasksCount < state.maxConcurrentTasks || state.enforcedTasks.length > 0) // Slot available OR enforced task
        ) {
            if (state.tasks.size === 0 && state.enforcedTasks.length === 0) {
                // debug('Orchestrator: No registered tasks and no enforced tasks.');
                break;
            }

            const currentEnforcedTaskToTry = state.enforcedTasks.length > 0 ? state.enforcedTasks[0] : null; // Peek
            let taskToProcess: Task | null = null;

            try {
                taskToProcess = await findATaskToRun(currentEnforcedTaskToTry);

                if (taskToProcess) {
                    // debug(`Orchestrator: Found task ${taskToProcess.taskId}. Enforced: ${!!(currentEnforcedTaskToTry && taskToProcess.taskId === currentEnforcedTaskToTry.taskId)}`);
                    state.activeTasksCount++;
                    tasksLaunchedInThisCycle++;

                    // Determine if this is the specific enforced task we peeked
                    const actualEnforcedTaskForThisRun =
                        currentEnforcedTaskToTry && taskToProcess.taskId === currentEnforcedTaskToTry.taskId ? currentEnforcedTaskToTry : null;

                    if (actualEnforcedTaskForThisRun) {
                        state.enforcedTasks.shift(); // Consume it now that we've committed to processing it
                    }

                    processTask(taskToProcess, actualEnforcedTaskForThisRun)
                        .catch((err) => {
                            // This catch is mostly for programming errors within processTask not caught by its internal try/catch
                            // or if _taskCaller itself throws an error not related to the task function.
                            _onError(new Error(`Orchestrator-level error during processTask for ${taskToProcess?.taskId}: ${err}`));
                        })
                        .finally(() => {
                            // debug(`Orchestrator: Task ${taskToProcess?.taskId} processing block finished. Decrementing active count.`);
                            state.activeTasksCount--;
                            // A slot might have freed up, or an enforced task finished. Try to run more.
                            setTimeout(orchestrateTaskExecution, 0); // Use setTimeout to yield and prevent stack overflow
                        });
                } else {
                    // No task found by findATaskToRun
                    if (currentEnforcedTaskToTry) {
                        // If findATaskToRun returned null for an enforced task, it means it was rejected by findATaskToRun.
                        // We must remove it from the queue here if it's still the head.
                        if (state.enforcedTasks.length > 0 && state.enforcedTasks[0] === currentEnforcedTaskToTry) {
                            // debug(`Orchestrator: Removing enforced task ${currentEnforcedTaskToTry.taskId} from queue as findATaskToRun failed for it.`);
                            state.enforcedTasks.shift();
                        }
                    }
                    // debug('Orchestrator: No suitable task found in this iteration.');
                    break; // Stop trying to find tasks in this loop iteration
                }
            } catch (error) {
                // Catch error from findATaskToRun itself
                // debug(`Orchestrator: Error during findATaskToRun: ${error}`);
                if (currentEnforcedTaskToTry) {
                    if (state.enforcedTasks.length > 0 && state.enforcedTasks[0] === currentEnforcedTaskToTry) {
                        state.enforcedTasks.shift()?.reject(error as Error); // Consume and reject
                    } else {
                        _onError(new Error(`Error handling an enforced task that was no longer at head of queue: ${error}`));
                    }
                } else {
                    _onError(error as Error);
                }
                break; // Stop trying in this loop on error
            }
        } // End while loop

        state.isAttemptingToRunTasks = false;
        // debug(`Orchestrator: Finished attempt. Launched: ${tasksLaunchedInThisCycle}. Active: ${state.activeTasksCount}`);

        if (state.shouldRun || state.enforcedTasks.length > 0) {
            const noTasksFoundOrLaunched = tasksLaunchedInThisCycle === 0;
            scheduleNextSystematicCheck(noTasksFoundOrLaunched);
        }
    })().catch((criticalError) => {
        _onError(new Error(`Critical error in orchestrateTaskExecution main async block: ${criticalError}`));
        state.isAttemptingToRunTasks = false;
        if (state.shouldRun || state.enforcedTasks.length > 0) {
            scheduleNextSystematicCheck(true); // Long wait on critical error
        }
    });
}

function scheduleNextSystematicCheck(waitForNextDueTask: boolean): void {
    if (state.nextScheduledCheckTimeoutId) {
        clearTimeout(state.nextScheduledCheckTimeoutId);
        state.nextScheduledCheckTimeoutId = null;
    }

    if (!state.shouldRun && state.enforcedTasks.length === 0) {
        // debug('Scheduler: Not scheduling, cron stopped & no enforced tasks.');
        return;
    }

    if (state.enforcedTasks.length > 0 && !state.isAttemptingToRunTasks) {
        // debug('Scheduler: Enforced tasks present, trying to orchestrate immediately.');
        state.nextScheduledCheckTimeoutId = setTimeout(() => {
            state.nextScheduledCheckTimeoutId = null;
            orchestrateTaskExecution();
        }, 0);
        return;
    }

    if (state.tasks.size === 0 && state.enforcedTasks.length === 0) {
        // No regular tasks registered, no enforced
        // debug(`Scheduler: No tasks registered. Scheduling check in ${noTaskWaitTime}ms.`);
        state.nextScheduledCheckTimeoutId = setTimeout(() => {
            state.nextScheduledCheckTimeoutId = null;
            orchestrateTaskExecution();
        }, noTaskWaitTime);
        return;
    }

    (async () => {
        let waitTime = 0;
        if (waitForNextDueTask || (state.activeTasksCount >= state.maxConcurrentTasks && state.enforcedTasks.length === 0)) {
            waitTime = await getWaitTimeByNextTask();
            // debug(`Scheduler: Calculated waitTime from next task: ${waitTime}ms.`);
        } else {
            // debug('Scheduler: Not waiting for next due task, waitTime 0.');
        }

        if (state.nextScheduledCheckTimeoutId === null && (state.shouldRun || state.enforcedTasks.length > 0) && !state.isAttemptingToRunTasks) {
            // debug(`Scheduler: Scheduling next systematic check in ${waitTime}ms.`);
            state.nextScheduledCheckTimeoutId = setTimeout(() => {
                state.nextScheduledCheckTimeoutId = null;
                orchestrateTaskExecution();
            }, waitTime);
        } else {
            // debug('Scheduler: Not scheduling new timeout (already exists, orchestrator running, or should not run).');
        }
    })().catch((err) => {
        _onError(err as Error);
        if (state.nextScheduledCheckTimeoutId === null && state.shouldRun && !state.isAttemptingToRunTasks) {
            // debug(`Scheduler: Error in getWaitTimeByNextTask, scheduling fallback check in ${noTaskWaitTime}ms.`);
            state.nextScheduledCheckTimeoutId = setTimeout(() => {
                state.nextScheduledCheckTimeoutId = null;
                orchestrateTaskExecution();
            }, noTaskWaitTime);
        }
    });
}

export type InitOptions = {
    runCronTasks: boolean;
    cronExpressionParserOptions: CronExpressionParserOptions;
    onError: OnError;
    onInfo: OnInfo;
    cronTaskCaller: CronTaskCaller;
    cronTaskFilter: CronTaskFilter;
    maxConcurrentTasks?: number; // New option
};

export function init(options: InitOptions): void {
    const {
        runCronTasks,
        cronTaskFilter,
        cronExpressionParserOptions,
        onError,
        onInfo,
        cronTaskCaller,
        maxConcurrentTasks = 1, // Default to 1 if not provided
    } = options;

    if (cronExpressionParserOptions.endDate) {
        throw new Error("The 'endDate' parameter of the cron-parser package is not supported yet.");
    }
    state.shouldRun = runCronTasks;
    _onError = onError;
    _onInfo = onInfo;
    _taskCaller = cronTaskCaller;
    _taskFilter = cronTaskFilter;
    state.cronExpressionParserOptions = cronExpressionParserOptions;
    state.maxConcurrentTasks = Math.max(1, maxConcurrentTasks); // Ensure at least 1
    state.activeTasksCount = 0;
    state.isAttemptingToRunTasks = false;
}

function ensureStarted(): void {
    if (state.nextScheduledCheckTimeoutId) {
        clearTimeout(state.nextScheduledCheckTimeoutId);
        state.nextScheduledCheckTimeoutId = null;
        // debug('EnsureStarted: Cleared pending scheduled check.');
    }
    // debug('EnsureStarted: Triggering orchestrateTaskExecution.');
    orchestrateTaskExecution();
}

export function stopCronTasks(): void {
    // debug('STOPPING CRON TASKS');
    state.shouldRun = false;
    if (state.nextScheduledCheckTimeoutId) {
        clearTimeout(state.nextScheduledCheckTimeoutId);
        state.nextScheduledCheckTimeoutId = null;
    }
    // Active tasks will complete. New non-enforced tasks won't be picked up.
}

export function startCronTasks(): void {
    // debug('STARTING CRON TASKS');
    state.shouldRun = true;
    ensureStarted();
}

export async function scheduleCronTaskImmediately(taskId: TaskId): Promise<void> {
    const { matchedCount } = await state.collection.updateOne({ _id: taskId }, { $set: { runImmediately: true } });
    if (!matchedCount) {
        throw new Error(`No task with id "${taskId}" is registered.`);
    }
    // debug(`Task ${taskId} scheduled immediately.`);
    if (state.shouldRun && state.tasks.has(taskId)) {
        ensureStarted(); // Trigger orchestration to pick it up
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

    state.tasks.set(taskId, { taskId, task, intervalFunction });
    // debug(`Task ${taskId} has been registered. Next run: ${nextRun.toISOString()}`);

    await ensureIndex();
    if (state.shouldRun) {
        ensureStarted(); // Potentially start processing if slots are available
    }
}
