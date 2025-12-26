import * as _debug from 'debug';
import { Document } from 'mongodb';
import type { Registry } from 'prom-client';
import { ConcurrentRunner } from '../ConcurrentRunner';
import { GlobalsCollection } from '../globalsCollection';
import { initPromise } from '../initPromise';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { createIntervalFunction } from '../parseInterval';
import { LeaderElector } from './LeaderElector';
import { MetricsCollector } from './MetricsCollector';
import { ReactiveTaskManager } from './ReactiveTaskManager';
import { ReactiveTaskPlanner } from './ReactiveTaskPlanner';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import {
    CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
    PagedResult,
    PaginationOptions,
    ReactiveTask,
    ReactiveTaskQuery,
    ReactiveTaskRecord,
    ReactiveTaskSchedulerOptions,
    REACTIVE_TASK_META_DOC_ID,
} from './ReactiveTaskTypes';
import { ReactiveTaskWorker } from './ReactiveTaskWorker';

const debug = _debug('mongodash:reactiveTasks');

// Re-export types for backward compatibility
export {
    CODE_REACTIVE_TASK_CLEANUP,
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_FINISHED,
    CODE_REACTIVE_TASK_INITIALIZED,
    CODE_REACTIVE_TASK_LEADER_LOCK_LOST,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STOPPED,
    CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
    CODE_REACTIVE_TASK_STARTED,
    PagedResult,
    PaginationOptions,
    ReactiveTask,
    ReactiveTaskCaller,
    ReactiveTaskFilter,
    ReactiveTaskHandler,
    ReactiveTaskQuery,
    ReactiveTaskRecord,
    ReactiveTaskSchedulerOptions,
    ReactiveTaskStatus,
    REACTIVE_TASK_META_DOC_ID,
    TaskConditionFailedError,
} from './ReactiveTaskTypes';
export { scheduler as _scheduler };

export type InitOptions = {
    onError: OnError;
    onInfo: OnInfo;
    globalsCollection: GlobalsCollection;
} & Partial<ReactiveTaskSchedulerOptions>;

let onError: OnError = defaultOnError;
let onInfo: OnInfo = defaultOnInfo;
let globalsCollection: GlobalsCollection;

/**
 * Main scheduler class implementing the described logic.
 */
/**
 * Main entry point for the Reactive Tasks system.
 *
 * Responsibilities:
 * - Orchestrates the initialization and configuration of the system.
 * - Manages the lifecycle of `LeaderElector`, `ReactiveTaskPlanner`, and `ReactiveTaskWorker`.
 * - Provides the public API for registering tasks and starting/stopping the system.
 * - Configures the `ConcurrentRunner` for worker execution.
 */
export class ReactiveTaskScheduler {
    private options: ReactiveTaskSchedulerOptions = {
        reactiveTaskConcurrency: 5,
    };

    // Registry for consumers and collections
    private registry = new ReactiveTaskRegistry();

    // Instance ID for this scheduler
    private _instanceId?: string;

    // Internal state
    private isRunning = false;

    private concurrentRunner: ConcurrentRunner | undefined;
    private leaderElector: LeaderElector | undefined;
    private taskPlanner: ReactiveTaskPlanner | undefined;
    private worker: ReactiveTaskWorker | undefined;
    private metricsCollector: MetricsCollector | undefined;
    private taskManager: ReactiveTaskManager;

    // Internal options for testing
    private internalOptions = {
        lockTtlMs: 30000,
        lockHeartbeatMs: 10000,
        minPollMs: 200,
        maxPollMs: 10000,
        jitterMs: 100,
        visibilityTimeoutMs: 60000,
        batchSize: 1000,
        batchIntervalMs: 500,
        getNextCleanupDate: (d?: Date) => new Date((d?.getTime() ?? Date.now()) + 24 * 60 * 60 * 1000), // 24h default
    };

    constructor() {
        // Registry is created, instanceId is lazy-generated or configured later
        this.taskManager = new ReactiveTaskManager(this.registry);
    }

