import * as _debug from 'debug';
import { ModifyResult, MongoClientClosedError } from 'mongodb';
import { GlobalsCollection } from '../globalsCollection';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { CODE_REACTIVE_TASK_LEADER_LOCK_LOST, MetaDocument, REACTIVE_TASK_META_DOC_ID } from './ReactiveTaskTypes';

const debug = _debug('mongodash:reactiveTasks:leader');

export interface LeaderElectorCallbacks {
    onBecomeLeader: () => Promise<void>;
    onLoseLeader: () => Promise<void>;
    onHeartbeat: () => Promise<void>;
}

export interface LeaderElectorOptions {
    lockTtlMs: number;
    lockHeartbeatMs: number;
    metaDocId?: string;
}

/**
 * Manages leader election among multiple scheduler instances.
 *
 * Responsibilities:
 * - Attempts to acquire a distributed lock in the globals collection.
 * - Maintains the lock by periodically renewing it (heartbeat).
 * - Notifies callbacks when the instance becomes leader or loses leadership.
 * - Ensures only one instance (the leader) runs the `ReactiveTaskPlanner` at a time.
 */
export class LeaderElector {
    private isRunning = false;
    private _isLeader = false;
    private leaderTimer: NodeJS.Timeout | null = null;
    private metaDocId = REACTIVE_TASK_META_DOC_ID;

    constructor(
        private globalsCollection: GlobalsCollection,
        private instanceId: string,
        private options: LeaderElectorOptions,
        private callbacks: LeaderElectorCallbacks,
        private onInfo: OnInfo = defaultOnInfo,
        private onError: OnError = defaultOnError,
    ) {
        this.metaDocId = options.metaDocId || this.metaDocId;
    }

    public get isLeader(): boolean {
        return this._isLeader;
    }

    public async start(): Promise<void> {
        if (this.isRunning) return;
        this.isRunning = true;
        await this.runLeaderElectionLoop();
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) return;
        this.isRunning = false;

        if (this.leaderTimer) {
            clearTimeout(this.leaderTimer);
            this.leaderTimer = null;
        }

        if (this._isLeader) {
            await this.releaseLock();
            this._isLeader = false;
        }
    }

    /**
     * Give up leadership locally. The DB lock is NOT released - the next
     * heartbeat will likely re-acquire it (unless another instance raced
     * in). onLoseLeader is fired asynchronously so callers (e.g. the
     * scheduler wiring this to a flush-failure path) get a clean
     * planner.stop() before the next heartbeat restarts it, rather than
     * starting a new planner on top of a live one.
     *
     * Note: the follow-up onBecomeLeader that fires after a forced loss
     * looks identical to a real leader election and will increment
     * reactive_tasks_leader_elections_total; see the event codes
     * CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR and the flush-failure
     * counter to disambiguate "real" flapping from restart-driven ones.
     */
    public forceLoseLeader(): void {
        if (!this._isLeader) return;
        this._isLeader = false;
        // Fire-and-forget: we are sync and the caller does not await.
        this.callbacks.onLoseLeader().catch((err) => this.onError(err as Error));
    }

    private async runLeaderElectionLoop(): Promise<void> {
        const loop = async () => {
            try {
                await this.tryAcquireLock();

                if (this._isLeader) {
                    await this.callbacks.onHeartbeat();
                }
            } catch (error) {
                this.onError(error as Error);
            } finally {
                if (this.isRunning) {
                    this.leaderTimer = setTimeout(loop, this.options.lockHeartbeatMs);
                }
            }
        };

        await loop();
    }

    private async tryAcquireLock(): Promise<void> {
        const now = new Date();
        const expiresAt = new Date(now.getTime() + this.options.lockTtlMs);

        try {
            debug(`[Scheduler ${this.instanceId}] Trying to acquire lock on ${this.metaDocId} in ${this.globalsCollection.collectionName}`);

            const updatePipeline = [
                {
                    $set: {
                        lock: {
                            $cond: {
                                if: {
                                    $or: [
                                        { $lt: ['$lock.expiresAt', now] },
                                        { $eq: ['$lock.expiresAt', null] },
                                        { $eq: ['$lock', null] },
                                        { $eq: ['$lock.instanceId', this.instanceId] },
                                    ],
                                },
                                then: { expiresAt, instanceId: this.instanceId },
                                else: '$lock',
                            },
                        },
                    },
                },
            ];

            const result = (await this.globalsCollection.findOneAndUpdate({ _id: this.metaDocId }, updatePipeline, {
                upsert: true,
                returnDocument: 'after',
                includeResultMetadata: true,
            })) as unknown as ModifyResult<MetaDocument>;

            if (result.value?.lock?.instanceId === this.instanceId) {
                if (!this._isLeader) {
                    this._isLeader = true;
                    debug(`[Scheduler ${this.instanceId}] Leader lock acquired.`);
                    await this.callbacks.onBecomeLeader();
                }
            } else {
                if (this._isLeader) {
                    this._isLeader = false;
                    this.onInfo({ message: `Leader lock lost.`, code: CODE_REACTIVE_TASK_LEADER_LOCK_LOST });
                    await this.callbacks.onLoseLeader();
                }
            }
        } catch (error) {
            const closedErrorAfterStop = !this.isRunning && error instanceof MongoClientClosedError;
            if (!closedErrorAfterStop) {
                this.onError(error as Error);
            }

            if (this._isLeader) {
                this._isLeader = false;
                await this.callbacks.onLoseLeader();
            }
        }
    }

    private async releaseLock(): Promise<void> {
        try {
            await this.globalsCollection.updateOne(
                {
                    _id: this.metaDocId,
                    'lock.instanceId': this.instanceId,
                },
                { $unset: { lock: '' } },
            );
            debug(`[Scheduler ${this.instanceId}] Leader lock released.`);
        } catch (error) {
            this.onError(error as Error);
        }
    }
}
