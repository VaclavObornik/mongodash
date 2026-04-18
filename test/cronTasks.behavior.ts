import * as assert from 'assert';
import { noop, times } from 'lodash';
import { Collection } from 'mongodb';
import * as sinon from 'sinon';
import { getNewInstance, wait, waitUntil } from './testHelpers';

/**
 * Behavior-level cron task tests.
 *
 * Rules:
 *   - NO sinon stubs on Mongo driver methods (findOneAndUpdate/updateOne/…);
 *     the implementation is observed only through the public API and the
 *     persisted document.
 *   - NO sandbox.useFakeTimers + sandbox.clock.tick(Xms); we let real time run
 *     and poll via waitUntil(). Tests stay below a few seconds.
 *   - No assertions on specific internal call counts (e.g. "findOne was called
 *     twice"). Tests assert only observable outcomes (task ran N times,
 *     document state, onInfo/onError events, getCronTasksList output).
 *
 * Scheduling-semantics tests live in cronTasks.scheduling.ts. Internal race
 * regressions (lock prolong, runImmediately revert, DB crash recovery) live
 * in cronTasks.races.regression.ts.
 */
interface TaskDocument {
    _id: string;
    runSince: Date;
    runImmediately: boolean;
    lockedTill: null | Date;
    runLog: { startedAt: Date; finishedAt: Date | null; error: string | null }[];
}

