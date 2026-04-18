import * as assert from 'assert';
import { noop, times } from 'lodash';
import { Collection } from 'mongodb';
import * as sinon from 'sinon';
import { getNewInstance, wait, waitUntil } from './testHelpers';

/**
 * Parallel-runner behavior tests for the opt-in `cronTaskConcurrency > 1`
 * execution mode. These scenarios are not exercised by cronTasks.behavior.ts
 * (which runs the default concurrency=1 serial loop).
 */
interface TaskDocument {
    _id: string;
    runSince: Date;
    runImmediately: boolean;
    lockedTill: null | Date;
    runLog: { startedAt: Date; finishedAt: Date | null; error: string | null }[];
}

describe('cronTasks - parallel runner (cronTaskConcurrency > 1)', () => {
    const DISTANT_FUTURE_MS = 24 * 60 * 60 * 1000;
    const distantFuture = () => new Date(Date.now() + DISTANT_FUTURE_MS);

    let taskSeq = 0;
    const nextTaskId = () => `par-task-${++taskSeq}`;

    function makeTrackedHandler(cb: () => unknown | Promise<unknown> = noop) {
        const callTimes: { startedAt: Date; finishedAt: Date }[] = [];
        const handler = sinon.spy(async () => {
            const startedAt = new Date();
            try {
                await cb();
            } finally {
                callTimes.push({ startedAt, finishedAt: new Date() });
            }
        });
        return { handler, callTimes };
    }

    function runOnceIn(afterMs = 0) {
        let call = 0;
        return () => (call++ === 0 ? new Date(Date.now() + afterMs) : distantFuture());
    }

    async function withInstance<T>(
        concurrency: number,
        fn: (ctx: { mongodash: ReturnType<typeof getNewInstance>['mongodash']; collection: Collection<TaskDocument>; onError: sinon.SinonSpy }) => Promise<T>,
    ): Promise<T> {
        const instance = getNewInstance();
        const onError = sinon.spy();
        instance.setOnError(onError);
        try {
            await instance.initInstance({ cronTaskConcurrency: concurrency });
            const collection = instance.mongodash.getCollection<TaskDocument>('cronTasks');
            await collection.deleteMany({});
            instance.mongodash.startCronTasks();
            return await fn({ mongodash: instance.mongodash, collection, onError });
        } finally {
            await instance.cleanUpInstance();
        }
    }

    it('starts lazily: init + stop with zero tasks must not crash', async () => {
        const instance = getNewInstance();
        try {
            await instance.initInstance({ cronTaskConcurrency: 2 });
            // no cronTask registrations
            instance.mongodash.stopCronTasks();
        } finally {
            await instance.cleanUpInstance();
        }
    });

    it('allows multiple distinct tasks to be in-flight simultaneously', async () => {
        await withInstance(4, async ({ mongodash }) => {
            let inFlight = 0;
            let maxInFlight = 0;
            const TASK_COUNT = 8;
            const HANDLER_MS = 300;

            const trackers = times(TASK_COUNT, () =>
                makeTrackedHandler(async () => {
                    inFlight += 1;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    await wait(HANDLER_MS);
                    inFlight -= 1;
                }),
            );

            await Promise.all(trackers.map((t) => mongodash.cronTask(nextTaskId(), runOnceIn(0), t.handler)));

            await waitUntil(() => trackers.every((t) => t.callTimes.length >= 1), {
                timeoutMs: 15000,
                message: `all ${TASK_COUNT} tasks completed`,
            });

            // Each handler holds the in-flight counter for HANDLER_MS. With
            // concurrency=4 and many pending tasks ready at once, the runner
            // must process at least two in parallel at some point (actual
            // peak depends on ConcurrentRunner back-off dynamics; we assert
            // the lower bound "not serial").
            assert(maxInFlight >= 2, `expected overlap >= 2, got ${maxInFlight}`);
        });
    });

    it('concurrency=1 (serial) does NOT overlap (sanity-check baseline)', async () => {
        await withInstance(1, async ({ mongodash }) => {
            let inFlight = 0;
            let maxInFlight = 0;
            const trackers = times(4, () =>
                makeTrackedHandler(async () => {
                    inFlight += 1;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    await wait(150);
                    inFlight -= 1;
                }),
            );

            await Promise.all(trackers.map((t) => mongodash.cronTask(nextTaskId(), runOnceIn(0), t.handler)));
            await waitUntil(() => trackers.every((t) => t.callTimes.length >= 1), {
                timeoutMs: 10000,
                message: 'all 4 tasks completed',
            });

            assert.strictEqual(maxInFlight, 1, 'serial loop must not overlap');
        });
    });

    it('same taskId is never processed by two workers simultaneously (DB lock honoured)', async () => {
        await withInstance(4, async ({ mongodash }) => {
            let inFlight = 0;
            let maxInFlight = 0;

            const { handler, callTimes } = makeTrackedHandler(async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await wait(100);
                inFlight -= 1;
            });

            const runTimes = [new Date(Date.now() + 50), new Date(Date.now() + 60), new Date(Date.now() + 70)];
            let call = 0;
            const interval = () => (call < runTimes.length ? runTimes[call++] : distantFuture());

            await mongodash.cronTask(nextTaskId(), interval, handler);
            await waitUntil(() => callTimes.length >= runTimes.length, {
                timeoutMs: 5000,
                message: 'all scheduled runs executed',
            });

            assert.strictEqual(maxInFlight, 1, 'a single taskId must not overlap with itself');
        });
    });

    it('rapid stop+start leaves the runner healthy (runnerStopPromise regression)', async () => {
        await withInstance(4, async ({ mongodash }) => {
            // Start already happens inside withInstance. Now stop+start rapidly.
            mongodash.stopCronTasks();
            mongodash.startCronTasks();

            const { handler, callTimes } = makeTrackedHandler();
            await mongodash.cronTask(nextTaskId(), runOnceIn(50), handler);

            await waitUntil(() => callTimes.length >= 1, {
                timeoutMs: 3000,
                message: 'runner must be healthy after rapid stop+start',
            });
        });
    });

    it('a task registered while the runner is idle is picked up promptly (pendingWake)', async () => {
        await withInstance(4, async ({ mongodash }) => {
            // Let the runner settle with no tasks - it should be idle-waiting.
            await wait(300);

            const { handler, callTimes } = makeTrackedHandler();
            await mongodash.cronTask(nextTaskId(), runOnceIn(0), handler);

            await waitUntil(() => callTimes.length >= 1, {
                timeoutMs: 3000,
                message: 'mid-iteration registered task runs promptly',
            });
        });
    });

    it('a failing task propagates to onError and the scheduler continues', async () => {
        await withInstance(4, async ({ mongodash, onError }) => {
            const err = new Error('parallel-boom');
            const failing = makeTrackedHandler(() => {
                throw err;
            });
            const succeeding = makeTrackedHandler();

            await mongodash.cronTask(nextTaskId(), runOnceIn(50), failing.handler);
            await mongodash.cronTask(nextTaskId(), runOnceIn(60), succeeding.handler);

            await waitUntil(() => failing.callTimes.length >= 1 && succeeding.callTimes.length >= 1, {
                timeoutMs: 5000,
                message: 'both tasks executed (failing + succeeding)',
            });
            await waitUntil(() => onError.callCount >= 1, { timeoutMs: 2000, message: 'onError fired' });

            assert.strictEqual((onError.firstCall.args[0] as Error).message, 'parallel-boom');
            assert.strictEqual(succeeding.handler.callCount, 1);
        });
    });

    it('stopCronTasks halts parallel execution and returns void', async () => {
        await withInstance(4, async ({ mongodash }) => {
            const trackers = times(3, () => makeTrackedHandler());

            // Repeating interval: each task re-schedules itself 50ms after every
            // run. If stopCronTasks does not actually halt the scheduler, the
            // post-stop assertion will fire because new runs keep accumulating.
            // (A one-shot interval would make this test trivially pass.)
            const repeating = () => new Date(Date.now() + 50);
            await Promise.all(trackers.map((t) => mongodash.cronTask(nextTaskId(), repeating, t.handler)));
            await waitUntil(() => trackers.every((t) => t.callTimes.length >= 2), {
                timeoutMs: 5000,
                message: 'each task fired at least twice (scheduler actively running)',
            });
            const runsAtStop = trackers.map((t) => t.callTimes.length);

            const result: void = mongodash.stopCronTasks();
            assert.strictEqual(result, undefined, 'stopCronTasks must return void');

            // Wait longer than several re-fire intervals. An in-flight worker may
            // still add one final run after stopCronTasks (fire-and-forget stop);
            // more than that indicates stopCronTasks did not actually halt.
            await wait(500);
            trackers.forEach((t, i) => {
                const delta = t.callTimes.length - runsAtStop[i];
                assert(delta <= 1, `tracker ${i}: ${runsAtStop[i]} -> ${t.callTimes.length} (+${delta}) — scheduler must halt`);
            });
        });
    });
});
