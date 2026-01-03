import * as _debug from 'debug';
import {
    ChangeStream,
    ChangeStreamDeleteDocument,
    ChangeStreamInsertDocument,
    ChangeStreamReplaceDocument,
    ChangeStreamUpdateDocument,
    Document,
    MongoError,
    ResumeToken,
} from 'mongodb';
import { getMongoClient } from '../getMongoClient';
import { GlobalsCollection } from '../globalsCollection';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { prefixFilterKeys } from '../prefixFilterKeys';
import { serializeKey } from '../utils/serializeKey';
import { ReactiveTaskOps } from './ReactiveTaskOps';
import { ReactiveTaskReconciler } from './ReactiveTaskReconciler';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import {
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STARTED,
    CODE_REACTIVE_TASK_PLANNER_STOPPED,
    CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
    EvolutionConfig,
    MetaDocument,
    ReactiveTaskInternal,
    REACTIVE_TASK_META_DOC_ID,
} from './ReactiveTaskTypes';
import stringify = require('fast-json-stable-stringify');

const debug = _debug('mongodash:reactiveTasks:planner');

type FilteredChangeStreamDocument = Pick<
    ChangeStreamInsertDocument | ChangeStreamUpdateDocument | ChangeStreamReplaceDocument | ChangeStreamDeleteDocument,
    '_id' | 'operationType' | 'ns' | 'documentKey' | 'clusterTime'
>;

export interface PlannerCallbacks {
    onStreamError: () => void;
    onTaskPlanned: (tasksCollectionName: string, debounceMs: number) => void;
}

/**
 * Responsible for listening to MongoDB Change Stream events and planning tasks.
 *
 * Responsibilities:
 * - Manages the lifecycle of the Change Stream (start, stop, error handling).
 * - Batches Change Stream events to reduce database load.
 * - Coordinates with `ReactiveTaskOps` to generate and execute task operations.
 * - Coordinates with `ReactiveTaskReconciler` to handle reconciliation when the stream is interrupted or history is lost.
 * - Handles critical errors like `ChangeStreamHistoryLost` (code 280) by triggering reconciliation.
 */
export class ReactiveTaskPlanner {
    private changeStream: ChangeStream | null = null;
    private taskBatch = new Map<string, FilteredChangeStreamDocument>();
    private taskBatchLastResumeToken: ResumeToken | null = null;
    private batchFlushTimer: NodeJS.Timeout | null = null;
    private isFlushing = false;
    private metaDocId = REACTIVE_TASK_META_DOC_ID;
    private lastClusterTime: number | null = null;

    private ops: ReactiveTaskOps;
    private reconciler: ReactiveTaskReconciler;

    private get isStoppedTester(): () => boolean {
        return () => this.changeStream === null;
    }

    constructor(
        private globalsCollection: GlobalsCollection,
        private instanceId: string,
        private registry: ReactiveTaskRegistry,
        private callbacks: PlannerCallbacks,
        private internalOptions: { batchSize: number; batchIntervalMs: number; getNextCleanupDate: (date?: Date) => Date },
        private onInfo: OnInfo = defaultOnInfo,
        private onError: OnError = defaultOnError,
    ) {
        this.ops = new ReactiveTaskOps(registry, callbacks.onTaskPlanned);
        this.reconciler = new ReactiveTaskReconciler(instanceId, globalsCollection, registry, this.ops, onInfo, internalOptions);
    }

    public async start(): Promise<void> {
        this.onInfo({
            message: `Reactive task planner started.`,
            code: CODE_REACTIVE_TASK_PLANNER_STARTED,
        });

        // 1. Check for schema/logic evolution (Filter changes, Version upgrades)
        await this.checkEvolutionStrategies();

        // 2. Start stream first to ensure we don't miss events during reconciliation
        // We capture the time AFTER starting to ensure overlap with the stream.
        // This prevents a gap where events occurring between "now" and "stream start" would be missed.
        await this.startChangeStream();

        // Pass the current stream instance to reconcile. If stream fails/restarts, instance changes and reconcile aborts.
        if (this.changeStream) {
            await this.reconciler.reconcile(this.isStoppedTester);
        }
    }

