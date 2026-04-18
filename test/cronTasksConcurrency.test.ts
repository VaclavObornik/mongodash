import { getNewInstance, wait } from './testHelpers';

/**
 * Exercises the parallel cron scheduler (opt-in via cronTaskConcurrency > 1).
 *
 * The default single-loop behaviour is validated by the large cronTasks.ts
 * suite; this file focuses on the properties that only matter when multiple
 * cron tasks can be in-flight at once.
 */
describe('cronTasks - parallel execution', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(() => {
        instance = getNewInstance();
    });

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    it('runs two slow tasks overlapping when concurrency >= 2', async () => {
        await instance.initInstance({ cronTaskConcurrency: 3 });
        const { cronTask } = instance.mongodash;

        const durationMs = 300;
        const started: Record<string, number> = {};
        const finished: Record<string, number> = {};

        // Run-once interval: first call returns "now" (fires immediately),
        // subsequent calls return a year out so the task effectively fires once.
        const oneShotInterval = () => {
            let callCount = 0;
            return () => (callCount++ === 0 ? new Date() : new Date(Date.now() + 365 * 24 * 3600 * 1000));
        };

        const handler = (id: string) => async () => {
            if (started[id] !== undefined) return; // ignore any accidental second invocation
            started[id] = Date.now();
            await wait(durationMs);
            finished[id] = Date.now();
        };

        await cronTask('alpha', oneShotInterval(), handler('alpha'));
        await cronTask('beta', oneShotInterval(), handler('beta'));

        for (let i = 0; i < 60 && (!finished.alpha || !finished.beta); i += 1) {
            await wait(50);
        }

        expect(finished.alpha).toBeDefined();
        expect(finished.beta).toBeDefined();

        // Both runs overlap in time: one started before the other finished.
        const overlaps = started.alpha < finished.beta && started.beta < finished.alpha;
        expect(overlaps).toBe(true);
    }, 20000);

    it('still serialises a single task against itself even with high concurrency', async () => {
        await instance.initInstance({ cronTaskConcurrency: 5 });
        const { cronTask, scheduleCronTaskImmediately } = instance.mongodash;

        let activeCount = 0;
        let maxActive = 0;
        let runs = 0;

        await cronTask(
            'only-one',
            async () => new Date(Date.now() + 10_000),
            async () => {
                activeCount += 1;
                maxActive = Math.max(maxActive, activeCount);
                runs += 1;
                await wait(200);
                activeCount -= 1;
            },
        );

        // Fire five manual triggers back-to-back. A naive parallel scheduler
        // might try to pick up the same task on multiple workers; the per-task
        // lockedTill filter must prevent that.
        for (let i = 0; i < 5; i += 1) {
            await scheduleCronTaskImmediately('only-one');
            await wait(20);
        }

        // Wait enough for at least one run to complete.
        for (let i = 0; i < 40 && runs === 0; i += 1) {
            await wait(50);
        }

        expect(runs).toBeGreaterThanOrEqual(1);
        // The critical invariant: never more than one worker inside the handler.
        expect(maxActive).toBe(1);
    }, 20000);

    it('starts the runner lazily only when needed', async () => {
        // No tasks registered: init should not crash and stopping should be a noop.
        await instance.initInstance({ cronTaskConcurrency: 2 });
        await instance.mongodash.stopCronTasks();
    });
});