describe('cronTasks - behavior', () => {
    const { mongodash, setOnError, initInstance, cleanUpInstance } = getNewInstance();
    const { cronTask, getCollection, startCronTasks, stopCronTasks } = mongodash;

    let collection: Collection<TaskDocument>;
    let onError: sinon.SinonSpy;
    let taskSeq = 0;
    const nextTaskId = () => `behav-task-${++taskSeq}`;

    const SHORT = 150; // ms – short schedule offset for "eventually runs" tests
    const DISTANT_FUTURE_MS = 24 * 60 * 60 * 1000;
    const distantFuture = () => new Date(Date.now() + DISTANT_FUTURE_MS);

    beforeAll(async () => {
        await initInstance();
        collection = getCollection<TaskDocument>('cronTasks');
    });

    afterAll(() => cleanUpInstance());

    beforeEach(async () => {
        await collection.deleteMany({});
        onError = sinon.spy();
        setOnError(onError);
        startCronTasks();
    });

    afterEach(() => stopCronTasks());

    async function getDocument(taskId: string): Promise<TaskDocument> {
        const doc = await collection.findOne({ _id: taskId });
        if (!doc) throw new Error(`task ${taskId} not persisted`);
        return doc;
    }

    /**
     * Create a tracked task handler whose run-count, start/finish timestamps
     * and `waitForNextRun()` are observable. The handler optionally delegates
     * to a user callback.
     */
    function makeTask(cb: () => unknown | Promise<unknown> = noop) {
        const taskId = nextTaskId();
        const callTimes: { startedAt: Date; finishedAt: Date }[] = [];
        let nextRunResolve: ((value: null) => void) | null = null;

        const handler = sinon.spy(async () => {
            const startedAt = new Date();
            try {
                await cb();
            } finally {
                callTimes.push({ startedAt, finishedAt: new Date() });
                const resolve = nextRunResolve;
                nextRunResolve = null;
                if (resolve) resolve(null);
            }
        });

        const waitForNextRun = (timeoutMs = 3000): Promise<null> =>
            new Promise((resolve, reject) => {
                nextRunResolve = resolve;
                setTimeout(() => {
                    if (nextRunResolve) {
                        nextRunResolve = null;
                        reject(new Error(`waitForNextRun timed out after ${timeoutMs}ms for ${taskId}`));
                    }
                }, timeoutMs);
            });

        return { taskId, handler, waitForNextRun, callTimes };
    }

    /** Schedule a task to its first run 'afterMs' from now, then the distant future. */
    function runOnceIn(afterMs = 0) {
        let call = 0;
        return () => (call++ === 0 ? new Date(Date.now() + afterMs) : distantFuture());
    }

    /** Schedule to a list of exact dates, then distant future. */
    function scheduleAt(...dates: Date[]) {
        let call = 0;
        return () => (call < dates.length ? dates[call++] : distantFuture());
    }

    describe('registration', () => {
        it('runs a registered task automatically', async () => {
            const { taskId, handler, waitForNextRun } = makeTask();

            await cronTask(taskId, runOnceIn(), handler);
            await waitForNextRun();

            assert.strictEqual(handler.callCount, 1);
            assert(onError.notCalled);
        });

        it('persists the task document with the expected shape', async () => {
            const { taskId, handler } = makeTask();
            const runAt = new Date('2050-01-01T00:00:00Z');

            await cronTask(taskId, () => runAt, handler);

            assert.deepStrictEqual(await getDocument(taskId), {
                _id: taskId,
                runImmediately: false,
                lockedTill: null,
                runLog: [],
                runSince: runAt,
            });
        });

        it('rejects re-registering the same taskId twice', async () => {
            const { taskId, handler } = makeTask();
            await cronTask(taskId, distantFuture, handler);

            await assert.rejects(() => cronTask(taskId, distantFuture, handler), new RegExp(`The taskId '${taskId}' is already used\\.`));
        });

        it('accepts a task whose document already exists in the DB (another process)', async () => {
            const first = makeTask();
            const second = makeTask();

            await cronTask(first.taskId, distantFuture, first.handler);
            const firstDoc = await getDocument(first.taskId);
            await collection.insertOne({ ...firstDoc, _id: second.taskId });

            // must not throw - another process owns it; we just attach a handler.
            await cronTask(second.taskId, distantFuture, second.handler);
        });

        it('allows registering tasks before init() - they run once init resolves', async () => {
            const instance = getNewInstance();
            const { taskId, handler } = makeTask();

            const registrationPromise = instance.mongodash.cronTask(taskId, runOnceIn(), handler);

            await wait(150);
            assert.strictEqual(handler.callCount, 0, 'task must not run before init');

            await instance.initInstance();
            await registrationPromise;
            await waitUntil(() => handler.callCount >= 1, { timeoutMs: 3000, message: 'task runs once init resolves' });

            assert.strictEqual(handler.callCount, 1);
            await instance.cleanUpInstance();
        });

        it('a newly registered task starts promptly after the current one finishes', async () => {
            let second: ReturnType<typeof makeTask>;

            const first = makeTask(async () => {
                second = makeTask();
                await cronTask(second.taskId, runOnceIn(), second.handler);
                await wait(50);
            });

            await cronTask(first.taskId, runOnceIn(), first.handler);
            await first.waitForNextRun();
            await second!.waitForNextRun();

            const gap = second!.callTimes[0].startedAt.getTime() - first.callTimes[0].finishedAt.getTime();
            assert(gap >= 0, `second must start after first finished (gap: ${gap}ms)`);
            assert(gap < 500, `second must not wait too long (gap: ${gap}ms)`);
        });

        it.each(times(3, String))('a newly registered task starts promptly when idle [%i]', async () => {
            const first = makeTask(() => wait(50));
            const firstRun = first.waitForNextRun();
            await cronTask(first.taskId, runOnceIn(), first.handler);
            await firstRun;

            // let the loop settle into idle
            await wait(100);

            const second = makeTask(() => wait(50));
            const secondRun = second.waitForNextRun();
            await cronTask(second.taskId, runOnceIn(), second.handler);
            await secondRun;

            assert.strictEqual(first.handler.callCount, 1);
            assert.strictEqual(second.handler.callCount, 1);
        });
    });

    describe('runImmediately flag', () => {
        // The preferred public way to set runImmediately is scheduleCronTaskImmediately(),
        // which both flips the flag and wakes the scheduler. The raw-flag flow
        // (another process writes runImmediately:true directly to the DB) is
        // exercised by the precedence test below via a sibling task that wakes
        // the loop.
        it('runImmediately tasks take precedence over runSince-scheduled ones', async () => {
            const immediate = makeTask();
            const scheduledEarly = makeTask();
            const scheduledLate = makeTask();

            const allRan = Promise.all([immediate.waitForNextRun(3000), scheduledEarly.waitForNextRun(3000), scheduledLate.waitForNextRun(3000)]);

            await cronTask(scheduledEarly.taskId, runOnceIn(100), scheduledEarly.handler);
            await cronTask(immediate.taskId, distantFuture, immediate.handler);
            await cronTask(scheduledLate.taskId, runOnceIn(300), scheduledLate.handler);

            await collection.updateOne({ _id: immediate.taskId }, { $set: { runImmediately: true } });

            await allRan;

            assert(immediate.callTimes[0].startedAt < scheduledEarly.callTimes[0].startedAt, 'immediate ran before early');
            assert(scheduledEarly.callTimes[0].startedAt < scheduledLate.callTimes[0].startedAt, 'early ran before late');
        });
    });

    describe('task processing', () => {
        it('starts a task close to its scheduled time', async () => {
            const { taskId, handler, callTimes, waitForNextRun } = makeTask();
            const target = new Date(Date.now() + 400);

            await cronTask(taskId, runOnceIn(400), handler);
            await waitForNextRun();

            const drift = callTimes[0].startedAt.getTime() - target.getTime();
            assert(drift >= -50, `task started too early (drift ${drift}ms)`);
            assert(drift <= 1000, `task started too late (drift ${drift}ms)`);
        });

        it('persists a runLog with up to 5 entries in most-recent-first order', async () => {
            const dates = [0, 100, 200, 300, 400, 500, 600].map((offset) => new Date(Date.now() + offset));
            const { taskId, handler, callTimes } = makeTask(() => wait(20));

            await cronTask(taskId, scheduleAt(...dates), handler);
            await waitUntil(() => callTimes.length >= dates.length, { timeoutMs: 5000, message: 'all runs executed' });
            await wait(100); // allow last run's DB write to land

            const doc = await getDocument(taskId);
            assert.strictEqual(doc.runLog.length, 5, 'runLog keeps only last 5 entries');
            const startedAts = doc.runLog.map((e) => e.startedAt.getTime());
            for (let i = 1; i < startedAts.length; i++) {
                assert(startedAts[i - 1] >= startedAts[i], 'runLog sorted most-recent-first');
            }
            doc.runLog.forEach((entry) => {
                assert(entry.finishedAt, 'every entry has finishedAt');
                assert(entry.startedAt.getTime() <= entry.finishedAt!.getTime());
            });
        });

        it('prefers tasks with earlier runSince', async () => {
            const early = makeTask();
            const mid = makeTask();
            const late = makeTask();
            const allRan = Promise.all([early.waitForNextRun(3000), mid.waitForNextRun(3000), late.waitForNextRun(3000)]);

            await cronTask(mid.taskId, runOnceIn(300), mid.handler);
            await cronTask(early.taskId, runOnceIn(100), early.handler);
            await cronTask(late.taskId, runOnceIn(500), late.handler);

            await allRan;
            assert(early.callTimes[0].startedAt < mid.callTimes[0].startedAt, 'early before mid');
            assert(mid.callTimes[0].startedAt < late.callTimes[0].startedAt, 'mid before late');
        });

        it('locks a processed task for a reasonable duration (~5 minutes)', async () => {
            const lockTaskTime = 5 * 60 * 1000;
            let docDuringRun: TaskDocument;
            const { taskId, handler, callTimes, waitForNextRun } = makeTask(async () => {
                docDuringRun = await getDocument(taskId);
            });

            await cronTask(taskId, runOnceIn(), handler);
            await waitForNextRun();

            const expectedLock = callTimes[0].startedAt.getTime() + lockTaskTime;
            assert(docDuringRun!.lockedTill!.getTime() >= expectedLock - 1000);
            assert(docDuringRun!.lockedTill!.getTime() <= expectedLock + 1000);
        });

        it('records a thrown error in runLog and invokes onError', async () => {
            const errMsg = 'boom';
            const { taskId, handler, waitForNextRun } = makeTask(() => {
                throw new Error(errMsg);
            });

            await cronTask(taskId, runOnceIn(), handler);
            await waitForNextRun();
            await waitUntil(() => onError.callCount >= 1, { timeoutMs: 2000, message: 'onError fired' });

            const doc = await getDocument(taskId);
            assert.strictEqual(doc.runLog.length, 1);
            assert(new RegExp(errMsg).test(doc.runLog[0].error!));
            assert.strictEqual(onError.callCount, 1);
            assert.strictEqual((onError.firstCall.args[0] as Error).message, errMsg);
        });

        it('ignores task documents that exist in the DB but are not registered in this instance', async () => {
            const registered = makeTask();
            await cronTask(registered.taskId, runOnceIn(SHORT), registered.handler);
            await registered.waitForNextRun();

            // insert a sibling "legacy" doc that no handler in this process owns
            const orphanId = 'orphan-task-id';
            const regDoc = await getDocument(registered.taskId);
            const orphanDoc = { ...regDoc, _id: orphanId, runSince: new Date(Date.now() - 1000) };
            await collection.insertOne(orphanDoc);

            await wait(400); // let the loop turn a few times
            const orphanAfter = await collection.findOne({ _id: orphanId });
            assert.deepStrictEqual(orphanAfter, orphanDoc, 'orphan document must not be touched');
        });
    });

    describe('stopCronTasks / startCronTasks lifecycle', () => {
        it('stops executing tasks after stopCronTasks()', async () => {
            const { taskId, handler, callTimes, waitForNextRun } = makeTask();
            await cronTask(taskId, () => new Date(Date.now() + 50), handler);
            await waitForNextRun();
            const runsBeforeStop = callTimes.length;

            stopCronTasks();
            await wait(300); // would normally allow several more runs

            assert.strictEqual(callTimes.length, runsBeforeStop, 'no new runs after stopCronTasks');
            assert(handler.callCount >= 1, 'at least one run before stop');
        });

        it('returns void from stopCronTasks (public API invariant)', () => {
            // NOTE: callers pass stopCronTasks where () => void is expected (e.g. onShutdown hooks).
            // The public return type must stay `void`, not Promise<void>.
            const result: void = stopCronTasks();
            assert.strictEqual(result, undefined);
        });

        it('does not run tasks registered while stopped', async () => {
            stopCronTasks();
            const { taskId, handler } = makeTask();

            await cronTask(taskId, runOnceIn(), handler);
            await wait(200);

            assert.strictEqual(handler.callCount, 0);
            const doc = await getDocument(taskId);
            assert(doc.runSince <= new Date(Date.now() + 1), 'task is scheduled, just not processed');
        });

        it('can be restarted with startCronTasks() after a stop', async () => {
            stopCronTasks();
            const { taskId, handler, waitForNextRun } = makeTask();
            await cronTask(taskId, runOnceIn(), handler);
            await wait(100);
            assert.strictEqual(handler.callCount, 0);

            startCronTasks();
            await waitForNextRun();
            assert.strictEqual(handler.callCount, 1);
        });
    });
});
