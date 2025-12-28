import { Collection, Document, Filter, FindOptions, ObjectId, ResumeToken, WithId } from 'mongodb';
import type { ReactiveTaskRetryStrategy } from './ReactiveTaskRetryStrategy';

/**
 * Represents the status of a task in the database.
 */
export type ReactiveTaskStatus =
    | 'pending' // Waiting for processing
    | 'processing' // Currently being processed by a worker
    | 'processing_dirty' // Being processed, but new data arrived in the meantime
    | 'completed' // Successfully completed
    | 'failed'; // Failed after all attempts (Dead Letter Queue)

/**
 * Defines when orphaned task records should be deleted.
 */
export type CleanupDeleteWhen =
    | 'sourceDocumentDeleted' // Delete when source doc is deleted (default)
    | 'sourceDocumentDeletedOrNoLongerMatching' // Delete when source deleted OR filter no longer matches
    | 'never'; // Never auto-delete

/**
 * Configuration for automatic cleanup of orphaned task records.
 */
export interface CleanupPolicy {
    /**
     * When to delete orphaned task records.
     * Default: 'sourceDocumentDeleted'
     */
    deleteWhen?: CleanupDeleteWhen;
    /**
     * How long to keep task records after the deletion condition is met.
     * Accepts duration strings ('24h', '7d') or milliseconds.
     * Default: '24h'
     */
    keepFor?: string | number;
}

/**
 * Structure of the task document stored in the `_tasks` collection.
 */
export interface ReactiveTaskRecord<T = Document> {
    _id: string | ObjectId; // Deterministic ID (e.g. "task_TASK-NAME_DOCUMENT-ID") or ObjectId
    task: string; // Name of the task (worker)
    sourceDocId: WithId<T>['_id']; // ID of the original document
    status: ReactiveTaskStatus;
    attempts: number; // Number of processing attempts
    scheduledAt: Date; // When the task should be executed (for debouncing/retry)
    createdAt: Date; // When the task was first created
    updatedAt: Date; // When the task was last updated (new data)
    startedAt?: Date | null; // When the worker started processing
    completedAt?: Date | null; // When the task was completed
    lockExpiresAt?: Date | null; // "Visibility Timeout" - while locked by a worker
    firstErrorAt?: Date | null; // When the finding frequency started (first error in sequence)
    lastError?: string | null; // Last error that occurred
    lastFinalizedAt?: Date | null; // When the task was last finalized (completed or failed)
    initialScheduledAt?: Date | null; // Original scheduled time (if current `scheduledAt` is deferred)
    lastObservedValues?: Record<string, unknown> | null; // Values of watched fields from the last run
    lastSuccess?: {
        at: Date;
        durationMs: number;
    } | null;
    executionHistory?: Array<{
        at: Date;
        status: 'completed' | 'failed';
        durationMs: number;
        error?: string;
    }>;
}

export interface MetaDocument {
    _id: string;
    lock?: {
        expiresAt: Date;
        instanceId: string;
    };
    streamState?: {
        resumeToken: ResumeToken;
        lastClusterTime?: Date;
    };
    reconciliation?: {
        [taskName: string]: boolean; // true if reconciled
    };
    reconciliationState?: {
        [collectionName: string]: {
            lastId: unknown; // The last _id successfully processed
            taskNames: string[]; // The exact set of tasks being reconciled (snapshot)
            updatedAt: Date; // Timestamp of last checkpoint
        };
    };
    tasks?: {
        [taskName: string]: {
            triggerConfig: {
                filter: Document;
                watchProjection: Document;
            };
            handlerVersion: number;
        };
    };
    lastReconciledAt?: Date;
    lastCleanupAt?: Date;
}

export interface RegistryDocument {
    _id: string;
    instances: Array<{
        id: string;
        lastSeen: Date | string; // Date or $$NOW string
        metrics: unknown; // MetricObjectWithValues[]
    }>;
}

/**
 * Error thrown when `getDocument` fails because the document no longer matches the filter
 * or has been deleted. The worker will catch this and mark the task as skipped (success).
 */
export class TaskConditionFailedError extends Error {
    constructor(message = 'Document no longer matches filter or not found') {
        super(message);
        this.name = 'TaskConditionFailedError';
    }
}

/**
 * Context passed to the task handler.
 * It provides access to the source document ID, snapshot data, fetching logic, and flow control.
 */
export interface ReactiveTaskContext<T = Document> {
    // --- Identity & Data ---
    /** The ID of the source document to process. */
    docId: WithId<T>['_id'];

    /**
     * The snapshot of fields that were observed when the task was triggered.
     * Useful for debugging or decision logic without fetching the full document.
     */
    watchedValues: Record<string, unknown> | null;

    // --- Retrieval ---
    /**
     * Atomically fetches the source document.
     * Applies the task's `filter` logic to ensure the document still matches.
     *
     * @example
     * ```ts
     * const doc = await context.getDocument({ session });
     * ```
     *
     * @param options MongoDB FindOptions (allows passing `session` for transactions, projection, etc.).
     * @throws TaskConditionFailedError if document is not found or mismatch.
     */
    getDocument(options?: FindOptions): Promise<T>;

