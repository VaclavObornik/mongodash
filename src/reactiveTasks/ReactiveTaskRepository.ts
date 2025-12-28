import { Collection, Document, Filter, UpdateFilter } from 'mongodb';
import { CompatibleBulkWriteOptions, CompatibleFindOneAndUpdateOptions, CompatibleModifyResult } from '../mongoCompatibility';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { processInBatches } from '../processInBatches';
import { ReactiveTaskRetryStrategy } from './ReactiveTaskRetryStrategy';
import {
    CleanupDeleteWhen,
    CODE_REACTIVE_TASK_CLEANUP,
    ReactiveTaskInternal,
    ReactiveTaskRecord,
    ReactiveTaskStatsOptions,
    ReactiveTaskStatsResult,
} from './ReactiveTaskTypes';

/**
 * Handles all database interactions for reactive tasks.
 *
 * Responsibilities:
 * - Generates MongoDB operations for creating, updating, and deleting tasks.
 * - Manages task state transitions (pending -> processing -> completed/failed).
 * - Implements the locking mechanism for task execution.
 * - Handles task finalization (retries, completion, failure).
 * - Manages database indexes for performance.
 * - Cleans up orphaned tasks.
 */
export class ReactiveTaskRepository<T extends Document> {
    readonly initPromise: Promise<void>;

    constructor(
        private tasksCollection: Collection<ReactiveTaskRecord<T>>,
        private onInfo: OnInfo = defaultOnInfo,
        private onError: OnError = defaultOnError,
    ) {
        this.initPromise = this.ensureIndexes();
    }

    public async findAndLockNextTask(taskDefs: ReactiveTaskInternal<T>[], options: { visibilityTimeoutMs: number }): Promise<ReactiveTaskRecord<T> | null> {
        const now = new Date();
        const nextRunAt = new Date(now.getTime() + options.visibilityTimeoutMs);

        const filter: Filter<ReactiveTaskRecord<T>> = {
            task: { $in: taskDefs.map((c) => c.task) },
            nextRunAt: { $lte: now, $type: 'date' },
        };

        const update: UpdateFilter<ReactiveTaskRecord<T>> = {
            $set: {
                status: 'processing',
                nextRunAt: nextRunAt,
                startedAt: now,
            },
            $inc: { attempts: 1 },
        };

        try {
            const result = await this.tasksCollection.findOneAndUpdate(filter, update, {
                sort: { nextRunAt: 1 },
                returnDocument: 'after',
                includeResultMetadata: true,
            } as CompatibleFindOneAndUpdateOptions);

            // In MongoDB v4, findOneAndUpdate returns { value: T } by default.
            // In MongoDB v6+, if includeResultMetadata: true, it returns { value: T }.
            // If we cast options to any, TS might infer return type as Document or ModifyResult depending on library version.
            // We treat 'result' as any or check strictly.
            // result is derived from findOneAndUpdate which is generic.

            // Should be safe to access .value if runtime behaves as expected.
            return (result as unknown as CompatibleModifyResult<ReactiveTaskRecord<T>>).value || null;
        } catch (error) {
            this.onError(error as Error);
            return null;
        }
    }

    public async finalizeTask(
        taskRecord: ReactiveTaskRecord<T>,
        strategy: ReactiveTaskRetryStrategy,
        error?: Error,
        debounceMs = 1000,
        executionStats?: { durationMs: number },
        executionHistoryLimit = 5,
        options?: { session?: import('mongodb').ClientSession },
    ): Promise<void> {
        const isError = !!error;
        const errorMessage = error?.message || 'Unknown error';

        // Determine First Error At
        let firstErrorAt = taskRecord.firstErrorAt;
        if (isError && !firstErrorAt) {
            firstErrorAt = new Date();
        } else if (!isError) {
            firstErrorAt = null; // Reset on success
        }

        const attempts = taskRecord.attempts || 0;
        const shouldFail = isError && strategy.shouldFail(attempts, firstErrorAt);
        const nextRetryScheduledAt = isError && !shouldFail ? strategy.calculateNextRetry(attempts) : null;

        const updateSet: Document = {
            status: {
                $cond: {
                    if: { $eq: ['$status', 'processing_dirty'] },
                    then: 'pending',
                    else: isError ? (shouldFail ? 'failed' : 'pending') : 'completed',
                },
            },
            nextRunAt: {
                $cond: {
                    if: { $eq: ['$status', 'processing_dirty'] },
                    then: { $add: ['$updatedAt', debounceMs] },
                    else: isError ? (shouldFail ? null : nextRetryScheduledAt) : null,
                },
            },
            completedAt: {
                $cond: {
                    if: { $eq: ['$status', 'processing_dirty'] },
                    then: '$completedAt',
                    else: isError ? '$completedAt' : new Date(),
                },
            },
            firstErrorAt: {
                $cond: {
                    if: { $eq: ['$status', 'processing_dirty'] },
                    then: '$firstErrorAt',
                    else: firstErrorAt,
                },
            },
            lastError: {
                $cond: {
                    if: { $eq: ['$status', 'processing_dirty'] },
                    then: '$lastError',
                    else: isError ? errorMessage : null,
                },
            },
            lastFinalizedAt: new Date(),
        };

        const durationMs = executionStats?.durationMs ?? 0;
        const historyEntry = {
            at: new Date(),
            status: isError ? 'failed' : 'completed',
            durationMs: durationMs,
            ...(isError ? { error: errorMessage } : {}),
        };

        if (!isError) {
            updateSet.lastSuccess = {
                at: new Date(),
                durationMs: durationMs,
            };
        }

        await this.tasksCollection.updateOne(
            { _id: taskRecord._id },
            [
                {
                    $set: updateSet,
                },
                {
                    $set: {
                        executionHistory: {
                            $slice: [
                                {
                                    $concatArrays: [{ $ifNull: ['$executionHistory', []] }, [historyEntry]],
                                },
                                -executionHistoryLimit, // Keep last N
                            ],
                        },
                    },
                },
            ],
            options || {},
        );
    }

