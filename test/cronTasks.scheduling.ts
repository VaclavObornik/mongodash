import * as assert from 'assert';
import { Collection } from 'mongodb';
import * as sinon from 'sinon';
import { getNewInstance, waitUntil } from './testHelpers';

// A couple of runtime tests use waitUntil with budgets near Jest's default
// 5s timeout. Raise the suite timeout so a real failure surfaces the
// waitUntil message instead of a generic Jest timeout.
jest.setTimeout(15_000);

interface TaskDocument {
    _id: string;
    runSince: Date;
    runImmediately: boolean;
    lockedTill: null | Date;
    runLog: { startedAt: Date; finishedAt: Date | null; error: string | null }[];
}

describe('cronTasks - scheduling semantics', () => {
    const { mongodash, setOnError, initInstance, cleanUpInstance } = getNewInstance();
    const { cronTask, getCollection, startCronTasks, stopCronTasks } = mongodash;

    let collection: Collection<TaskDocument>;
    let onError: sinon.SinonSpy;
    let taskSeq = 0;
    const nextTaskId = () => `sched-task-${++taskSeq}`;

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

    describe('interval parameter forms', () => {
        it('accepts a function returning a Date - schedules runSince to that date', async () => {
            const taskId = nextTaskId();
            const at = new Date('2050-01-01T00:00:00Z');

            await cronTask(taskId, () => at, sinon.spy());

            assert.deepStrictEqual((await getDocument(taskId)).runSince, at);
        });

        it('accepts an async function returning a Date', async () => {
            const taskId = nextTaskId();
            const at = new Date('2050-01-01T00:00:00Z');

            await cronTask(taskId, async () => at, sinon.spy());

            assert.deepStrictEqual((await getDocument(taskId)).runSince, at);
        });

        it('accepts a function returning a number (milliseconds)', async () => {
            const taskId = nextTaskId();
            const intervalMs = 7000;
            const before = Date.now();

            await cronTask(taskId, () => intervalMs, sinon.spy());

            const after = Date.now();
            const { runSince } = await getDocument(taskId);
            assert(runSince.getTime() >= before + intervalMs, 'runSince is too early');
            assert(runSince.getTime() <= after + intervalMs, 'runSince is too late');
        });

        it('accepts a number directly (milliseconds)', async () => {
            const taskId = nextTaskId();
            const intervalMs = 1000 * 60 * (60 + 30);
            const before = Date.now();

            await cronTask(taskId, intervalMs, sinon.spy());

            const after = Date.now();
            const { runSince } = await getDocument(taskId);
            assert(runSince.getTime() >= before + intervalMs, 'runSince is too early');
            assert(runSince.getTime() <= after + intervalMs, 'runSince is too late');
        });

        it('accepts a duration string', async () => {
            const taskId = nextTaskId();
            const durationMs = 1000 * 60 * (60 + 5);
            const before = Date.now();

            await cronTask(taskId, '1h 5m', sinon.spy());

            const after = Date.now();
            const { runSince } = await getDocument(taskId);
            assert(runSince.getTime() >= before + durationMs, 'runSince is too early');
            assert(runSince.getTime() <= after + durationMs, 'runSince is too late');
        });

        it('accepts a function returning a duration string', async () => {
            const taskId = nextTaskId();
            const durationMs = 7000;
            const before = Date.now();

            await cronTask(taskId, async () => '7s', sinon.spy());

            const after = Date.now();
            const { runSince } = await getDocument(taskId);
            assert(runSince.getTime() >= before + durationMs, 'runSince is too early');
            assert(runSince.getTime() <= after + durationMs, 'runSince is too late');
        });
    });

    describe('cron expressions', () => {
        it.each(['cron', 'CRON'])('accepts a linux CRON expression prefixed by "%s"', async (prefix) => {
            const taskId = nextTaskId();
            const now = new Date();
            const expectedNextJan1 = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);

            await cronTask(taskId, `${prefix} 0 0 1 1 *`, sinon.spy());

            assert.deepStrictEqual((await getDocument(taskId)).runSince, expectedNextJan1);
        });

        it('rejects invalid CRON expressions at registration time', async () => {
            const taskId = nextTaskId();

            await assert.rejects(() => cronTask(taskId, 'CRON x c 1 1 *', sinon.spy()), /Error: Invalid interval\. Invalid characters, got value: x\./);
        });

        it('rejects init() with cronExpressionParserOptions.endDate (not supported)', async () => {
            const instance = getNewInstance();
            try {
                // skipClean=true: outer suite shares the testing DB, we must
                // not drop it as a side effect of this rejection test.
                await assert.rejects(
                    () => instance.initInstance({ cronExpressionParserOptions: { endDate: new Date('2000-01-01') } }, true),
                    /The 'endDate' parameter of the cron-parser package is not supported yet\./,
                );
            } finally {
                // initInstance() opens the Mongo client before the cron init throws,
                // so we must clean up even on rejection to avoid a leaked connection.
                await instance.cleanUpInstance();
            }
        });
    });

    describe('invalid interval returns', () => {
        it('rejects an interval function returning NaN', async () => {
            const taskId = nextTaskId();

            await assert.rejects(() => cronTask(taskId, <never>(() => Number.NaN), sinon.spy()), /Interval number has to be finite\./);
        });

        it.each([{}, undefined, null, ''])('rejects an interval function returning "%s"', async (value) => {
            const taskId = nextTaskId();

            await assert.rejects(() => cronTask(taskId, <never>(() => value), sinon.spy()), /Invalid interval\./);
        });

        it('rejects an invalid duration string at registration', async () => {
            const taskId = nextTaskId();

            await assert.rejects(() => cronTask(taskId, '1hx', sinon.spy()), /Error: Invalid interval\./);
        });

        it('rejects NaN passed directly as the interval value', async () => {
            const taskId = nextTaskId();

            await assert.rejects(() => cronTask(taskId, Number.NaN, sinon.spy()), /Error: Interval number has to be finite\./);
        });

        it('rejects an interval function returning an Invalid Date at registration', async () => {
            const taskId = nextTaskId();

            await assert.rejects(() => cronTask(taskId, () => new Date(NaN), sinon.spy()), /Invalid Date/);
        });
    });

    describe('runtime scheduling behaviour', () => {
        it('reports onError and backs off (releasing the lock) when the interval function throws while re-scheduling', async () => {
            const taskId = nextTaskId();
            const scheduleError = new Error('something bad happened');
            const at = new Date();
            const task = sinon.spy();

            const intervalFunction = sinon.spy(() => {
                if (task.callCount === 1) throw scheduleError; // throw on reschedule after first run
                return at;
            });

            await cronTask(taskId, intervalFunction, task);

            await waitUntil(() => task.callCount >= 1, { timeoutMs: 3000, message: 'task ran at least once' });
            await waitUntil(() => onError.callCount >= 1, { timeoutMs: 3000, message: 'onError fired' });
            assert.deepStrictEqual(onError.firstCall.args, [scheduleError]);

            // The reschedule write must still happen: without it the task keeps
            // its past runSince and re-runs the finished handler on every lock
            // expiry, forever.
            await waitUntil(async () => (await getDocument(taskId)).lockedTill === null, { timeoutMs: 3000 });
            const docAfter = await getDocument(taskId);
            assert(docAfter.runSince.getTime() > Date.now(), 'runSince must back off into the future');
            assert.strictEqual(task.callCount, 1, 'the successful run must not repeat');
        });

        it('reports onError and backs off when the interval function returns an Invalid Date while re-scheduling', async () => {
            const taskId = nextTaskId();
            const task = sinon.spy();

            // An Invalid Date would bypass the non-future clamp (NaN <= now is
            // false) and bson-serialize as epoch 0 - a perpetually-due hot loop.
            const intervalFunction = sinon.spy(() => (task.callCount === 1 ? new Date(NaN) : new Date()));

            await cronTask(taskId, intervalFunction, task);

            await waitUntil(() => task.callCount >= 1, { timeoutMs: 3000, message: 'task ran at least once' });
            await waitUntil(() => onError.callCount >= 1, { timeoutMs: 3000, message: 'onError fired' });
            assert.match(onError.firstCall.args[0].message, /Invalid Date/);

            await waitUntil(async () => (await getDocument(taskId)).lockedTill === null, { timeoutMs: 3000 });
            const docAfter = await getDocument(taskId);
            assert(docAfter.runSince.getTime() > Date.now(), 'runSince must back off, not become epoch 0');
            assert.strictEqual(task.callCount, 1, 'the task must not hot-loop');
        });

        it('runs a task whose interval immediately returns a past date without error', async () => {
            const taskId = nextTaskId();
            const task = sinon.spy();
            const registrationTime = Date.now();

            // Return past date only for the 2nd call (the re-schedule after
            // the 1st run), then distant future so the scheduler doesn't loop
            // against the DB after the test's assertion point.
            let callIdx = 0;
            const intervalFn = () => {
                if (callIdx === 0) {
                    callIdx += 1;
                    return new Date();
                }
                if (callIdx === 1) {
                    callIdx += 1;
                    return new Date(1970, 0, 1);
                }
                return new Date(Date.now() + 24 * 60 * 60 * 1000);
            };

            await cronTask(taskId, intervalFn, task);
            await waitUntil(() => task.callCount >= 2, { timeoutMs: 5000, message: 'task runs twice despite past date' });

            assert(task.callCount >= 2);
            assert(onError.notCalled, 'onError must not fire for past-date reschedule');
            assert(Date.now() - registrationTime < 5000, 'runs should not be delayed');
        });
    });
});