    // --- Flow Control ---
    /**
     * Defers the task execution to a later time.
     * The task will remain 'pending' (or effectively so) until the specified time.
     * Use this for temporary external failures (e.g. rate limits) or to postpone processing.
     * This preserves the original `scheduledAt` for global lag calculation.
     */
    deferCurrent(delay: number | Date): void;
    /**
     * Pauses ALL tasks of this type (on this instance only) until the specified time.
     * Useful for instance-local backoff (e.g. rate limits), but note that other instances will continue processing.
     *
     * The current task will be marked as successful unless you also call `deferCurrent()` or throw an error.
     */
    throttleAll(until: number | Date): void;

    // --- Transaction Support ---
    /**
     * Atomically marks the task as completed within the provided MongoDB Transaction.
     * Use this to ensure that the task status update is committed atomically with your business logic.
     *
     * If you call this method, the library will NOT perform the automatic finalization step.
     *
     * @param options.session The MongoDB ClientSession where the transaction is active.
     */
    markCompleted(options?: { session?: import('mongodb').ClientSession }): Promise<void>;
}

/**
 * Worker function provided by the user.
 */
export type ReactiveTaskHandler<T = Document> = (context: ReactiveTaskContext<T>) => Promise<void>;

export type RetryPolicy = {
    /**
     * Maximum number of attempts before marking as 'failed'.
     * Includes the first run (e.g. 1 means "try once, do not retry").
     * Set to -1 for infinite attempts.
     * Default: 5 (if maxDuration is not set)
     */
    maxAttempts?: number;
    /**
     * Maximum duration since the *first* failure in the current sequence.
     * If the task is still failing after this time window, it is marked as 'failed'.
     * Example: '24h', '30m'
     */
    maxDuration?: string;
    /**
     * If true, resets the retry history (including `firstErrorAt`) when the task data changes.
     * Default: true
     */
    resetRetriesOnDataChange?: boolean;
} & (
    | {
          type: 'exponential';
          min: number | string;
          max: number | string;
          factor?: number;
      }
    | { type: 'linear'; interval: string }
    | { type: 'fixed'; interval: string }
    | { type: 'series'; intervals: string[] }
    | { type: 'cron'; expression: string }
);

export interface EvolutionConfig {
    /**
     * Version of the task handler logic.
     * Default: 1
     */
    handlerVersion?: number;
    /**
     * Policy to apply when the handler version increases.
     * - 'none': Do nothing.
     * - 'reprocess_failed': Reset 'failed' tasks to 'pending'.
     * - 'reprocess_all': Reset ALL tasks (completed & failed) to 'pending'.
     * Default: 'none'
     */
    onHandlerVersionChange?: 'none' | 'reprocess_failed' | 'reprocess_all';
    /**
     * Whether to trigger reconciliation when the trigger configuration (filter/watchProjection) changes.
     * Default: true
     */
    reconcileOnTriggerChange?: boolean;
}

export interface ReactiveTask<T extends Document> {
    collection: string | Collection<T>;
    task: string;
    watchProjection?: NonNullable<Parameters<Collection<T>['find']>[1]>['projection'];
    /**
     * Aggregation Expression (e.g. { $eq: ['$status', 'active'] }) OR Standard Query (e.g. { status: 'active' }).
     * Standard queries are automatically converted to Aggregation Expressions.
     */
    filter?: Filter<T>;
    handler: ReactiveTaskHandler<T>;
    /** Time (ms) or interval description (e.g. "500ms", "1s") to postpone `scheduledAt` on change (Debouncing). Default: 1000ms */
    debounce?: number | string;
    /** Retry Policy configuration */
    retryPolicy?: RetryPolicy;
    /**
     * Number of execution history entries to keep.
     * Default: 5
     */
    executionHistoryLimit?: number;
    /**
     * Evolution configuration for handling changes to task definitions across deployments.
     */
    evolution?: EvolutionConfig;
    /**
     * Cleanup policy for orphaned task records.
     * Controls when and how task records are automatically deleted.
     */
    cleanupPolicy?: CleanupPolicy;
}

export type ReactiveTaskInternal<T extends Document> = Omit<ReactiveTask<T>, 'collection'> & {
    sourceCollection: Collection<T>;
    tasksCollection: Collection<ReactiveTaskRecord<T>>;
    initPromise: Promise<void>;
    debounceMs: number;
    retryStrategy: ReactiveTaskRetryStrategy;
    executionHistoryLimit: number;
    cleanupPolicyParsed: {
        deleteWhen: CleanupDeleteWhen;
        keepForMs: number;
    };
    repository: import('./ReactiveTaskRepository').ReactiveTaskRepository<T>;
};

/**
 * Configuration options for the scheduler.
 */