    public async stop(): Promise<void> {
        await this.stopChangeStream();
        this.onInfo({
            message: `Reactive task planner stopped.`,
            code: CODE_REACTIVE_TASK_PLANNER_STOPPED,
        });
    }

    public async saveResumeToken(token: ResumeToken, lastClusterTime?: Date): Promise<void> {
        const setFields: Document = { 'streamState.resumeToken': token };
        if (lastClusterTime) {
            setFields['streamState.lastClusterTime'] = lastClusterTime;
        }

        await this.globalsCollection.updateOne({ _id: this.metaDocId }, { $set: setFields }, { upsert: true });
    }

    public get isEmpty(): boolean {
        return this.taskBatch.size === 0 && !this.isFlushing;
    }

    public async onHeartbeat(): Promise<void> {
        // Save resume token if stream is running and idle
        if (this.changeStream && this.isEmpty) {
            await this.saveResumeToken(this.changeStream.resumeToken, this.lastClusterTime ? new Date(this.lastClusterTime * 1000) : undefined);
        }

        // Periodic cleanup of orphaned tasks
        await this.reconciler.performPeriodicCleanup(this.isStoppedTester);
    }

    private isStopping = false;

    private async startChangeStream(): Promise<void> {
        if (this.changeStream) {
            await this.stopChangeStream();
        }

        try {
            const streamOptions: Document = {
                resumeAfter: await this.getChangeStreamResumeToken(),
                fullDocument: 'updateLookup',
            };

            if (!streamOptions.resumeAfter) {
                // get current server time to guarantee we get any operation from the current time
                // even if the watch operation took a time, since it is async and we don't have
                // any guaranty at what point we start listening
                const serverStatus = await getMongoClient().db().command({ hello: 1 });
                if (serverStatus && serverStatus.operationTime) {
                    this.onInfo({
                        message: `No token found. Starting from operationTime: ${serverStatus.operationTime}`,
                        code: CODE_REACTIVE_TASK_PLANNER_STARTED,
                        operationTime: serverStatus.operationTime,
                    });
                    streamOptions.startAtOperationTime = serverStatus.operationTime;
                } else {
                    // Fallback pro standalone instance bez oplogu (méně časté v produkci)
                    this.onInfo({
                        message: `Could not fetch operationTime. Starting standard watch.`,
                        code: CODE_REACTIVE_TASK_PLANNER_STARTED,
                    });
                }
            }

            const pipeline = this.getChangeStreamPipeline();
            debug(`[Scheduler ${this.instanceId}] Change Stream Pipeline: `, JSON.stringify(pipeline, null, 2));

            // Determine which database to watch
            // We assume all monitored collections are in the same database for now.
            const tasks = this.registry.getAllTasks();
            let dbToWatch = getMongoClient().db(); // Default
            if (tasks.length > 0) {
                const dbName = tasks[0].sourceCollection.dbName;
                dbToWatch = getMongoClient().db(dbName);
                debug(`[ReactiveTaskPlanner] Watching database: ${dbName}`);
            }

            const stream = dbToWatch.watch(pipeline, streamOptions);
            this.changeStream = stream;

            stream.on('change', (change: FilteredChangeStreamDocument) => {
                this.enqueueTaskChange(change);
            });
            stream.on('resumeTokenChanged', () => {
                if (this.isEmpty) {
                    this.lastClusterTime = Date.now() / 1000;
                }
            });
            stream.on('error', (error) => this.handleStreamError(error as MongoError));
            stream.on('close', () => {
                this.onInfo({
                    message: `Change Stream closed.`,
                    code: CODE_REACTIVE_TASK_PLANNER_STOPPED,
                });
                if (!this.isStopping) {
                    this.callbacks.onStreamError();
                }
            });
        } catch (error) {
            this.onInfo({
                message: `Failed to start Change Stream: ${(error as Error).message}`,
                code: CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
                error: (error as Error).message,
            });
            this.callbacks.onStreamError();
        }
    }

