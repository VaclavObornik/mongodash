import * as _debug from 'debug';
import { Document } from 'mongodb';
import { compileWatchProjection } from './compileWatchProjection';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';

const debug = _debug('mongodash:reactiveTasks:ops');

/** Keys of the unique index that the planning `$merge` legitimately races on. */
const PLANNING_UNIQUE_KEYS = ['sourceDocId', 'task'];
/** Default name MongoDB gives that index, as it appears in a duplicate-key message. */
const PLANNING_INDEX_NAME = /sourceDocId_1_task_1/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPlanningUniqueViolation(err: any): boolean {
    if (err?.code !== 11000 && err?.code !== 11001) return false;
    // Without a keyPattern we cannot tell which index was hit; treat it as the
    // planning index only if the message names both of its fields, so an
    // unrelated unique index is never silently swallowed.
    const pattern = err.keyPattern ?? err.keyValue;
    if (pattern && typeof pattern === 'object') {
        const keys = Object.keys(pattern);
        return keys.length === PLANNING_UNIQUE_KEYS.length && PLANNING_UNIQUE_KEYS.every((k) => keys.includes(k));
    }
    const message = String(err.errmsg ?? err.message ?? '');
    // Prefer the index name MongoDB reports; fall back to whole-word matches so
    // an app index on e.g. `taskType` is not mistaken for `task`.
    return PLANNING_INDEX_NAME.test(message) || PLANNING_UNIQUE_KEYS.every((k) => new RegExp(`\\b${k}\\b`).test(message));
}

/**
 * True only for the expected duplicate-key race on the `{ sourceDocId, task }`
 * index that `$merge` relies on. Any other unique-index violation (an
 * application-created index, an `_id` collision) is a real error and must
 * surface rather than be retried and swallowed.
 */
export function isDuplicateKeyError(error: unknown): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const err = error as any;
    if (!err) return false;
    if (isPlanningUniqueViolation(err)) return true;
    if (Array.isArray(err.writeErrors) && err.writeErrors.some((we: unknown) => isPlanningUniqueViolation(we))) return true;
    return false;
}

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

    private _forceDebounceMs?: number;

    public setForceDebounce(debounceMs: number | undefined) {
        this._forceDebounceMs = debounceMs;
    }

    public get forceDebounceMs(): number | undefined {
        return this._forceDebounceMs;
    }

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
            debug(`Pipeline empty for ${collectionName}(allowedTasks: ${allowedTaskNames ? Array.from(allowedTaskNames).join(',') : 'all'})`);
            return;
        }

        debug(`Executing pipeline for ${collectionName} handling ${sourceDocIds.length} docs`);

        // The $merge (whenNotMatched:'insert') is not atomic between its
        // match-check and insert. When the live change stream and a reconcile
        // scan plan the same freshly-inserted (task, sourceDocId) concurrently,
        // one $merge collides with the unique index and throws E11000. That is a
        // benign race - the unique index preserved correctness and the task
        // exists - so retry: the colliding document now takes the whenMatched
        // path, which is a no-op when nothing changed.
        const maxAttempts = 3;
        for (let attempt = 1; ; attempt++) {
            try {
                await entry.sourceCollection.aggregate(pipeline).toArray();
                debug(`Pipeline executed successfully for ${collectionName}`);
                break;
            } catch (error) {
                if (isDuplicateKeyError(error)) {
                    if (attempt < maxAttempts) {
                        debug(`Duplicate key during planning for ${collectionName} (benign race), retry ${attempt}.`);
                        continue;
                    }
                    // Persisting past the retries is no longer "benign" in any
                    // useful sense: $merge is not atomic across documents, so an
                    // abort can leave part of the batch unwritten. Swallowing it
                    // would let the caller advance its resume token / checkpoint
                    // past documents that were never planned - silent loss that
                    // only a later full reconcile could heal. Fail the flush
                    // instead: the token stays put and the batch is replayed.
                    // The flapping this could cause is bounded, since getting
                    // here needs `maxAttempts` consecutive collisions.
                    throw new Error(
                        `ReactiveTasks: planning for '${collectionName}' still hit a duplicate key after ${attempt} attempts; ` +
                            `not all tasks in this batch could be planned. Original: ${(error as Error)?.message}`,
                    );
                }
                debug(`Error executing pipeline for ${collectionName}: `, error);
                throw error;
            }
        }

        // Notify that tasks have been planned
        for (const task of entry.tasks.values()) {
            if (allowedTaskNames && !allowedTaskNames.has(task.task)) continue;
            // Use effective debounce
            const effectiveDebounce = this.forceDebounceMs !== undefined ? this.forceDebounceMs : task.debounceMs;
            this.onTaskPlanned(task.tasksCollection.collectionName, effectiveDebounce);
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
                                debounceMs: this.forceDebounceMs !== undefined ? this.forceDebounceMs : task.debounceMs,
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
                    nextRunAt: { $add: ['$$NOW', '$tasks.debounceMs'] },
                    dueAt: { $add: ['$$NOW', '$tasks.debounceMs'] },
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
                                dueAt: {
                                    $cond: {
                                        if: '$hasChanged',
                                        then: '$$new.dueAt', // Always reset dueAt for the new version
                                        else: '$dueAt',
                                    },
                                },
                                nextRunAt: {
                                    $cond: {
                                        if: '$hasChanged',
                                        then: {
                                            $cond: {
                                                if: { $in: ['$status', ['processing', 'processing_dirty']] },
                                                then: '$nextRunAt',
                                                else: '$$new.nextRunAt',
                                            },
                                        },
                                        else: '$nextRunAt',
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