    /**
     * Get the instanceId, generating one if not configured.
     */
    private get instanceId(): string {
        if (!this._instanceId) {
            const { ObjectId } = require('mongodb');
            this._instanceId = new ObjectId().toHexString();
        }
        return this._instanceId!;
    }

    public configure(options: Partial<ReactiveTaskSchedulerOptions>): void {
        if (this.concurrentRunner) {
            throw new Error('Cannot configure scheduler after initialization.');
        }
        // Configure instanceId if provided
        if (options.instanceId) {
            this._instanceId = options.instanceId;
        }

        if (options.reactiveTaskCleanupInterval !== undefined) {
            this.internalOptions.getNextCleanupDate = createIntervalFunction(options.reactiveTaskCleanupInterval);
        }

        this.options = { ...this.options, ...options };
        this.concurrentRunner = new ConcurrentRunner({ concurrency: this.options.reactiveTaskConcurrency }, onError);
        this.registry.setCallbacks(onInfo, onError);
        debug(`[Scheduler ${this.instanceId}] Configured. onInfo is ${onInfo === defaultOnInfo ? 'DEFAULT' : 'CUSTOM'}`);
    }

    public async addTask(taskDef: ReactiveTask<Document>): Promise<void> {
        if (this.isRunning) {
            throw new Error('Cannot add task after scheduler has started.');
        }

        if (this.registry.getTask(taskDef.task)) {
            throw new Error(`Task with name '${taskDef.task}' already exists.`);
        }

        await this.registry.addTask(taskDef);
    }

