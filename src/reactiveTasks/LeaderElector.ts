import * as _debug from 'debug';
import { ModifyResult, MongoClientClosedError } from 'mongodb';
import { GlobalsCollection } from '../globalsCollection';
import { defaultOnError, OnError } from '../OnError';
import { defaultOnInfo, OnInfo } from '../OnInfo';
import { CODE_REACTIVE_TASK_LEADER_LOCK_LOST, MetaDocument, REACTIVE_TASK_META_DOC_ID } from './ReactiveTaskTypes';

const debug = _debug('mongodash:reactiveTasks:leader');

/**
 * How long {@link LeaderElector.stop} waits for an in-flight election round.
 * Only needs to cover a single findOneAndUpdate round-trip; see the comment at
 * the await for why giving up early is safe.
 */
const STOP_WAIT_MS = 2000;

/** Timer-based delay that never keeps the process alive. */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    });
}

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
    // The election round currently in flight (if any). stop() awaits it so a
    // leadership acquired concurrently with shutdown is observed and released.
    private currentLoopPromise: Promise<void> | null = null;

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

        // Wait for any election round already in flight to settle. Without this,
        // a tryAcquireLock() that was mid-round when stop() ran could resolve
        // AFTER we checked _isLeader, acquire leadership, and leave the DB lock
        // held (blocking handoff for a full TTL) and the change stream running.
        //
        // The wait is BOUNDED: a round that has progressed into onBecomeLeader
        // runs the whole leader-startup path (legacy migration, evolution check,
        // change stream, initial reconcile), which on a large deployment takes
        // far longer than a SIGTERM grace period. Giving up early is safe -
        // tryAcquireLock re-checks isRunning after its write and releases the
        // lock itself - so this await only needs to cover the common case where
        // the round is a single in-flight round-trip.
        if (this.currentLoopPromise) {
            try {
                await Promise.race([this.currentLoopPromise, delay(STOP_WAIT_MS)]);
            } catch {
                // Already reported via onError inside the loop.
            }
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
                this.currentLoopPromise = null;
                if (this.isRunning) {
                    this.leaderTimer = setTimeout(() => {
                        this.currentLoopPromise = loop();
                    }, this.options.lockHeartbeatMs);
                }
            }
        };

        this.currentLoopPromise = loop();
        await this.currentLoopPromise;
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

            // stop() may have run while this findOneAndUpdate was in flight. Do
            // not transition into leadership during shutdown (that would start
            // the planner as it is being torn down); release the lock if this
            // round just wrote it so it is not held for a full TTL.
            if (!this.isRunning) {
                if (result.value?.lock?.instanceId === this.instanceId) {
                    await this.releaseLock();
                }
                return;
            }

            if (result.value?.lock?.instanceId === this.instanceId) {
                if (!this._isLeader) {
                    this._isLeader = true;
                    debug(`[Scheduler ${this.instanceId}] Leader lock acquired.`);
                    try {
                        await this.callbacks.onBecomeLeader();
                    } catch (err) {
                        // onBecomeLeader (planner start / reconcile) failed. Do NOT
                        // keep renewing the lock every heartbeat while never running
                        // the planner - that monopolizes leadership and halts task
                        // planning cluster-wide. Release the lock so another instance
                        // can take over, clean up any partial start, and surface the
                        // error. The next heartbeat re-attempts acquisition fresh.
                        this._isLeader = false;
                        try {
                            await this.callbacks.onLoseLeader();
                        } catch (loseErr) {
                            this.onError(loseErr as Error);
                        }
                        await this.releaseLock();
                        throw err;
                    }
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
