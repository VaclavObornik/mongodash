import * as _debug from 'debug';
import { Document, Filter, FindOptions } from 'mongodb';
import { createContinuousLock } from '../createContinuousLock';
import { onError } from '../OnError';
import { onInfo } from '../OnInfo';
import { compileWatchProjection } from './compileWatchProjection';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import {
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_LOCK_LOST,
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
        let lockLost = false;
        // Set by the outer flow once the continuous-lock is stopped; used by
        // markCompleted below so we can halt renewal *before* the finalize
        // write changes nextRunAt. Without this the next CAS renewal would
        // see its expected value no longer present and falsely report
        // onLockLost for a completion the same worker performed.
        let stopLock: () => Promise<void> = async () => {};

        const finalizeTaskSuccess = async (duration: number, session?: import('mongodb').ClientSession) => {
            if (lockLost) {
                // Lock was stolen mid-handler. The new owner's claim rewrote
                // nextRunAt; writing completion here would either clobber that
                // claim or violate the at-least-once contract by marking the
                // task complete before the new owner finishes.
                return;
            }
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

                // Stop the continuous-lock renewal *before* finalize writes a
                // new nextRunAt. Otherwise an in-flight renewal CAS would see
                // its expected value overwritten and report a false
                // onLockLost for a completion the same worker performed.
                await stopLock();

                try {
                    await finalizeTaskSuccess(duration, options?.session);
                } catch (error) {
                    isManuallyFinalized = false;
                    throw error;
                }
            },
        };

        stopLock = createContinuousLock(tasksCollection, taskRecord._id, 'nextRunAt', this.internalOptions.visibilityTimeoutMs, {
            expectedInitialValue: taskRecord.nextRunAt,
            onLockLost: () => {
                lockLost = true;
                this.metricsCollector?.recordLockLost(taskRecord.task);
                onInfo({
                    message: `Reactive task '${taskRecord.task}' lock lost - another worker took over (likely visibility timeout elapsed). Skipping finalize to preserve new claim.`,
                    taskId: taskRecord._id.toString(),
                    code: CODE_REACTIVE_TASK_LOCK_LOST,
                });
            },
        });

        const processTheTask = async () => {
            const start = Date.now();
            onInfo({
                message: `Reactive task '${taskRecord.task}' started.`,
                taskId: taskRecord._id.toString(),
                code: CODE_REACTIVE_TASK_STARTED,
            });

            try {
                await taskDef.handler(context);

                const duration = Date.now() - start;
                onInfo({
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
                    onInfo({
                        message: `Reactive task '${taskRecord.task}' finished in ${duration}ms (skipped - filter mismatch).`,
                        taskId: taskRecord._id.toString(),
                        code: CODE_REACTIVE_TASK_FINISHED,
                        duration,
                    });
                    // Treat as success
                    return;
                }

                onError(err as Error);

                const duration = Date.now() - start;
                const reason = err instanceof Error ? err.message : `${err}`;
                onInfo({
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

            if (lockLost) {
                // Another worker took over this task. Skip state transitions to
                // avoid stomping on the new owner's updates. Side effects done
                // by the handler have executed (at-least-once), the replacement
                // worker will run the task again and finalize it.
                return;
            }

            if (deferredTo) {
                if (isManuallyFinalized) {
                    onInfo({
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

            if (lockLost) {
                // Skip both metrics and finalize: the new owner will execute
                // and record its own metrics. See the success branch above
                // for the reasoning behind skipping finalize.
                return;
            }

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