    public async deferTask(taskRecord: ReactiveTaskRecord<T>, delay: number | Date): Promise<void> {
        const now = Date.now();
        const nextRunAt = typeof delay === 'number' ? new Date(now + delay) : delay;
        // Keeping dueAt unchanged (it shouldn't change on deferral if we want to track original intent,
        // but if we want 'lag' to be reset, we would update it.
        // Based on plan: "Never changes" -> so we don't update dueAt here.
        // Wait, if we defer, we are explicitly saying "don't run yet".
        // In clean slate, dueAt is set at creation and never changes (unless strictly needed for lag reset).

        await this.tasksCollection.updateOne(
            { _id: taskRecord._id },
            {
                $set: {
                    status: 'pending',
                    nextRunAt: nextRunAt,
                    // dueAt: not changed
                    attempts: 0,
                },
            },
        );
    }

    public async executeBulkWrite(
        operations: Parameters<Collection<ReactiveTaskRecord<T>>['bulkWrite']>[0],
        options?: CompatibleBulkWriteOptions,
    ): Promise<void> {
        await this.tasksCollection.bulkWrite(operations, options || {});
    }

    public async findTasks(
        filter: Filter<ReactiveTaskRecord<T>>,
        options: { limit?: number; skip?: number; sort?: Record<string, 1 | -1> } = {},
    ): Promise<ReactiveTaskRecord<T>[]> {
        return this.tasksCollection.find(filter, options).toArray();
    }

    public async countTasks(filter: Filter<ReactiveTaskRecord<T>>): Promise<number> {
        return this.tasksCollection.countDocuments(filter);
    }

    public async updateTasks(
        filter: Filter<ReactiveTaskRecord<T>>,
        update: UpdateFilter<ReactiveTaskRecord<T>> | Document[],
    ): Promise<{ matchedCount: number; modifiedCount: number }> {
        const result = await this.tasksCollection.updateMany(filter, update);
        return {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
        };
    }

    public async resetTasks(filter: Filter<ReactiveTaskRecord<T>>): Promise<{ matchedCount: number; modifiedCount: number }> {
        const updatePipeline: Document[] = [
            {
                $set: {
                    updatedAt: '$$NOW',
                    status: {
                        $cond: {
                            if: { $in: ['$status', ['processing', 'processing_dirty']] },
                            then: 'processing_dirty',
                            else: 'pending',
                        },
                    },
                    nextRunAt: {
                        // If it was processing, keep it running (don't break lock) - wait, resetTasks usually implies "fix stuff".
                        // Logic: if processing/dirty -> keep nextRunAt (lock), else -> $$NOW.
                        // If we reset a stuck task, we want it to run NOW.
                        // If we reset a completed/failed task, we want it to run NOW.
                        $cond: {
                            if: { $in: ['$status', ['processing', 'processing_dirty']] },
                            then: '$nextRunAt', // Keep current timeout
                            else: '$$NOW', // Run immediately
                        },
                    },
                    // Preserve dueAt
                },
            },
        ];

        const result = await this.tasksCollection.updateMany(filter, updatePipeline);
        return {
            matchedCount: result.matchedCount,
            modifiedCount: result.modifiedCount,
        };
    }

    public async resetTasksForUpgrade(taskName: string, mode: 'failed' | 'all'): Promise<{ modifiedCount: number }> {
        const filter: Filter<ReactiveTaskRecord<T>> = { task: taskName };

        if (mode === 'failed') {
            filter.status = 'failed';
        } else if (mode === 'all') {
            filter.status = { $in: ['failed', 'completed'] };
        }

        // Use safe reset logic
        const result = await this.resetTasks(filter);
        return { modifiedCount: result.modifiedCount };
    }

    private async ensureIndexes(): Promise<void> {
        // Optimized index for findAndLockNextTask (ESR Rule Compliance)
        // 1. Equality: task (via $in)
        // 2. Sort: nextRunAt
        // 3. Range: nextRunAt ($lte)
        // Partial Index: only index tasks that are eligible to run (nextRunAt != null)
        await this.tasksCollection.createIndex(
            {
                task: 1,
                nextRunAt: 1,
            },
            {
                partialFilterExpression: { nextRunAt: { $type: 'date' } },
                name: 'polling_idx',
            },
        );

        // Unique index to ensure one task per task definition per source document
        await this.tasksCollection.createIndex({ sourceDocId: 1, task: 1 }, { unique: true });
    }

