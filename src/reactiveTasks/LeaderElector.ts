import { MongoClientClosedError, ModifyResult } from 'mongodb';
import { GlobalsCollection } from '../globalsCollection';
import { MetaDocument, CODE_REACTIVE_TASK_LEADER_LOCK_LOST, REACTIVE_TASK_META_DOC_ID } from './ReactiveTaskTypes';
import * as _debug from 'debug';
import { OnInfo, defaultOnInfo } from '../OnInfo';
import { OnError, defaultOnError } from '../OnError';

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

    public forceLoseLeader(): void {
        this._isLeader = false;
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
