import * as _debug from 'debug';
import { Document } from 'mongodb';
import { GlobalsCollection } from '../globalsCollection';
import { OnInfo } from '../OnInfo';
import { processInBatches } from '../processInBatches';
import { withLock } from '../withLock';
import { ReactiveTaskOps } from './ReactiveTaskOps';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import {
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
    CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
    MetaDocument,
    REACTIVE_TASK_META_DOC_ID,
} from './ReactiveTaskTypes';

const debug = _debug('mongodash:reactiveTasks:reconciler');

/**
 * Responsible for reconciling reactive tasks when the Change Stream history is lost or on startup.
 *
 * Responsibilities:
 * - Scans source collections to identify tasks that should exist.
 * - Uses `ReactiveTaskOps` to generate and execute task operations.
 * - Tracks reconciliation status in the meta document.
 */
export class ReactiveTaskReconciler {
    constructor(
        private instanceId: string,
        private globalsCollection: GlobalsCollection,
        private registry: ReactiveTaskRegistry,
        private ops: ReactiveTaskOps,
        private onInfo: OnInfo,
        private internalOptions: { batchSize: number; batchIntervalMs: number; getNextCleanupDate: (date?: Date) => Date },
    ) {}

    private nextCleanupTime: number | null = null;

    public async reconcile(shouldStop: () => boolean): Promise<void> {
        debug(`[Scheduler ${this.instanceId}] Reconciliation started.`);
        this.onInfo({
            message: `Reconciliation started.`,
            code: CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED,
            taskCount: this.registry.getAllTasks().length,
        });

        const metaDoc = (await this.globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID })) as MetaDocument | null;
        debug(`[Scheduler ${this.instanceId}] Meta doc loaded:`, metaDoc);

        // Iterate over all tasks and reconcile
        const taskEntries = this.registry.getAllEntries();
        for (const entry of taskEntries) {
            if (shouldStop()) {
                debug(`[Scheduler ${this.instanceId}] Reconciliation stopped.`);
                return;
            }
            debug(`[Scheduler ${this.instanceId}] Reconciling collection: ${entry.tasksCollection.collectionName}`);

            // Filter tasks that need reconciliation
            const tasksToReconcile = new Set<string>();
            for (const task of entry.tasks.values()) {
                if (!metaDoc?.reconciliation?.[task.task]) {
                    tasksToReconcile.add(task.task);
                } else {
                    debug(`[Scheduler ${this.instanceId}] Task ${task.task} is already reconciled. Skipping.`);
                }
            }

            if (tasksToReconcile.size === 0) {
                debug(`[Scheduler ${this.instanceId}] No tasks to reconcile for collection ${entry.tasksCollection.collectionName}.`);
                continue;
            }

            debug(`[Scheduler ${this.instanceId}] Checks for existing reconciliation state for collection: ${entry.tasksCollection.collectionName}`);

            // Check for existing checkpoint
            const collectionName = entry.sourceCollection.collectionName;
            const checkpoint = metaDoc?.reconciliationState?.[collectionName];
            let lastId: unknown = null;
            let resume = false;

            if (checkpoint) {
                // Validate if the set of tasks matches
                // We must ensure that the tasks currently needing reconciliation are the subset of what was being reconciled
                // ACTUALLY: The checkpoint stores the set of tasks that WERE being reconciled.
                // If the current set `tasksToReconcile` is DIFFERENT from `checkpoint.taskNames`, we cannot guarantee consistency.
                // Example: We were reconciling "A" and "B". Now we need to reconcile "A", "B", "C". We must start over to include "C" for the already processed range.
                // Example 2: We were reconciling "A". Now we need "A" and "B". Start over.
                // Example 3: We were reconciling "A" and "B". Now we need only "A". Technically we could resume, but for safety/simplicity, we restart if sets enforce strict equality.

                const savedTasksSet = new Set(checkpoint.taskNames);
                const currentTasksSet = tasksToReconcile;

                const areSetsEqual = savedTasksSet.size === currentTasksSet.size && [...savedTasksSet].every((t) => currentTasksSet.has(t));

                if (areSetsEqual) {
                    debug(`[Scheduler ${this.instanceId}] Resuming reconciliation for ${collectionName} from id: ${checkpoint.lastId}`);
                    lastId = checkpoint.lastId;
                    resume = true;
                } else {
                    debug(`[Scheduler ${this.instanceId}] Reconciliation checkpoint invalid (task definitions changed). Restarting.`);
                }
            }

            const pipeline: Document[] = [
                { $sort: { _id: 1 } }, // Ensure stable sort for checkpointing
                { $project: { _id: 1 } },
            ];

            if (resume && lastId) {
                pipeline.unshift({ $match: { _id: { $gt: lastId } } });
            }

            try {
                // Use processInBatches to iterate over source documents and trigger planning for batches
                await processInBatches(
                    entry.sourceCollection,
                    pipeline,
                    (doc) => doc._id, // Transform to ID
                    async (ids) => {
                        await this.ops.executePlanningPipeline(entry.tasksCollection.collectionName, ids, tasksToReconcile);

                        // Update Checkpoint
                        if (ids.length > 0) {
                            const lastProcessedId = ids[ids.length - 1];
                            const updatePath = `reconciliationState.${collectionName}`;
                            await this.globalsCollection.updateOne(
                                { _id: REACTIVE_TASK_META_DOC_ID },
                                {
                                    $set: {
                                        [`${updatePath}.lastId`]: lastProcessedId,
                                        [`${updatePath}.taskNames`]: Array.from(tasksToReconcile),
                                        [`${updatePath}.updatedAt`]: new Date(),
                                    },
                                },
                                { upsert: true },
                            );
                        }
                    },
                    {
                        batchSize: this.internalOptions.batchSize,
                        shouldStop,
                    },
                );

                if (shouldStop()) {
                    debug(`[Scheduler ${this.instanceId}] Reconciliation stopped during processing. Checkpoint preserved.`);
                    return;
                }
                debug(`[Scheduler ${this.instanceId}] Reconciled collection: ${entry.tasksCollection.collectionName}`);

                // Mark processed tasks as reconciled AND remove checkpoint
                const update: Document = {
                    $unset: {
                        [`reconciliationState.${collectionName}`]: '',
                    },
                };
                for (const taskName of tasksToReconcile) {
                    const taskDef = entry.tasks.get(taskName);
                    if (taskDef) {
                        await entry.repository.deleteOrphanedTasks(
                            taskName,
                            entry.sourceCollection.collectionName,
                            taskDef.filter || {},
                            taskDef.cleanupPolicyParsed,
                            shouldStop,
                        );
                    }
                    update.$set = update.$set || {};
                    update.$set[`reconciliation.${taskName}`] = true;
                }

                await this.globalsCollection.updateOne({ _id: REACTIVE_TASK_META_DOC_ID }, update, { upsert: true });
            } catch (error) {
                debug(`[Scheduler ${this.instanceId}] Error reconciling collection: ${entry.tasksCollection.collectionName}`, error);
                // Continue with other collections
            }
        }

        debug(`[Scheduler ${this.instanceId}] Reconciliation complete.`);

        try {
            await this.globalsCollection.updateOne({ _id: REACTIVE_TASK_META_DOC_ID }, { $set: { lastReconciledAt: new Date() } }, { upsert: true });
        } catch (e) {
            // Ignore error, metrics are best-effort
            debug(`[Scheduler ${this.instanceId}] Failed to update reconciliation timestamp`, e);
        }

        this.onInfo({
            message: `Reconciliation complete.`,
            code: CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED,
        });
    }

    public async markAsUnreconciled(taskNames: string[]): Promise<void> {
        if (taskNames.length === 0) return;
        const update: Document = { $unset: {} };
        for (const task of taskNames) {
            update.$unset[`reconciliation.${task}`] = '';
        }
        await this.globalsCollection.updateOne({ _id: REACTIVE_TASK_META_DOC_ID }, update, { upsert: true });
    }

    public async performPeriodicCleanup(shouldStop: () => boolean): Promise<void> {
        const now = Date.now();

        // Fast path: check in-memory cache first to avoid database query
        if (this.nextCleanupTime !== null && now < this.nextCleanupTime) {
            return;
        }

        // Slow path: query database to get accurate lastCleanupAt
        const metaDoc = (await this.globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID })) as MetaDocument | null;
        const lastCleanupDate = metaDoc?.lastCleanupAt ? new Date(metaDoc.lastCleanupAt) : undefined;

        // Calculate next run time based on last run
        const nextRun = this.internalOptions.getNextCleanupDate(lastCleanupDate);
        this.nextCleanupTime = nextRun.getTime();

        if (now < nextRun.getTime()) {
            return;
        }

        // Acquire lock to prevent parallel runs during deployment transitions
        const lockKey = `${REACTIVE_TASK_META_DOC_ID}:cleanup`;
        try {
            await withLock(
                lockKey,
                async () => {
                    // Double-check after acquiring lock
                    const freshMetaDoc = (await this.globalsCollection.findOne({ _id: REACTIVE_TASK_META_DOC_ID })) as MetaDocument | null;
                    const freshLastCleanupDate = freshMetaDoc?.lastCleanupAt ? new Date(freshMetaDoc.lastCleanupAt) : undefined;

                    const freshNextRun = this.internalOptions.getNextCleanupDate(freshLastCleanupDate);

                    if (now < freshNextRun.getTime()) {
                        this.nextCleanupTime = freshNextRun.getTime();
                        return;
                    }

                    debug(`[Scheduler ${this.instanceId}] Starting periodic cleanup of orphaned tasks.`);

                    const entries = this.registry.getAllEntries();
                    for (const entry of entries) {
                        if (shouldStop()) return;
                        for (const task of entry.tasks.values()) {
                            await entry.repository.deleteOrphanedTasks(
                                task.task,
                                entry.sourceCollection.collectionName,
                                task.filter || {},
                                task.cleanupPolicyParsed,
                                shouldStop,
                            );
                        }
                    }

                    // Update lastCleanupAt in meta document
                    const cleanupTime = new Date();
                    await this.globalsCollection.updateOne({ _id: REACTIVE_TASK_META_DOC_ID }, { $set: { lastCleanupAt: cleanupTime } }, { upsert: true });

                    // Update in-memory cache with next cleanup time
                    this.nextCleanupTime = this.internalOptions.getNextCleanupDate(cleanupTime).getTime();
                },
                { maxWaitForLock: 1000, expireIn: 5 * 60 * 1000 },
            );
        } catch {
            // Lock already acquired by another process, skip this run
            debug(`[Scheduler ${this.instanceId}] Cleanup skipped - lock already acquired`);
        }
    }
}
