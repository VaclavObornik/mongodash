import * as _debug from 'debug';
import { Collection, Document } from 'mongodb';
import { getCollection } from '../getCollection';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { compileWatchProjection } from './compileWatchProjection';
import { ReactiveTaskRepository } from './ReactiveTaskRepository';
import { ReactiveTaskRetryStrategy } from './ReactiveTaskRetryStrategy';
import { CODE_REACTIVE_TASK_INITIALIZED, EvolutionConfig, ReactiveTask, ReactiveTaskInternal, ReactiveTaskRecord } from './ReactiveTaskTypes';
import { normalizeTaskFilter } from './validateTaskFilter';
const debug = _debug('mongodash:ReactiveTaskRegistry');

const { Duration } = require('@sapphire/duration');

export interface TaskMapEntry {
    sourceCollection: Collection<Document>;
    tasks: Map<string, ReactiveTaskInternal<Document>>;
    tasksCollection: Collection<ReactiveTaskRecord<Document>>;
    repository: ReactiveTaskRepository<Document>;
}

/**
 * Registry for managing reactive task definitions and their associated collections.
 *
 * Responsibilities:
 * - Stores task definitions and maps them to source and task collections.
 * - Initializes the `ReactiveTaskRepository` for each task collection.
 * - Provides lookup methods to retrieve tasks by name or collection.
 * - Ensures task uniqueness and validates configuration.
 */
export class ReactiveTaskRegistry {
    private map = new Map<string, TaskMapEntry>();
    private tasksByIdentifiers = new Map<string, ReactiveTaskInternal<Document>>();
    private onInfo: OnInfo;
    private onError: OnError;
    constructor(onInfo: OnInfo = defaultOnInfo, onError: OnError = defaultOnError) {
        this.onInfo = onInfo;
        this.onError = onError;
    }

    public setCallbacks(onInfo: OnInfo, onError: OnError): void {
        this.onInfo = onInfo;
        this.onError = onError;
    }

    public async addTask(taskDef: ReactiveTask<Document>): Promise<void> {
        if (this.tasksByIdentifiers.has(taskDef.task)) {
            throw new Error(`Task with name '${taskDef.task}' already exists.`);
        }

        const normalizedFilter = normalizeTaskFilter(taskDef.filter, taskDef.task);
        try {
            compileWatchProjection(taskDef.watchProjection);
        } catch (e: unknown) {
            throw new Error(`Task '${taskDef.task}': ${(e as Error).message}`);
        }

        // Parse debounce (Fail Fast)
        let debounceMs = 1000;
        if (taskDef.debounce !== undefined) {
            if (typeof taskDef.debounce === 'number') {
                if (taskDef.debounce < 0) {
                    throw new Error(`Task '${taskDef.task}': 'debounce' must be a non-negative number.`);
                }
                debounceMs = taskDef.debounce;
            } else {
                const parsed = new Duration(taskDef.debounce).offset;
                if (parsed === null || parsed === undefined || parsed < 0 || Number.isNaN(parsed)) {
                    throw new Error(
                        `Task '${taskDef.task}': Invalid duration format for 'debounce': '${taskDef.debounce}'. Use formats like '100ms', '1s', '5m'.`,
                    );
                }
                debounceMs = parsed;
            }
        }

        if (taskDef.evolution) {
            this.validateEvolutionConfig(taskDef.task, taskDef.evolution);
        }

        const sourceCollectionName = typeof taskDef.collection === 'string' ? taskDef.collection : taskDef.collection.collectionName;
        const tasksCollectionName = sourceCollectionName + '_tasks';

        if (!this.map.has(sourceCollectionName)) {
            const tasksCollection = getCollection<ReactiveTaskRecord<Document>>(tasksCollectionName);
            const repository = new ReactiveTaskRepository(tasksCollection, this.onInfo, this.onError);
            const entry: TaskMapEntry = {
                sourceCollection: getCollection<Document>(sourceCollectionName),
                tasks: new Map<string, ReactiveTaskInternal<Document>>(),
                tasksCollection,
                repository,
            };
            // store in both directions for easy lookup
            this.map.set(sourceCollectionName, entry);
            this.map.set(tasksCollectionName, entry);
        }

        const collectionsMapEntry = this.map.get(sourceCollectionName)!;

        // Determine Retry Policy with defaults
        let retryPolicy = taskDef.retryPolicy;

        if (!retryPolicy) {
            // Default policy: Exponential backoff
            retryPolicy = {
                type: 'exponential',
                min: '10s',
                max: '1d',
            };
        }

        if (retryPolicy.resetRetriesOnDataChange === undefined) {
            retryPolicy.resetRetriesOnDataChange = true;
        }

        if (retryPolicy.maxAttempts === undefined && !retryPolicy.maxDuration) {
            retryPolicy.maxAttempts = 5;
        }

        // Parse cleanupPolicy
        const policy = taskDef.cleanupPolicy;
        const deleteWhen = policy?.deleteWhen ?? 'sourceDocumentDeleted';
        const keepForInput = policy?.keepFor ?? '24h';
        let keepForMs: number;

        if (typeof keepForInput === 'number') {
            keepForMs = keepForInput;
        } else {
            const parsed = new Duration(keepForInput).offset;
            if (parsed === null || parsed === undefined || parsed < 0 || Number.isNaN(parsed)) {
                throw new Error(
                    `Task '${taskDef.task}': Invalid duration format for 'cleanupPolicy.keepFor': '${keepForInput}'. Use formats like '100ms', '1s', '5m', '1h', '24h'.`,
                );
            }
            keepForMs = parsed;
        }

        const internalTask: ReactiveTaskInternal<Document> = {
            ...taskDef,
            filter: normalizedFilter,
            debounceMs,
            executionHistoryLimit: taskDef.executionHistoryLimit ?? 5,
            retryStrategy: new ReactiveTaskRetryStrategy(retryPolicy),
            sourceCollection: collectionsMapEntry.sourceCollection,
            tasksCollection: collectionsMapEntry.tasksCollection,
            initPromise: collectionsMapEntry.repository.initPromise,
            cleanupPolicyParsed: {
                deleteWhen,
                keepForMs,
            },
            repository: collectionsMapEntry.repository,
        };

        collectionsMapEntry.tasks.set(taskDef.task, internalTask);
        this.tasksByIdentifiers.set(taskDef.task, internalTask);

        await internalTask.initPromise;

        this.onInfo({
            message: `Initialized ${taskDef.task}`,
            code: CODE_REACTIVE_TASK_INITIALIZED,
            task: taskDef.task,
            sourceCollection: collectionsMapEntry.sourceCollection.collectionName,
            tasksCollection: collectionsMapEntry.tasksCollection.collectionName,
        });
    }