export interface ReactiveTaskSchedulerOptions {
    /**
     * Optional unique identifier for this scheduler instance.
     * Used for leader election, metrics aggregation, and debugging.
     * If not provided, a random ObjectId hex string will be generated.
     */
    instanceId?: string;
    /** Number of concurrent workers polling the DB. */
    reactiveTaskConcurrency: number;
    /** Optional caller to wrap task execution (e.g. for context propagation). */
    reactiveTaskCaller?: ReactiveTaskCaller;
    /** Optional filter to restrict which tasks this worker processes. */
    reactiveTaskFilter?: ReactiveTaskFilter;
    /**
     * Monitoring configuration options.
     */
    monitoring?: {
        /**
         * Enable/disable metrics collection.
         * Default: true
         */
        enabled?: boolean;
        /**
         * How often workers push local metrics to the global registry (ms).
         * Default: 60000 (1m)
         */
        pushIntervalMs?: number;
        /**
         * Controls which set of metrics to return.
         * Default: 'cluster'
         */
        scrapeMode?: 'local' | 'cluster';
        /**
         * Read preference for fetching the global registry and global stats.
         * Default: 'secondaryPreferred'
         */
        readPreference?: 'primary' | 'primaryPreferred' | 'secondary' | 'secondaryPreferred' | 'nearest';
    };
    /**
     * How often to run periodic cleanup of orphaned task records.
     * Accepts duration strings ('24h'), milliseconds, or cron expressions ('0 3 * * *').
     * Default: '24h'
     */
    reactiveTaskCleanupInterval?: number | string;
}

/**
 * Filter function to restrict which tasks are processed by the worker.
 */
export interface ReactiveTaskFilter {
    ({ task }: { task: string }): boolean;
}

/**
 * Caller function to wrap task execution.
 */
export interface ReactiveTaskCaller {
    <T>(task: () => Promise<T>): Promise<T> | T;
}

export const CODE_REACTIVE_TASK_STARTED = 'reactiveTaskStarted';
export const CODE_REACTIVE_TASK_FINISHED = 'reactiveTaskFinished';
export const CODE_REACTIVE_TASK_FAILED = 'reactiveTaskFailed';

export const CODE_REACTIVE_TASK_PLANNER_STARTED = 'reactiveTaskPlannerStarted';
export const CODE_REACTIVE_TASK_PLANNER_STOPPED = 'reactiveTaskPlannerStopped';
export const CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED = 'reactiveTaskPlannerReconciliationStarted';
export const CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED = 'reactiveTaskPlannerReconciliationFinished';
export const CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR = 'reactiveTaskPlannerStreamError';
export const CODE_REACTIVE_TASK_LEADER_LOCK_LOST = 'reactiveTaskLeaderLockLost';
export const CODE_REACTIVE_TASK_INITIALIZED = 'reactiveTaskInitialized';
export const CODE_REACTIVE_TASK_CLEANUP = 'reactiveTaskCleanup';
export const CODE_MANUAL_TRIGGER = 'manualTrigger';
export const REACTIVE_TASK_META_DOC_ID = '_mongodash_planner_meta';

/**
 * Filter for querying tasks.
 * All fields are optional and operate as AND conditions.
 */
export interface ReactiveTaskQuery<T = unknown> {
    /** Filter by specific task name(s) */
    task?: string | string[];

    /** Filter by task record ID */
    _id?: string | ObjectId | string[] | ObjectId[];

    /** Filter by task status */
    status?: ReactiveTaskStatus | ReactiveTaskStatus[];

    /**
     * Filter by Source Document fields.
     * This allows finding tasks based on the state of the original document.
     *
     * Examples:
     * - `{ _id: 'user-123' }` -> Find tasks for specific doc.
     * - `{ region: 'EU', active: true }` -> Find tasks for all active EU docs.
     */
    sourceDocFilter?: Filter<T>;

    /** Search in lastError message (regex or text search) */
    errorMessage?: string | RegExp;

    /** Filter to tasks that have a lastError (true) or don't (false) */
    hasError?: boolean;
}

export interface PaginationOptions {
    limit?: number;
    skip?: number;
    sort?: { field: keyof ReactiveTaskRecord; direction: 1 | -1 };
}

export interface PagedResult<T> {
    items: T[];
    total: number;
    limit: number;
    offset: number;
}

/**
 * Statistical summary of tasks matching a filter.
 */
export interface ReactiveTaskStatsOptions {
    readPreference?: import('mongodb').ReadPreferenceLike;
    groupByTask?: boolean;
    includeStatusCounts?: boolean;
    includeErrorCount?: boolean;
    includeGlobalLag?: boolean;
}

export interface ReactiveTaskStatsResult {
    statuses: { _id: string | { task: string; status: string }; count: number }[];
    errorCount?: number;
    errorCounts?: { _id: string; count: number }[];
    globalLag?: { _id: string; minScheduledAt: Date | null }[];
}