    /**
     * Periodically cleans up orphaned tasks that match the cleanupPolicy.
     * This runs on a schedule (e.g. hourly) in the Leader instance.
     */
    public async deleteOrphanedTasks(
        taskName: string,
        sourceCollectionName: string,
        taskFilter: Filter<Document>,
        cleanupPolicy: { deleteWhen: CleanupDeleteWhen; keepForMs: number },
        shouldStop: () => boolean,
        limitToSourceIds?: unknown[],
    ): Promise<void> {
        const { deleteWhen, keepForMs } = cleanupPolicy;

        if (deleteWhen === 'never') {
            return;
        }
        const cutoffDate = new Date(Date.now() - keepForMs);

        const matchStage: Document = {
            task: taskName,
            $expr: {
                $lt: [
                    {
                        $max: ['$updatedAt', { $ifNull: ['$lastFinalizedAt', '$createdAt'] }],
                    },
                    cutoffDate,
                ],
            },
        };

        if (limitToSourceIds && limitToSourceIds.length > 0) {
            matchStage.sourceDocId = { $in: limitToSourceIds };
        }

        const pipeline: Document[] = [
            {
                $match: matchStage,
            },
        ];

        // We need to determine if the source document is "gone" or "no longer matching".
        // Strategy:
        // 1. If deleteWhen === 'sourceDocumentDeleted', we just check if document exists by ID.
        // 2. If deleteWhen === 'sourceDocumentDeletedOrNoLongerMatching', we check if document exists AND matches filter.

        const lookupPipeline: Document[] = [{ $match: { $expr: { $eq: ['$_id', '$$sId'] } } }];

        if (deleteWhen === 'sourceDocumentDeletedOrNoLongerMatching' && Object.keys(taskFilter).length > 0) {
            // taskFilter (normalized) is an Expression body. Must wrap in $expr for $match.
            lookupPipeline.push({ $match: { $expr: taskFilter } });
        }

        pipeline.push(
            {
                $lookup: {
                    from: sourceCollectionName,
                    let: { sId: '$sourceDocId' },
                    pipeline: lookupPipeline,
                    as: 'orphanCheck',
                },
            },
            {
                $match: {
                    'orphanCheck.0': { $exists: false }, // If empty, it means it was deleted OR didn't match filter
                },
            },
            {
                $project: {
                    _id: 1,
                    orphanCheck: 1,
                },
            },
        );

        await processInBatches(
            this.tasksCollection,
            pipeline,
            (task) => task._id,
            async (batch) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await this.tasksCollection.deleteMany({ _id: { $in: batch as any } });
                this.onInfo({
                    message: `Cleaned up ${batch.length} orphaned tasks for '${taskName}'`,
                    code: CODE_REACTIVE_TASK_CLEANUP,
                    meta: { count: batch.length },
                });
            },
            { batchSize: 1000, shouldStop },
        );
    }

    public async getStatistics(filter: Filter<ReactiveTaskRecord<T>>, options: ReactiveTaskStatsOptions): Promise<ReactiveTaskStatsResult> {
        const pipeline: object[] = [];

        if (Object.keys(filter).length > 0) {
            pipeline.push({ $match: filter });
        }

        const facets: Record<string, object[]> = {};

        if (options.includeStatusCounts) {
            const groupId = options.groupByTask ? { task: '$task', status: '$status' } : '$status';
            facets.statuses = [{ $group: { _id: groupId, count: { $sum: 1 } } }];
        }

        if (options.includeErrorCount) {
            if (options.groupByTask) {
                facets.errorCounts = [{ $match: { lastError: { $exists: true, $ne: null } } }, { $group: { _id: '$task', count: { $sum: 1 } } }];
            } else {
                facets.errorCount = [{ $match: { lastError: { $exists: true, $ne: null } } }, { $count: 'count' }];
            }
        }

        if (options.includeGlobalLag) {
            facets.globalLag = [{ $match: { status: 'pending' } }, { $group: { _id: '$task', minScheduledAt: { $min: '$dueAt' } } }];
        }

        pipeline.push({ $facet: facets });

        const projection: Record<string, unknown> = { statuses: 1 };

        if (options.includeErrorCount) {
            if (options.groupByTask) {
                projection.errorCounts = 1;
            } else {
                projection.errorCount = { $ifNull: [{ $arrayElemAt: ['$errorCount.count', 0] }, 0] };
            }
        }

        if (options.includeGlobalLag) {
            projection.globalLag = 1;
        }

        pipeline.push({ $project: projection });

        const [result] = await this.tasksCollection.aggregate<ReactiveTaskStatsResult>(pipeline, { readPreference: options.readPreference }).toArray();

        return (
            result || {
                statuses: [],
                errorCount: options.includeErrorCount ? 0 : undefined,
                globalLag: options.includeGlobalLag ? [] : undefined,
            }
        );
    }
}
