import * as _debug from 'debug';
import { defaultOnError, OnError } from './OnError';

const debug = _debug('mongodash:ConcurrentRunner');

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
}

export type TryRunATaskCallback = (sourceName: string) => Promise<void>;

export class ConcurrentRunner {
    private options: ConcurrentRunnerOptions;
    private sources: Map<string, SourceState> = new Map();
    private isRunning = false;
    private workers: Promise<void>[] = [];
    private wakeUpSignals: (() => void)[] = [];
    private tryRunATask: TryRunATaskCallback | null = null;

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

        for (let i = 0; i < this.options.concurrency; i++) {
            this.workers.push(this.runWorker());
        }
        debug(`Started with ${this.options.concurrency} workers`);
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
            this.wakeUpOneWorker();
            debug(`SpeedUp called for ${sourceName}`);
        }
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

                try {
                    await this.tryRunATask!(state.name);
                } catch (e) {
                    this.onError(e as Error);
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
}