    private async stopChangeStream(): Promise<void> {
        if (this.changeStream) {
            this.isStopping = true;
            debug(`[Scheduler ${this.instanceId}] Stopping Change Stream...`);
            await this.changeStream.close();
            this.changeStream = null;
            this.isStopping = false;
        }
        await this.flushTaskBatch();
    }

    private getChangeStreamPipeline(): Document[] {
        const collectionFilters = this.registry.getAllTasks().reduce((acc, taskDef) => {
            const collectionName = taskDef.sourceCollection.collectionName;
            if (!acc.has(collectionName)) {
                acc.set(collectionName, { 'ns.coll': collectionName, $or: [] });
            }
            acc.get(collectionName)!.$or.push(prefixFilterKeys({ $expr: taskDef.filter || {} }, 'fullDocument'));
            return acc;
        }, new Map<string, Document>());

        const pipeline = [
            {
                $match: {
                    operationType: { $in: ['insert', 'update', 'replace', 'delete'] },
                    $or: Array.from(collectionFilters.values()),
                },
            },
            {
                $project: {
                    _id: 1,
                    operationType: 1,
                    ns: 1,
                    documentKey: 1,
                    clusterTime: 1,
                },
            },
        ];
        return pipeline;
    }

    private async getChangeStreamResumeToken(): Promise<ResumeToken | undefined> {
        const state = (await this.globalsCollection.findOne({
            _id: this.metaDocId,
        })) as MetaDocument | null;
        debug(`[DEBUG] getChangeStreamResumeToken loaded state (${this.metaDocId}): `, JSON.stringify(state, null, 2));

        const token = state?.streamState?.resumeToken;
        debug(`[DEBUG] Extracted token: `, token);
        return token ?? undefined;
    }

    private async enqueueTaskChange(change: FilteredChangeStreamDocument): Promise<void> {
        debug(`[Scheduler ${this.instanceId}] Change detected: `, change._id);

        if (!change.documentKey?._id) {
            // Some events like 'drop', 'dropDatabase', 'invalidate' don't have documentKey.
            // We can safely ignore them for task planning.
            return;
        }

        if (change.clusterTime) {
            // clusterTime is a BSON Timestamp.
            // .getHighBits() returns the seconds since epoch.
            this.lastClusterTime = change.clusterTime.getHighBits();
        }

        const docId = serializeKey(change.documentKey._id);
        this.taskBatch.set(docId, change);
        this.taskBatchLastResumeToken = change._id;

        if (this.taskBatch.size >= this.internalOptions.batchSize) {
            if (this.batchFlushTimer) {
                clearTimeout(this.batchFlushTimer);
                this.batchFlushTimer = null;
            }
            await this.flushTaskBatch();
        } else if (!this.batchFlushTimer) {
            this.batchFlushTimer = setTimeout(() => this.flushTaskBatch(), this.internalOptions.batchIntervalMs);
        }
    }

    private async flushTaskBatch(): Promise<void> {
        if (this.batchFlushTimer) {
            clearTimeout(this.batchFlushTimer);
            this.batchFlushTimer = null;
        }

        if (this.taskBatch.size === 0) {
            return;
        }

        const events = Array.from(this.taskBatch.values());
        this.taskBatch.clear();

        const lastToken = this.taskBatchLastResumeToken;
        const lastClusterTime = this.lastClusterTime ? new Date(this.lastClusterTime * 1000) : undefined; // Capture time associated with this batch (approx)
        this.isFlushing = true;

        try {
            const { idsByCollection, deletedIdsByTask } = this.groupEventsByCollection(events);

            await this.processDeletions(deletedIdsByTask);
            await this.executeUpsertOperations(idsByCollection);

            if (lastToken) {
                await this.saveResumeToken(lastToken, lastClusterTime);
            }
        } catch (error) {
            this.onError(error as Error);
            // We lost the batch, but we can't easily retry without complicating logic.
            // The stream continues.
        } finally {
            this.isFlushing = false;
        }
    }

