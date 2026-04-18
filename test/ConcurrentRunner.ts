import { ConcurrentRunner } from '../src/ConcurrentRunner';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ConcurrentRunner', () => {
    let runner: ConcurrentRunner;
    let tasks: string[] = [];

    beforeEach(() => {
        tasks = [];
    });

    afterEach(async () => {
        if (runner) {
            await runner.stop();
        }
    });

    it('should run tasks periodically', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 10, maxPollMs: 100, jitterMs: 0 });

        let callCount = 0;
        runner.start(async (name) => {
            tasks.push(name);
            callCount++;
        });

        await sleep(50);
        expect(callCount).toBeGreaterThan(1);
        expect(tasks[0]).toBe('col1');
    });

    it('should respect concurrency', async () => {
        runner = new ConcurrentRunner({ concurrency: 2 });
        runner.registerSource('col1', { minPollMs: 100, maxPollMs: 100, jitterMs: 0 });
        runner.registerSource('col2', { minPollMs: 100, maxPollMs: 100, jitterMs: 0 });
        runner.registerSource('col3', { minPollMs: 100, maxPollMs: 100, jitterMs: 0 });

        let running = 0;
        let maxRunning = 0;

        runner.start(async (_name) => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            await sleep(50);
            running--;
        });

        // Trigger speedups to ensure they all want to run
        runner.speedUp('col1');
        runner.speedUp('col2');
        runner.speedUp('col3');

        await sleep(200);
        expect(maxRunning).toBeLessThanOrEqual(2);
    });

    it('should speed up execution', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        // Long poll time
        runner.registerSource('col1', { minPollMs: 1000, maxPollMs: 1000, jitterMs: 0 });

        let callCount = 0;
        runner.start(async (_name) => {
            callCount++;
        });

        await sleep(50); // Let it run once
        const initialCount = callCount;

        runner.speedUp('col1');
        await sleep(10); // Should run almost immediately

        expect(callCount).toBeGreaterThan(initialCount);
    });

    it('should reset backoff on speedUp', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 50, maxPollMs: 1000, jitterMs: 0 });

        let callCount = 0;
        runner.start(async () => {
            callCount++;
        });

        // Wait enough time for backoff to increase significantly
        await sleep(300);

        const countBeforeSpeedUp = callCount;
        runner.speedUp('col1');
        await sleep(60); // Should run immediately and then again after minPollMs (50ms)

        expect(callCount).toBeGreaterThan(countBeforeSpeedUp);
    });

    it('should continue running tasks if work is found', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 100, maxPollMs: 1000, jitterMs: 0 });

        let workItems = 5;

        runner.start(async () => {
            if (workItems > 0) {
                workItems--;
                runner.speedUp('col1');
            }
        });

        await sleep(50); // Should process all 5 items very quickly, much faster than minPollMs * 5
        expect(workItems).toBe(0);
    });

    it('should handle errors in task execution gracefully', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 10, maxPollMs: 100, jitterMs: 0 });

        let callCount = 0;
        runner.start(async () => {
            callCount++;
            if (callCount === 1) {
                throw new Error('Task failed');
            }
        });

        await sleep(50);
        // Should continue processing despite the error
        expect(callCount).toBeGreaterThan(1);
    });

    it('should throw error when registering duplicate source', () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 100, maxPollMs: 100, jitterMs: 0 });
        expect(() => runner.registerSource('col1', { minPollMs: 100, maxPollMs: 100, jitterMs: 0 })).toThrow('Source col1 is already registered');
    });

    it('should handle dynamic registration of collections', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.start(async (name) => {
            tasks.push(name);
        });

        await sleep(20);
        runner.registerSource('col1', { minPollMs: 10, maxPollMs: 100, jitterMs: 0 });

        await sleep(50);
        expect(tasks).toContain('col1');
    });

    it('should ignore speedUp for unknown collections', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 1000, maxPollMs: 1000, jitterMs: 0 });

        let callCount = 0;
        runner.start(async () => {
            callCount++;
        });

        await sleep(20); // Let it run once
        const initialCount = callCount;

        // Should not crash or affect anything
        runner.speedUp('unknown-collection');

        await sleep(50);
        // Should not have triggered an extra run for col1 (still sleeping)
        expect(callCount).toBe(initialCount);
    });

    it('should handle start being called multiple times', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 10, maxPollMs: 100, jitterMs: 0 });

        let callCount = 0;
        const callback = async () => {
            callCount++;
        };

        runner.start(callback);
        runner.start(callback); // Second call should be ignored

        await sleep(50);
        expect(callCount).toBeGreaterThan(0);
        // Hard to test exact worker count without internal access, but we verify it doesn't crash
    });

    it('should handle stop being called multiple times', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.start(async () => {
            // no-op
        });

        await runner.stop();
        await runner.stop(); // Should be safe
    });

    // ------------------------------------------------------------------
    // Scheduler-race regressions. Each `it` pins a specific behaviour
    // introduced by the "close three scheduler races" refactor.
    // ------------------------------------------------------------------

    it('start() resets source schedule so a restart polls immediately despite prolonged nextRunAt', async () => {
        // High minPoll so the worker's natural back-off is much longer
        // than this test's window. Without the source reset in start()
        // the restarted worker would inherit a `nextRunAt = ~now + 1s`
        // set by prolongNextRun in the previous cycle and sleep the rest
        // of that 1s before noticing any new work.
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 1000, maxPollMs: 1000, jitterMs: 0 });

        let callCount = 0;
        const callback = async () => {
            callCount++;
        };

        // Cycle 1: one poll + worker enters sleep with prolonged nextRunAt.
        runner.start(callback);
        await sleep(30);
        expect(callCount).toBeGreaterThanOrEqual(1);

        // Stop mid-sleep. Source metadata (nextRunAt ~= now + 1000) persists.
        await runner.stop();

        const callsAfterRestart = callCount;

        // Cycle 2: restart. If start() resets nextRunAt to `now`, the
        // fresh worker polls immediately. Without the reset the first
        // iteration would compute timeToWait from the stale 1000ms value
        // and sleep ~950ms, missing our 100ms assertion window.
        runner.start(callback);
        await sleep(100);

        expect(callCount).toBeGreaterThan(callsAfterRestart);
    });

    it('setNextRunAt() after a concurrent speedUp does not push the signal back into the future', async () => {
        // Reproduces the race surfaced by cron tests: a task callback
        // (a) triggers speedUp to signal new work while running, and
        // (b) on return the scheduler commits setNextRunAt with a large
        // waitMs computed from pre-signal state. Without the no-op guard
        // (state.nextRunAt <= now  =>  skip write) setNextRunAt wins
        // and the signalled immediate poll is lost.
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 5000, maxPollMs: 5000, jitterMs: 0 });

        let callCount = 0;
        let signalled = false;
        runner.start(async () => {
            callCount++;
            if (!signalled) {
                signalled = true;
                runner.speedUp('col1');
                runner.setNextRunAt('col1', Date.now() + 60 * 60 * 1000);
            }
        });

        // minPollMs is 5000ms. Without the fix the worker would sleep
        // the full 5000ms after the first invocation and this 200ms
        // window would see only a single call. With the fix speedUp
        // survives and the worker invokes callback at least twice.
        await sleep(200);
        expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('setNextRunAt() with a future runAt still applies when nextRunAt is already future', async () => {
        // Negative case for the no-op guard: the standard "push next
        // poll forward" usage must continue to work when no speedUp
        // has pulled nextRunAt into the past.
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 50, maxPollMs: 50, jitterMs: 0 });

        let callCount = 0;
        runner.start(async () => {
            callCount++;
        });

        // Let one poll run; prolongNextRun sets nextRunAt ~= now + 50ms
        // (safely in the future from Date.now()'s perspective).
        await sleep(20);
        const callsAfterFirst = callCount;
        expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

        // Push next poll far beyond that back-off; write must apply.
        runner.setNextRunAt('col1', Date.now() + 1000);

        // Well past the 50ms back-off, well before the 1000ms target.
        await sleep(200);
        expect(callCount).toBe(callsAfterFirst);
    });
});
