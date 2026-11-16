import { defaultOnError, OnError } from './OnError';

// Note: this file uses require() for the `debug` import on purpose - the
// rest of the codebase uses `import * as _debug from 'debug'`, but this
// module is transitively pulled into the dashboard's vue-tsc build (via
// task-management/types.ts -> cronTasks.ts -> ConcurrentRunner.ts), and
// vue-tsc runs in stricter ESM mode where the namespace-style import is
// not callable. require() sidesteps that while keeping runtime identical.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const debug = require('debug')('mongodash:ConcurrentRunner') as (...args: unknown[]) => void;

export interface ConcurrentRunnerOptions {
    concurrency: number;
}

export interface SourceOptions {
    minPollMs: number;
    maxPollMs: number;
    jitterMs: number;
}

interface SourceState {
    name: string;
    options: SourceOptions;
    nextRunAt: number;
    currentBackoff: number;
    // Bumped on every schedule change; a poll's result applies only if it is unchanged.
    scheduleVersion: number;
}

/** Handle for the poll that is currently running a {@link TryRunATaskCallback}. */
export interface PollContext {
    /**
     * Schedule the next poll of this source at `runAt` (a millisecond epoch
     * timestamp), e.g. when the poll already knows when the next work is due.
     *
     * If the schedule changed after this poll started (a
     * {@link ConcurrentRunner.speedUp} or a newer poll by another worker),
     * this poll's result may be stale, so it can only move the next poll
     * earlier. Non-finite values are ignored.
     */
    setNextRunAt(runAt: number): void;
}

export type TryRunATaskCallback = (sourceName: string, poll: PollContext) => Promise<void>;

export class ConcurrentRunner {
    private options: ConcurrentRunnerOptions;
    private sources: Map<string, SourceState> = new Map();
    private isRunning = false;
    private workers: Promise<void>[] = [];
    private wakeUpSignals: (() => void)[] = [];
    private tryRunATask: TryRunATaskCallback | null = null;
    private _activeWorkerCount = 0;

    constructor(
        options: ConcurrentRunnerOptions,
        private onError: OnError = defaultOnError,
    ) {
        this.options = options;
    }

    public registerSource(name: string, options: SourceOptions): void {
        if (this.sources.has(name)) {
            throw new Error(`Source ${name} is already registered.`);
        }
        this.sources.set(name, {
            name,
            options,
            nextRunAt: Date.now(),
            currentBackoff: options.minPollMs,
            scheduleVersion: 0,
        });
        this.wakeUpOneWorker();
    }

    public hasSource(name: string): boolean {
        return this.sources.has(name);
    }

    public start(tryRunATask: TryRunATaskCallback): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.tryRunATask = tryRunATask;

        // Source metadata is intentionally preserved across stop() (callers
        // may re-use the same runner instance), but a stale nextRunAt from
        // a previous cycle would otherwise make freshly spawned workers
        // sleep for the remainder of that (possibly hour-long) window
        // before noticing new work. Reset schedules so a fresh start polls
        // immediately.
        const now = Date.now();
        for (const state of this.sources.values()) {
            state.nextRunAt = now;
            state.currentBackoff = state.options.minPollMs;
            state.scheduleVersion++;
        }