    private groupEventsByCollection(events: FilteredChangeStreamDocument[]) {
        const idsByCollection = new Map<string, Set<unknown>>();
        // Map<TaskName, Set<SourceId>>
        const deletedIdsByTask = new Map<string, Set<unknown>>();

        for (const event of events) {
            if (!event.ns || !event.ns.coll) continue;
            const collectionName = event.ns.coll;

            if (event.operationType === 'delete') {
                const docId = event.documentKey._id;
                const entry = this.registry.getEntry(collectionName);

                if (entry) {
                    for (const taskDef of entry.tasks.values()) {
                        let docIds = deletedIdsByTask.get(taskDef.task);
                        if (!docIds) {
                            docIds = new Set();
                            deletedIdsByTask.set(taskDef.task, docIds);
                        }
                        docIds.add(docId);
                    }
                }
            } else {
                // insert, update, replace
                if (!idsByCollection.has(collectionName)) {
                    idsByCollection.set(collectionName, new Set());
                }
                idsByCollection.get(collectionName)!.add(event.documentKey._id);
            }
        }

        return { idsByCollection, deletedIdsByTask };
    }

    private async processDeletions(deletedIdsByTask: Map<string, Set<unknown>>): Promise<void> {
        if (deletedIdsByTask.size > 0) {
            await Promise.all(
                Array.from(deletedIdsByTask.entries()).map(async ([taskName, ids]) => {
                    if (ids.size === 0) return;

                    const taskDef = this.registry.getTask(taskName);

                    if (taskDef) {
                        // We use deleteOrphanedTasks but limit it to the source IDs we just saw deleted.
                        // This reuses the EXACT same logic (including keepFor checks) as the background cleaner.
                        await taskDef.repository.deleteOrphanedTasks(
                            taskName,
                            taskDef.sourceCollection.collectionName,
                            taskDef.filter || {},
                            taskDef.cleanupPolicyParsed,
                            () => false, // shouldStop: immediate execution, no need to stop
                            Array.from(ids),
                        );
                    }
                }),
            );
        }
    }

    private async executeUpsertOperations(idsByCollection: Map<string, Set<unknown>>): Promise<void> {
        if (idsByCollection.size > 0) {
            await Promise.all(
                Array.from(idsByCollection.entries()).map(async ([collectionName, ids]) => {
                    if (ids.size === 0) return;
                    try {
                        await this.ops.executePlanningPipeline(collectionName, Array.from(ids));
                    } catch (error) {
                        this.onError(error as Error);
                    }
                }),
            );
        }
    }

    private async handleStreamError(error: MongoError): Promise<void> {
        if (error.code === 280) {
            this.onError(new Error(`Critical error: Oplog history lost(ChangeStreamHistoryLost).Resetting Resume Token.Original error: ${error.message} `));
            await this.globalsCollection.updateOne({ _id: this.metaDocId }, { $unset: { 'streamState.resumeToken': '', reconciliation: '' } });

            this.onInfo({
                message: `Oplog lost, triggering reconciliation...`,
                code: CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
            });

            // Start stream first to capture new events
            await this.startChangeStream();
            if (this.changeStream) {
                await this.reconciler.reconcile(this.isStoppedTester);
            }
        } else {
            this.onInfo({
                message: `Change Stream error: ${error.message} `,
                code: CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR,
                error: error.message,
            });
            this.callbacks.onStreamError();
        }
    }

