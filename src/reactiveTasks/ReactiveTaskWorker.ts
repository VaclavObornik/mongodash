import * as _debug from 'debug';
import { Collection, Document, Filter, FindOptions } from 'mongodb';
import { createContinuousLock } from '../createContinuousLock';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { compileWatchProjection } from './compileWatchProjection';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import {
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_STARTED,
    ReactiveTaskCaller,
    ReactiveTaskContext,
    ReactiveTaskFilter,
    ReactiveTaskRecord,
    TaskConditionFailedError,
} from './ReactiveTaskTypes';

import { MetricsCollector } from './MetricsCollector';

export interface WorkerCallbacks {
    onTaskFound: (collectionName: string) => void;
}

const debug = _debug('mongodash:reactiveTasks:worker');

/**
 * Responsible for executing reactive tasks.
 *
 * Responsibilities:
 * - Polls for pending tasks from the database.
 * - Applies filtering to restrict which tasks this worker processes.
 * - Locks tasks during execution to prevent concurrent processing.
 * - Fetches the source document and executes the user-defined handler.
 * - Handles task completion, failure, retries, and dead-letter queueing.
 * - Manages the visibility timeout lock extension.
 */
export class ReactiveTaskWorker {
    private taskCaller: ReactiveTaskCaller;
    private throttledUntil = new Map<string, Date>();

    constructor(
        private instanceId: string,
        private registry: ReactiveTaskRegistry,
        private callbacks: WorkerCallbacks,
        private internalOptions: { visibilityTimeoutMs: number } = { visibilityTimeoutMs: 300000 },
        taskCaller?: ReactiveTaskCaller,
        private taskFilter?: ReactiveTaskFilter,
        private onInfo: OnInfo = defaultOnInfo,
        private onError: OnError = defaultOnError,
        private metricsCollector?: MetricsCollector,
    ) {
        this.taskCaller = taskCaller || ((task) => task());
    }

    public async tryRunATask(collectionName: string): Promise<void> {
        const entry = this.registry.getEntry(collectionName);

        let tasks = this.registry.getAllTasks();
        if (this.taskFilter) {
            tasks = tasks.filter((t) => this.taskFilter!({ task: t.task }));
        }
        if (!tasks.length) {
            return;
        }

        // Filter out throttled tasks
        const now = Date.now();
        tasks = tasks.filter((t) => {
            const until = this.throttledUntil.get(t.task);
            if (until && until.getTime() > now) {
                return false;
            }
            if (until) {
                this.throttledUntil.delete(t.task); // Cleanup expired throttle
            }
            return true;
        });

        if (!tasks.length) {
            return;
        }

        const taskRecord = await entry.repository.findAndLockNextTask(tasks, {
            visibilityTimeoutMs: this.internalOptions.visibilityTimeoutMs,
        });
        if (taskRecord) {
            this.callbacks.onTaskFound(collectionName);
            await this.processTask(taskRecord);
        }
    }