        // Guard against a misconfigured concurrency (negative, NaN or
        // fractional): zero workers would report success while every task
        // silently stalls. An explicit 0 is kept - it deliberately runs no
        // workers here (e.g. a planner-only instance) and predates the guard.
        const requested = Number(this.options.concurrency);
        const effectiveConcurrency = requested === 0 ? 0 : Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 1);

        for (let i = 0; i < effectiveConcurrency; i++) {
            this.workers.push(this.runWorker());
        }
        debug(`Started with ${effectiveConcurrency} workers`);
    }

    public async stop(): Promise<void> {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.wakeUpAllWorkers();
        await Promise.all(this.workers);
        this.workers = [];
        debug('Stopped');
    }

    public speedUp(sourceName: string): void {
        const state = this.sources.get(sourceName);
        if (state) {
            // Reset backoff and schedule immediately
            state.currentBackoff = state.options.minPollMs;
            state.nextRunAt = Date.now();
            state.scheduleVersion++;
            this.wakeUpOneWorker();
            debug(`SpeedUp called for ${sourceName}`);
        }
    }

    private createPollContext(state: SourceState): PollContext {
        const pollVersion = state.scheduleVersion;
        return {
            setNextRunAt: (runAt: number) => {
                if (!Number.isFinite(runAt)) return;
                if (state.scheduleVersion === pollVersion) {
                    state.currentBackoff = state.options.minPollMs;
                    state.scheduleVersion++;
                } else if (runAt >= state.nextRunAt) {
                    return;
                }
                state.nextRunAt = runAt;
                // Wake workers so any currently-sleeping one can recompute its wait.
                this.wakeUpAllWorkers();
            },
        };
    }

    public updateAllSources(options: Partial<SourceOptions>): void {
        for (const state of this.sources.values()) {
            state.options = { ...state.options, ...options };
            // If we are lowering the minPollMs, we should probably also lower the current backoff
            // to respect the new settings immediately.
            if (options.minPollMs !== undefined && state.currentBackoff > options.minPollMs) {
                state.currentBackoff = options.minPollMs;
            }
            if (options.maxPollMs !== undefined && state.currentBackoff > options.maxPollMs) {
                state.currentBackoff = options.maxPollMs;
            }
        }
        // Wake up everyone to pick up new schedule/backoff
        this.wakeUpAllWorkers();
    }

    private async runWorker(): Promise<void> {
        while (this.isRunning) {
            const now = Date.now();
            let bestSource: SourceState | null = null;
            let minNextRunAt = Infinity;

            // Find the source that needs to run soonest
            for (const state of this.sources.values()) {
                if (state.nextRunAt < minNextRunAt) {
                    minNextRunAt = state.nextRunAt;
                    bestSource = state;
                }
            }

            if (bestSource && minNextRunAt <= now) {
                // Run task for this source
                const state = bestSource;

                // we always prolong the next run and schedule the next search before the current search
                // if there is a task found, the tryRunATask is suppsed to call the speedUp method,
                // which will reset the backoff
                this.prolongNextRun(state.name);
                const poll = this.createPollContext(state);

                try {
                    this._activeWorkerCount++;
                    await this.tryRunATask!(state.name, poll);
                } catch (e) {
                    this.onError(e as Error);
                } finally {
                    this._activeWorkerCount--;
                }
            } else {
                // No source is ready to run. Sleep until the nearest scheduled time.
                let timeToWait = 0;
                if (minNextRunAt === Infinity) {
                    timeToWait = 1000; // Default wait if no sources
                } else {
                    timeToWait = Math.max(0, minNextRunAt - now);
                }
                await this.sleep(timeToWait);
            }
        }
    }

    private prolongNextRun(sourceName: string): void {
        const state = this.sources.get(sourceName)!;
        const sleepTime = state.currentBackoff + Math.random() * state.options.jitterMs;
        state.nextRunAt = Date.now() + sleepTime;
        state.scheduleVersion++;
        // Increase backoff for next time
        state.currentBackoff = Math.min(state.currentBackoff * 2, state.options.maxPollMs);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            if (ms <= 0) return resolve();

            let timer: NodeJS.Timeout;
            const wakeUp = () => {
                clearTimeout(timer);
                // Remove this wakeUp from the list if it's there (it might be called by speedUp)
                const index = this.wakeUpSignals.indexOf(wakeUp);
                if (index !== -1) {
                    this.wakeUpSignals.splice(index, 1);
                }
                resolve();
            };

            this.wakeUpSignals.push(wakeUp);
            timer = setTimeout(wakeUp, ms);
        });
    }

    private wakeUpOneWorker(): void {
        const wakeUp = this.wakeUpSignals.shift();
        if (wakeUp) {
            wakeUp();
        }
    }

    private wakeUpAllWorkers(): void {
        while (this.wakeUpSignals.length > 0) {
            const wakeUp = this.wakeUpSignals.shift();
            if (wakeUp) {
                wakeUp();
            }
        }
    }

    public get activeWorkers(): number {
        return this._activeWorkerCount;
    }
}