    public getTask(taskName: string): ReactiveTaskInternal<Document> | undefined {
        return this.tasksByIdentifiers.get(taskName);
    }

    public getAllTasks(): ReactiveTaskInternal<Document>[] {
        return Array.from(this.tasksByIdentifiers.values());
    }

    public getEntry(collectionName: string): TaskMapEntry {
        const entry = this.map.get(collectionName);
        if (!entry) {
            throw new Error(`Entry for collection '${collectionName}' not found.`);
        }
        return entry;
    }

    public getAllEntries(): TaskMapEntry[] {
        // Filter out duplicates (map has entries for both source and tasks collection names)
        // We can iterate over source collection names if we knew them, or filter by unique tasksCollection
        const uniqueEntries = new Set<TaskMapEntry>();
        for (const entry of this.map.values()) {
            uniqueEntries.add(entry);
        }
        return Array.from(uniqueEntries);
    }

    private validateEvolutionConfig(taskName: string, config: EvolutionConfig) {
        debug(`[DEBUG] Validating config for ${taskName}:`, config);
        if (typeof config.handlerVersion !== 'undefined') {
            if (typeof config.handlerVersion !== 'number' || config.handlerVersion < 0) {
                debug(`[DEBUG] Validation failed for handlerVersion: ${config.handlerVersion}`);
                throw new Error(`ReactiveTask [${taskName}]: evolution.handlerVersion must be a non-negative integer.`);
            }
        }

        if (config.onHandlerVersionChange) {
            if (!['none', 'reprocess_failed', 'reprocess_all'].includes(config.onHandlerVersionChange)) {
                throw new Error(`ReactiveTask [${taskName}]: evolution.onHandlerVersionChange must be one of ['none', 'reprocess_failed', 'reprocess_all'].`);
            }
        }

        if (typeof config.reconcileOnTriggerChange !== 'undefined') {
            if (typeof config.reconcileOnTriggerChange !== 'boolean') {
                throw new Error(`ReactiveTask [${taskName}]: evolution.reconcileOnTriggerChange must be a boolean.`);
            }
        }

        const knownKeys = ['handlerVersion', 'onHandlerVersionChange', 'reconcileOnTriggerChange'];
        const unknownKeys = Object.keys(config).filter((k) => !knownKeys.includes(k));
        if (unknownKeys.length > 0) {
            throw new Error(`ReactiveTask [${taskName}]: Unknown keys in evolution config: ${unknownKeys.join(', ')}`);
        }
    }
}