    /**
     * Starts the entire system - leader election and workers.
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            debug(`[Scheduler ${this.instanceId}] Attempt to start already running scheduler.`);
            return;
        }

        if (!this.concurrentRunner) {
            throw new Error('Scheduler is not configured. Call configure() first.');
        }

        this.isRunning = true;
        debug(`[Scheduler ${this.instanceId}] Starting...`);
        await initPromise; // Ensure init is complete

        await Promise.all(this.registry.getAllTasks().map((task) => task.initPromise));

        for (const { tasksCollection } of this.registry.getAllEntries()) {
            if (this.concurrentRunner.hasSource(tasksCollection.collectionName)) {
                continue;
            }
            this.concurrentRunner.registerSource(tasksCollection.collectionName, {
                minPollMs: this.internalOptions.minPollMs,
                maxPollMs: this.internalOptions.maxPollMs,
                jitterMs: this.internalOptions.jitterMs,
            });
        }

        // Initialize components

        this.taskPlanner = new ReactiveTaskPlanner(
            globalsCollection,
            this.instanceId,
            this.registry,
            {
                onStreamError: () => {
                    onInfo({
                        message: `Change Stream error.`,
                        code: CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
                    });
                    // If stream fails, we should probably force lose leader to let someone else try,
                    // or just restart if we are still leader.
                    // LeaderElector handles its own loop.
                    // If stream fails, Planner stops.
                    // We can ask LeaderElector to give up leadership.
                    this.leaderElector?.forceLoseLeader();
                },
                onTaskPlanned: (tasksCollectionName, debounceMs) => {
                    setTimeout(() => {
                        this.concurrentRunner?.speedUp(tasksCollectionName);
                    }, debounceMs);
                },
            },
            {
                batchSize: this.internalOptions.batchSize,
                batchIntervalMs: this.internalOptions.batchIntervalMs,
                getNextCleanupDate: this.internalOptions.getNextCleanupDate,
            },
            onInfo,
            onError,
        );

        this.leaderElector = new LeaderElector(
            globalsCollection,
            this.instanceId,
            {
                lockTtlMs: this.internalOptions.lockTtlMs,
                lockHeartbeatMs: this.internalOptions.lockHeartbeatMs,
                metaDocId: REACTIVE_TASK_META_DOC_ID,
            },
            {
                onBecomeLeader: async () => {
                    const tasks = this.registry.getAllTasks();
                    if (tasks.length === 0) {
                        debug(`[Scheduler ${this.instanceId}] Became leader, but no tasks registered. Skipping planner start.`);
                        return;
                    }
                    debug(`[Scheduler ${this.instanceId}] Became leader, starting planner.`);
                    await this.taskPlanner?.start();
                },
                onLoseLeader: async () => {
                    debug(`[Scheduler ${this.instanceId}] Lost leader, stopping planner.`);
                    await this.taskPlanner?.stop();
                },
                onHeartbeat: async () => {
                    await this.taskPlanner?.onHeartbeat();
                },
            },
            onInfo,
            onError,
        );

        this.metricsCollector = new MetricsCollector(
            this.instanceId,
            this.registry,
            globalsCollection,
            this.leaderElector,
            this.options.monitoring,
            onInfo,
            onError,
        );

        this.worker = new ReactiveTaskWorker(
            this.instanceId,
            this.registry,
            {
                onTaskFound: (collectionName) => {
                    this.concurrentRunner!.speedUp(collectionName);
                },
            },
            {
                visibilityTimeoutMs: this.internalOptions.visibilityTimeoutMs,
            },
            this.options.reactiveTaskCaller,
            this.options.reactiveTaskFilter,
            onInfo,
            onError,
            this.metricsCollector,
        );

        // Start Leader Election
        await this.leaderElector.start();

        // Start Metrics Collector
        if (this.metricsCollector) {
            this.metricsCollector.start();
        }

        // Start Workers
        this.concurrentRunner.start((collectionName) => this.worker!.tryRunATask(collectionName));

        debug(`[Scheduler ${this.instanceId}] Started with ${this.options.reactiveTaskConcurrency} workers.`);
    }

    /**
     * Stops the entire system.
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return;
        }
        debug(`[Scheduler ${this.instanceId}] Stopping...`);
        this.isRunning = false;

        await Promise.all([this.leaderElector?.stop(), this.taskPlanner?.stop(), this.concurrentRunner!.stop(), this.metricsCollector?.stop()]);

        debug(`[Scheduler ${this.instanceId}] Stopped.`);
    }

    public async getPrometheusMetrics(): Promise<Registry | null> {
        return (await this.metricsCollector?.getPrometheusMetrics()) ?? null;
    }

    public getTaskManager(): ReactiveTaskManager {
        return this.taskManager;
    }

    public getRegistry(): ReactiveTaskRegistry {
        return this.registry;
    }
}

// --- SINGLETON INSTANCE ---
const scheduler = new ReactiveTaskScheduler();

// --- PUBLIC INITIALIZATION FUNCTION ---

export function init(initOptions: InitOptions): void {
    const { onError: _onError, onInfo: _onInfo, globalsCollection: _globalsCollection, ...schedulerOptions } = initOptions;
    onError = _onError;
    onInfo = _onInfo;
    globalsCollection = _globalsCollection;

    scheduler.configure(schedulerOptions);
}

export async function reactiveTask<T extends Document = Document>(taskDef: ReactiveTask<T>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await scheduler.addTask(taskDef as ReactiveTask<any>);
}

export async function stopReactiveTasks(): Promise<void> {
    await scheduler.stop();
}

export async function startReactiveTasks(): Promise<void> {
    await scheduler.start();
}

/**
 * Returns the Prometheus metrics for the Reactive Tasks system.
 * Respects the 'scrapeMode' configuration.
 */
export async function getPrometheusMetrics(): Promise<Registry | null> {
    return scheduler.getPrometheusMetrics();
}

/**
 * List tasks matching the criteria.
 */
export async function getReactiveTasks(query: ReactiveTaskQuery, pagination: PaginationOptions = {}): Promise<PagedResult<ReactiveTaskRecord>> {
    return scheduler.getTaskManager().getTasks(query, pagination);
}

/**
 * Count tasks matching criteria.
 */
export async function countReactiveTasks(query: ReactiveTaskQuery): Promise<number> {
    return scheduler.getTaskManager().countTasks(query);
}

/**
 * Retries/Retriggers tasks matching the query.
 */
export async function retryReactiveTasks(query: ReactiveTaskQuery): Promise<{ modifiedCount: number }> {
    return scheduler.getTaskManager().retryTasks(query);
}