    private async checkEvolutionStrategies(): Promise<void> {
        const metaDoc = (await this.globalsCollection.findOne({ _id: this.metaDocId })) as MetaDocument | null;
        const storedTasks = metaDoc?.tasks || {};
        const update: Document = {};
        const tasksToReconcile: string[] = [];
        let needsUpdate = false;

        const allTasks = this.registry.getAllTasks();

        for (const taskDef of allTasks) {
            const taskName = taskDef.task;
            const defaultEvolution: EvolutionConfig = {
                handlerVersion: 1,
                onHandlerVersionChange: 'none',
                reconcileOnTriggerChange: true,
            };
            const evolution = { ...defaultEvolution, ...(taskDef.evolution || {}) };

            const storedState = storedTasks[taskName];

            const triggerChanged = this.checkTriggerEvolution(taskName, taskDef, evolution, storedState, update, tasksToReconcile);
            if (triggerChanged) needsUpdate = true;

            const logicChanged = await this.checkLogicEvolution(taskName, taskDef, evolution, storedState, update);
            if (logicChanged) needsUpdate = true;
        }

        if (needsUpdate) {
            debug(`[DEBUG] Updating meta doc with: `, JSON.stringify(update, null, 2));
            await this.globalsCollection.updateOne({ _id: this.metaDocId }, update, { upsert: true });
        } else {
            debug(`[DEBUG] No updates needed for meta doc.`);
        }

        if (tasksToReconcile.length > 0) {
            await this.reconciler.markAsUnreconciled(tasksToReconcile);
        }
    }

    private checkTriggerEvolution(
        taskName: string,
        taskDef: ReactiveTaskInternal<Document>,
        evolution: EvolutionConfig,
        storedState: { triggerConfig?: { filter: Document; watchProjection: Document }; handlerVersion?: number },
        update: Document,
        tasksToReconcile: string[],
    ): boolean {
        const currentTriggerConfig = {
            filter: taskDef.filter || {},
            watchProjection: taskDef.watchProjection || {},
        };
        const currentTriggerSig = stringify(currentTriggerConfig);
        const storedTriggerSig = storedState?.triggerConfig ? stringify(storedState.triggerConfig) : null;

        if (currentTriggerSig !== storedTriggerSig) {
            const shouldReconcile = evolution.reconcileOnTriggerChange !== false;
            const msg = storedTriggerSig === null ? `Initial trigger config captured for [${taskName}].` : `Trigger config changed for [${taskName}].`;

            if (shouldReconcile) {
                debug(`${msg} Queueing reconciliation.`);
                tasksToReconcile.push(taskName);
            } else {
                debug(`[mongodash] ${msg} Reconciliation disabled.`);
            }

            if (!update.$set) update.$set = {};
            update.$set[`tasks.${taskName}.triggerConfig`] = currentTriggerConfig;
            return true;
        }
        return false;
    }

    private async checkLogicEvolution(
        taskName: string,
        taskDef: ReactiveTaskInternal<Document>,
        evolution: EvolutionConfig,
        storedState: { triggerConfig?: unknown; handlerVersion?: number },
        update: Document,
    ): Promise<boolean> {
        const currentVersion = evolution.handlerVersion ?? 1;
        const storedVersion = storedState?.handlerVersion ?? (storedState ? 0 : 1);

        if (currentVersion > storedVersion) {
            const policy = evolution.onHandlerVersionChange || 'none';
            debug(`Handler upgraded for [${taskName}](v${storedVersion} -> v${currentVersion}).Policy: ${policy} `);

            const entry = this.registry.getEntry(taskDef.sourceCollection.collectionName);
            if (entry) {
                if (policy === 'reprocess_failed') {
                    await entry.repository.resetTasksForUpgrade(taskName, 'failed');
                } else if (policy === 'reprocess_all') {
                    await entry.repository.resetTasksForUpgrade(taskName, 'all');
                }
            }

            if (!update.$set) update.$set = {};
            update.$set[`tasks.${taskName}.handlerVersion`] = currentVersion;
            return true;
        } else if (currentVersion < storedVersion) {
            debug(
                `[mongodash] ReactiveTask[${taskName}]: Current handlerVersion(${currentVersion}) is LOWER than stored version(${storedVersion}).Rollback detected ? `,
            );
        } else if (!storedState && currentVersion === 1) {
            // Safe Adoption
            if (!update.$set) update.$set = {};
            update.$set[`tasks.${taskName}.handlerVersion`] = currentVersion;
            return true;
        }
        return false;
    }
}