    private async processTask(taskRecord: ReactiveTaskRecord<Document>): Promise<void> {
        const taskDef = this.registry.getTask(taskRecord.task)!;
        const tasksCollection = taskDef.tasksCollection;

        let deferredTo: Date | undefined;
        let throttledUntil: Date | undefined;

        let isManuallyFinalized = false;

        const finalizeTaskSuccess = async (duration: number, session?: import('mongodb').ClientSession) => {
            this.metricsCollector?.recordTaskExecution(taskRecord.task, 'success', duration);

            const entry = this.registry.getEntry(tasksCollection.collectionName);
            await entry.repository.finalizeTask(
                taskRecord,
                taskDef.retryStrategy,
                undefined,
                taskDef.debounceMs,
                { durationMs: duration },
                taskDef.executionHistoryLimit,
                session ? { session } : undefined,
            );
        };

        const context: ReactiveTaskContext<Document> = {
            docId: taskRecord.sourceDocId,
            watchedValues: taskRecord.lastObservedValues || null,
            getDocument: async (options?: FindOptions) => {
                const queryConditions: Filter<Document>[] = [{ _id: taskRecord.sourceDocId }];
                if (taskDef.filter) {
                    queryConditions.push({ $expr: taskDef.filter });
                }

                if (taskRecord.lastObservedValues && Object.keys(taskRecord.lastObservedValues).length > 0) {
                    // Optimistic Locking: Ensure watched values match what triggered the task
                    // We use the same projection logic as the planner to compare current DB state vs snapshot
                    const projectionExpr = compileWatchProjection(taskDef.watchProjection);
                    queryConditions.push({ $expr: { $eq: [projectionExpr, taskRecord.lastObservedValues] } });
                }

                const query = (queryConditions.length > 1 ? { $and: queryConditions } : queryConditions[0]) as Filter<Document>;
                const sourceDoc = await taskDef.sourceCollection.findOne(query, options);

                if (!sourceDoc) {
                    throw new TaskConditionFailedError();
                }

                return sourceDoc;
            },
            deferCurrent: (delay: number | Date) => {
                deferredTo = typeof delay === 'number' ? new Date(Date.now() + delay) : delay;
            },
            throttleAll: (until: number | Date) => {
                throttledUntil = typeof until === 'number' ? new Date(Date.now() + until) : until;
            },
            markCompleted: async (options?: { session?: import('mongodb').ClientSession }) => {
                if (isManuallyFinalized) {
                    return; // Idempotent
                }

                isManuallyFinalized = true;
                const duration = Date.now() - start;

                try {
                    await finalizeTaskSuccess(duration, options?.session);
                } catch (error) {
                    isManuallyFinalized = false;
                    throw error;
                }
            },
        };

        const stopLock = createContinuousLock(
            tasksCollection as unknown as Collection<{ _id: string; lockExpiresAt: Date | null }>,
            taskRecord._id.toString(),
            'lockExpiresAt',
            this.internalOptions.visibilityTimeoutMs,
            (error) => {
                this.onError(error);
            },
        );

        const processTheTask = async () => {
            const start = Date.now();
            this.onInfo({
                message: `Reactive task '${taskRecord.task}' started.`,
                taskId: taskRecord._id.toString(),
                code: CODE_REACTIVE_TASK_STARTED,
            });

            try {
                await taskDef.handler(context);

                const duration = Date.now() - start;
                this.onInfo({
                    message: `Reactive task '${taskRecord.task}' finished in ${duration}ms.`,
                    taskId: taskRecord._id.toString(),
                    code: CODE_REACTIVE_TASK_FINISHED,
                    duration,
                });
            } catch (err) {
                if (err instanceof TaskConditionFailedError) {
                    const duration = Date.now() - start;
                    debug(
                        `[Scheduler ${this.instanceId}] Source document ${taskRecord.sourceDocId} not found or does not match filter for task ${taskRecord._id}. Marking as completed (skipped).`,
                    );
                    this.onInfo({
                        message: `Reactive task '${taskRecord.task}' finished in ${duration}ms (skipped - filter mismatch).`,
                        taskId: taskRecord._id.toString(),
                        code: CODE_REACTIVE_TASK_FINISHED,
                        duration,
                    });
                    // Treat as success
                    return;
                }

                const duration = Date.now() - start;
                const reason = err instanceof Error ? err.message : `${err}`;
                this.onInfo({
                    message: `Reactive task '${taskRecord.task}' failed in ${duration}ms.`,
                    taskId: taskRecord._id.toString(),
                    code: CODE_REACTIVE_TASK_FAILED,
                    reason,
                    duration,
                });
                throw err;
            }
        };

        const start = Date.now();

        if (taskRecord.attempts > 1) {
            this.metricsCollector?.recordRetry(taskRecord.task);
        }

        try {
            await this.taskCaller(processTheTask);
            await stopLock();
            const duration = Date.now() - start;

            if (throttledUntil) {
                this.throttledUntil.set(taskRecord.task, throttledUntil);
                debug(`[Scheduler ${this.instanceId}] Throttling task '${taskRecord.task}' until ${throttledUntil.toISOString()}`);
            }

            if (deferredTo) {
                if (isManuallyFinalized) {
                    this.onInfo({
                        message: `[ReactiveTask] Task '${taskRecord.task}' (ID: ${taskRecord._id}) was manually marked as completed, but deferCurrent() was also called. Ignoring defer request.`,
                        code: 'reactiveTaskDeferIgnored',
                        taskId: taskRecord._id.toString(),
                    });
                    return;
                }

                debug(`[Scheduler ${this.instanceId}] Deferring task '${taskRecord.task}' until ${deferredTo.toISOString()}`);
                const entry = this.registry.getEntry(tasksCollection.collectionName);
                await entry.repository.deferTask(taskRecord, deferredTo);
                return;
            }

            if (!isManuallyFinalized) {
                await finalizeTaskSuccess(duration);
            }
        } catch (error) {
            // Logging is already done in processTheTask via onInfo
            await stopLock();
            const duration = Date.now() - start;

            this.metricsCollector?.recordTaskExecution(taskRecord.task, 'failed', duration);

            const entry = this.registry.getEntry(tasksCollection.collectionName);

            await entry.repository.finalizeTask(
                taskRecord,
                taskDef.retryStrategy,
                error as Error,
                taskDef.debounceMs,
                { durationMs: duration },
                taskDef.executionHistoryLimit,
            );
        }
    }
}
