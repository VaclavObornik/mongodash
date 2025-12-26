import * as _debug from 'debug';
import { Document } from 'mongodb';
import { compileWatchProjection } from './compileWatchProjection';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';

const debug = _debug('mongodash:reactiveTasks:ops');

/**
 * Helper class for generating and executing reactive task operations.
 *
 * Responsibilities:
 * - Generates upsert operations for tasks based on source documents and task definitions.
 * - Executes bulk write operations to the task collections.
 * - Handles duplicate key errors gracefully (which can occur during reconciliation).
 * - Manages debouncing logic by tracking the minimum debounce time for planned tasks.
 */
export class ReactiveTaskOps {
    constructor(
        private registry: ReactiveTaskRegistry,
        private onTaskPlanned: (tasksCollectionName: string, debounceMs: number) => void,
    ) {}

    public async executePlanningPipeline(collectionName: string, sourceDocIds: unknown[], allowedTaskNames?: Set<string>): Promise<void> {
        debug(`executePlanningPipeline called for ${collectionName} with ${sourceDocIds.length} ids`);
        const entry = this.registry.getEntry(collectionName);
        if (!entry) {
            debug(`No entry found for collection ${collectionName}`);
            return;
        }

        const matchFilter = { _id: { $in: sourceDocIds } };
        const pipeline = this.generatePlanningPipeline(entry, matchFilter, allowedTaskNames);
        if (pipeline.length === 0) {
            debug(`Pipeline empty for ${collectionName} (allowedTasks: ${allowedTaskNames ? Array.from(allowedTaskNames).join(',') : 'all'})`);
            return;
        }

        debug(`Executing pipeline for ${collectionName} handling ${sourceDocIds.length} docs`);
        try {
            await entry.sourceCollection.aggregate(pipeline).toArray();

            debug(`Pipeline executed successfully for ${collectionName}`);

            // Notify that tasks have been planned
            for (const task of entry.tasks.values()) {
                if (allowedTaskNames && !allowedTaskNames.has(task.task)) continue;
                this.onTaskPlanned(task.tasksCollection.collectionName, task.debounceMs);
            }
        } catch (error) {
            debug(`Error executing pipeline for ${collectionName}:`, error);
            throw error;
        }
    }

    private generatePlanningPipeline(entry: ReturnType<ReactiveTaskRegistry['getEntry']>, matchFilter?: Document, allowedTaskNames?: Set<string>): Document[] {
        let tasks = Array.from(entry.tasks.values());

        if (allowedTaskNames) {
            tasks = tasks.filter((t) => allowedTaskNames.has(t.task));
        }

        if (tasks.length === 0) {
            return [];
        }

        const pipeline: Document[] = [
            { $match: matchFilter || {} },
            {
                $project: {
                    _id: 0,
                    sourceDocId: '$_id',
                    tasks: {
                        $filter: {
                            input: tasks.map((task) => ({
                                task: task.task,
                                matches: task.filter || true,
                                watchedValues: compileWatchProjection(task.watchProjection),
                                debounceMs: task.debounceMs,
                                resetRetriesOnDataChange: task.retryStrategy.policy.resetRetriesOnDataChange,
                            })),
                            as: 't',
                            cond: '$$t.matches',
                        },
                    },
                },
            },
            { $unwind: '$tasks' },
            {
                $project: {
                    sourceDocId: 1,
                    task: '$tasks.task',
                    lastObservedValues: '$tasks.watchedValues',
                    status: { $literal: 'pending' },
                    attempts: { $literal: 0 },
                    createdAt: '$$NOW',
                    updatedAt: '$$NOW',
                    scheduledAt: { $add: ['$$NOW', '$tasks.debounceMs'] },
                    resetRetriesOnDataChange: { $ifNull: ['$tasks.resetRetriesOnDataChange', true] },
                },
            },
            {
                $merge: {
                    into: entry.tasksCollection.collectionName,
                    on: ['task', 'sourceDocId'],
                    whenNotMatched: 'insert',
                    whenMatched: [
                        {
                            $set: {
                                hasChanged: { $ne: ['$lastObservedValues', '$$new.lastObservedValues'] },
                            },
                        },
                        {
                            $set: {
                                sourceDocId: '$$new.sourceDocId',
                                task: '$$new.task',
                                lastObservedValues: '$$new.lastObservedValues',
                                updatedAt: {
                                    $cond: { if: '$hasChanged', then: '$$new.updatedAt', else: '$updatedAt' },
                                },
                                firstErrorAt: {
                                    $cond: {
                                        if: '$hasChanged',
                                        then: {
                                            $cond: {
                                                if: '$$new.resetRetriesOnDataChange',
                                                then: null,
                                                else: '$firstErrorAt',
                                            },
                                        },
                                        else: '$firstErrorAt',
                                    },
                                },
                                lastError: {
                                    $cond: {
                                        if: '$hasChanged',
                                        then: {
                                            $cond: {
                                                if: '$$new.resetRetriesOnDataChange',
                                                then: null,
                                                else: '$lastError',
                                            },
                                        },
                                        else: '$lastError',
                                    },
                                },
                                status: {
                                    $cond: {
                                        if: '$hasChanged',
                                        then: {
                                            $cond: {
                                                if: { $in: ['$status', ['processing', 'processing_dirty']] },
                                                then: 'processing_dirty',
                                                else: 'pending',
                                            },
                                        },
                                        else: '$status',
                                    },
                                },
                                scheduledAt: {
                                    $cond: {
                                        if: '$hasChanged',
                                        then: {
                                            $cond: {
                                                if: { $in: ['$status', ['processing', 'processing_dirty']] },
                                                then: '$scheduledAt',
                                                else: '$$new.scheduledAt',
                                            },
                                        },
                                        else: '$scheduledAt',
                                    },
                                },
                                attempts: {
                                    $cond: { if: '$hasChanged', then: 0, else: '$attempts' },
                                },
                            },
                        },
                        { $unset: 'hasChanged' },
                    ],
                },
            },
        ];

        return pipeline;
    }
}
