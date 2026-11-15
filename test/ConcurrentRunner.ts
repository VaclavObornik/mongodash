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

    it.each([[-3], [NaN], [1.9]])('clamps a misconfigured concurrency (%p) to at least one worker', async (concurrency) => {
        runner = new ConcurrentRunner({ concurrency: concurrency as number });
        runner.registerSource('col1', { minPollMs: 10, maxPollMs: 100, jitterMs: 0 });

        let callCount = 0;
        runner.start(async () => {
            callCount++;
        });

        await sleep(50);
        // Without the clamp, negative/NaN would spawn zero workers and callCount stays 0.
        expect(callCount).toBeGreaterThan(0);
    });

    it('an explicit concurrency of 0 runs no workers (pre-2.9.0 planner-only semantics)', async () => {
        runner = new ConcurrentRunner({ concurrency: 0 });
        runner.registerSource('col1', { minPollMs: 10, maxPollMs: 100, jitterMs: 0 });

        let callCount = 0;
        runner.start(async () => {
            callCount++;
        });

        await sleep(50);
        expect(callCount).toBe(0);
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

    it('poll.setNextRunAt() after a concurrent speedUp does not push the signal back into the future', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 5000, maxPollMs: 5000, jitterMs: 0 });

        let callCount = 0;
        let signalled = false;
        runner.start(async (_name, poll) => {
            callCount++;
            if (!signalled) {
                signalled = true;
                runner.speedUp('col1');
                poll.setNextRunAt(Date.now() + 60 * 60 * 1000);
            }
        });

        await sleep(200);
        expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('poll.setNextRunAt() applies when nothing changed the schedule during the poll', async () => {
        runner = new ConcurrentRunner({ concurrency: 1 });
        runner.registerSource('col1', { minPollMs: 50, maxPollMs: 50, jitterMs: 0 });

        let callCount = 0;
        runner.start(async (_name, poll) => {
            callCount++;
            poll.setNextRunAt(Date.now() + 1000);
        });

        await sleep(200);
        expect(callCount).toBe(1);
    });

    it('poll.setNextRunAt() from an older poll does not override the schedule of a newer poll', async () => {
        runner = new ConcurrentRunner({ concurrency: 2 });
        runner.registerSource('col1', { minPollMs: 5000, maxPollMs: 5000, jitterMs: 0 });

        let releaseOlderPoll!: () => void;
        const olderPollGate = new Promise<void>((resolve) => (releaseOlderPoll = resolve));
        let callCount = 0;
        runner.start(async (_name, poll) => {
            callCount++;
            if (callCount === 1) {
                await olderPollGate;
                poll.setNextRunAt(Date.now() + 60 * 60 * 1000);
            } else if (callCount === 2) {
                poll.setNextRunAt(Date.now() + 50);
            }
        });

        await sleep(20);
        runner.speedUp('col1');
        await sleep(20);
        expect(callCount).toBe(2);
        releaseOlderPoll();

        await sleep(300);
        expect(callCount).toBeGreaterThanOrEqual(3);
    });
});
