import * as assert from 'assert';
import * as _debug from 'debug';
// @ts-ignore
import { paths } from 'deepdash/standalone';
import { isEmpty, isEqual, matches, noop, pick, times, uniqueId } from 'lodash';
import { Collection, UpdateFilter } from 'mongodb';
import * as sinon from 'sinon';
import { createSandbox, SinonSpy, SinonStub, spy } from 'sinon';
import { getNewInstance, wait } from './testHelpers';

const debug = _debug('mongodash:cronTests:regression');

/**
 * Implementation-aware regression tests for the cron scheduler.
 *
 * Unlike the behavior-level suites (cronTasks.behavior.ts,
 * cronTasks.scheduling.ts, cronTasks.parallel.ts) these tests are
 * **intentionally** coupled to internal call patterns - they pin invariants
 * that are not observable through the public API alone:
 *
 *   - No DB traffic when idle (cost invariant).
 *   - Exact index names, query plans, and projections (cost/perf invariant).
 *   - getCollection is shared (resource invariant).
 *   - Subtle ordering when runSince ties (stable-sort invariant).
 *   - Lock prolonging during long-running handlers, including the race
 *     where the handler finishes mid-prolong (race regression).
 *   - Revert of runSince/runImmediately when a task is cancelled right
 *     after its lock is acquired (race regression).
 *   - Fault tolerance on every DB operation involved in the scheduler
 *     (findOneAndUpdate, updateOne finish/prolong, findOne next-wait).
 *
 * These tests use sandbox.useFakeTimers + sinon stubs on the collection.
 * Touching them during a scheduler refactor is expected; make sure the
 * underlying invariant still holds (in most cases the invariant is stated
 * in the top-level JSDoc on each `it`).
 */

interface TaskDocument {
    _id: string;
    runSince: Date;
    runImmediately: boolean;
    lockedTill: null | Date;
    runLog: {
        startedAt: Date;
        finishedAt: Date | null;
        error: string | null;
    }[];
}

describe('cronTasks - regressions / internal invariants', () => {
    const {
        mongodash: { cronTask, getCollection, runCronTask, startCronTasks, stopCronTasks },
        setOnError,
        collectionCalls,
        initInstance,
        cleanUpInstance,
    } = getNewInstance();

    beforeAll(() => initInstance());
    afterAll(() => cleanUpInstance());

    const noTaskWaitTime = 15 * 1000;
    const lockTaskTime = 5 * 60 * 1000;

    let collection: Collection<TaskDocument>;
    beforeAll(() => {
        collection = getCollection('cronTasks');
    });

    beforeEach(async () => {
        await collection.deleteMany({});
        startCronTasks();
    });

    afterAll(async () => {
        stopCronTasks();
    });

    const sandbox = createSandbox();
    beforeEach(() =>
        sandbox.useFakeTimers({
            now: new Date(),
            shouldAdvanceTime: true,
            shouldClearNativeTimers: true,
        }),
    );
    afterEach(() => sandbox.verifyAndRestore());

    let onError: SinonSpy;
    beforeEach(() => {
        onError = sandbox.spy();
        setOnError(onError);
    });

    let findNextTaskStub: SinonStub;
    let finishTaskStub: SinonStub;
    let returnTaskStub: SinonStub;
    let prolongLockStub: SinonStub;
    let registerTaskStub: SinonStub;
    let findNextRunSinceStub: SinonStub;
    let createIndexStub: SinonStub;

    beforeEach(() => {
        findNextTaskStub = sandbox.stub(collection, 'findOneAndUpdate').callThrough();

        const updateOneStub = sandbox.stub(collection, 'updateOne').callThrough();

        // @ts-ignore
        finishTaskStub = updateOneStub.withArgs(
            sinon.match.any,
            sinon.match((update: UpdateFilter<TaskDocument>) =>
                isEqual(paths(update), ['$set.runSince', '$set.lockedTill', '$set["runLog.0.error"]', '$set["runLog.0.finishedAt"]']),
            ),
        );

        // @ts-ignore
        returnTaskStub = updateOneStub.withArgs(sinon.match.any, sinon.match(matches({ $pop: { runLog: -1 } })));

        // @ts-ignore
        prolongLockStub = updateOneStub.withArgs(
            sinon.match.any,
            sinon.match((update: UpdateFilter<TaskDocument>) => isEqual(paths(update), ['$set.lockedTill'])),
        );
        prolongLockStub.wrappedMethod = updateOneStub.wrappedMethod;

        // @ts-ignore
        registerTaskStub = updateOneStub.withArgs(
            sinon.match.any,
            sinon.match((update: UpdateFilter<TaskDocument>) => !!update.$setOnInsert),
        );

        findNextRunSinceStub = sandbox.stub(collection, 'findOne').callThrough();

        createIndexStub = sandbox.stub(collection, 'createIndex').callThrough();
    });

    function distantFutureInterval() {
        const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
        date.setMinutes(0, 0, 0);
        return date;
    }

    function getRunOnceInterval(at?: Date | null) {
        let callCount = 0;
        return () => (callCount++ === 0 ? at || new Date() : distantFutureInterval());
    }

    function scheduledInterval(...dates: Date[]) {
        let callCount = 0;
        return () => (dates.length > callCount ? dates[callCount++] : distantFutureInterval());
    }

    function getTestingTask(taskCallback = noop) {
        const taskId = uniqueId('task-');
        let resolve: ((value: unknown) => void) | null;
        const callTimes: { startedAt: Date; finishedAt: Date }[] = [];

        const task = spy(async () => {
            debug(`task ${taskId} called`);
            const startedAt = new Date();
            try {
                await taskCallback();
            } finally {
                callTimes.push({ startedAt, finishedAt: new Date() });
                if (resolve) {
                    resolve(null);
                    resolve = null;
                }
            }
        });

        const waitForNextRun = () => new Promise((_resolve) => void (resolve = _resolve));
        const findDocument = () => collection.findOne({ _id: taskId });
        const getDocument = async (): Promise<TaskDocument> => {
            const document = await findDocument();
            if (!document) throw new Error('Document is not persisted yet');
            return document;
        };
        const setRunImmediately = async () => collection.updateOne({ _id: taskId }, { $set: { runImmediately: true } });

        return { taskId, task, waitForNextRun, findDocument, getDocument, setRunImmediately, callTimes };
    }

    function onNextCall(stub: SinonStub) {
        return stub.onCall(stub.callCount);
    }

    async function triggerNextRound() {
        debug('WAITING');
        await sandbox.clock.nextAsync();
        await wait(100);
    }

    /**
     * Cost invariant: a scheduler with no registered tasks must not
     * perform any DB operation. This is the reason the initial poll
     * is deferred until at least one task is registered.
     */
    it('idle scheduler performs zero DB operations', async () => {
        startCronTasks();

        const start = new Date();
        while (Date.now() < start.getTime() + noTaskWaitTime * 2) {
            sandbox.clock.tick(1000);
            await wait(50);
        }

        assert(registerTaskStub.notCalled, 'No registerTask query while idle');
        assert(createIndexStub.notCalled, 'No createIndex while idle');
        assert(findNextRunSinceStub.notCalled, 'No findOne while idle');
        assert(prolongLockStub.notCalled, 'No prolongLock while idle');
        assert(finishTaskStub.notCalled, 'No finishTask while idle');
        assert(returnTaskStub.notCalled, 'No returnTask while idle');
    });

    /**
     * Structural invariant: creates exactly two indexes with stable names
     * (runSinceIndex, runImmediatelyIndex) used by the find-next query
     * plan tested below.
     */
    it('creates exactly two indexes with the expected names and keys', async () => {
        const expectedIndexes = [
            { name: 'runSinceIndex', key: { runSince: 1, _id: 1, lockedTill: 1 } },
            { name: 'runImmediatelyIndex', key: { runImmediately: 1, _id: 1, lockedTill: 1 } },
        ];

        const getIndexes = () => collection.listIndexes().toArray();
        await assert.rejects(getIndexes, { codeName: 'NamespaceNotFound' });

        const { taskId, task } = getTestingTask();
        const task2 = getTestingTask();
        const task3 = getTestingTask();

        await Promise.all([
            cronTask(taskId, distantFutureInterval, task),
            cronTask(task2.taskId, distantFutureInterval, task2.task),
            cronTask(task3.taskId, distantFutureInterval, task3.task),
        ]);

        const indexes = await getIndexes();
        expectedIndexes.forEach((index) => {
            assert(
                indexes.some(({ key, name }) => isEqual(index.key, key) && name === index.name),
                `Index ${index.name} must exist with key ${JSON.stringify(index.key)}`,
            );
        });
        assert(createIndexStub.calledTwice, 'createIndex must be called exactly twice');
    });

    /**
     * Resource invariant: the scheduler shares one collection handle across
     * its internal loop, not one per poll. Guards against accidental
     * regression where getCollection would be called on every iteration.
     */
    it('getCollection is called only once by the scheduler', async () => {
        for (const task of times(3, () => getTestingTask())) {
            debug('cycle');
            const taskCallPromise = task.waitForNextRun();
            await cronTask(task.taskId, getRunOnceInterval(), task.task);
            await taskCallPromise;
        }

        // The "- 1" accounts for the test's own getCollection call.
        assert.strictEqual(collectionCalls.cronTasks - 1, 1, 'getCollection must be called only once by the scheduler');
    });

    /**
     * Query-plan invariant: findNextTask must select via the runSinceIndex
     * AND runImmediatelyIndex (OR over the two conditions). This pins the
     * production query shape against the created indexes.
     */
    it('findNextTask uses both runSinceIndex and runImmediatelyIndex', async () => {
        const testingTasks = times(100, () => getTestingTask());
        const runPromises = testingTasks.map((task) => task.waitForNextRun());

        for (const task of testingTasks) {
            await cronTask(task.taskId, getRunOnceInterval(new Date(Date.now() + 1000)), task.task);
        }

        let explain: any;
        onNextCall(findNextTaskStub).callsFake(async (...args) => {
            explain = await collection.find(args[0], args[2]).explain();
            return findNextTaskStub.wrappedMethod.apply(collection, args);
        });
        await Promise.all(runPromises);

        debug(JSON.stringify(explain, null, 4));
        const winningPlan = JSON.stringify(explain?.queryPlanner?.winningPlan);
        assert(winningPlan.includes('"indexName":"runSinceIndex"'), 'plan must include runSinceIndex');
        assert(winningPlan.includes('"indexName":"runImmediatelyIndex"'), 'plan must include runImmediatelyIndex');
    }, 30000);

    /**
     * Ordering invariant: when two tasks have equal runSince, the one that
     * has been waiting longer (earlier startedAt in runLog) runs first on
     * the next cycle. Pins the stable-sort behaviour of the find-next query.
     */
    it('on runSince tie, the task waiting longest runs first', async () => {
        const sameRunSince = new Date(Date.now() + 60 * 1000);

        const task1 = getTestingTask();
        const interval1 = scheduledInterval(new Date(Date.now() + 12 * 1000), sameRunSince);
        const callPromise1 = task1.waitForNextRun();

        const task2 = getTestingTask();
        const interval2 = scheduledInterval(new Date(Date.now() + 10 * 1000), sameRunSince); // runs first
        const callPromise2 = task2.waitForNextRun();

        const task3 = getTestingTask();
        const interval3 = scheduledInterval(new Date(Date.now() + 14 * 1000), sameRunSince);
        const callPromise3 = task3.waitForNextRun();

        await Promise.all([
            cronTask(task1.taskId, interval1, task1.task),
            cronTask(task2.taskId, interval2, task2.task),
            cronTask(task3.taskId, interval3, task3.task),
        ]);

        sandbox.clock.tick(15 * 1000);
        await Promise.all([callPromise1, callPromise2, callPromise3]);

        sandbox.clock.tick(sameRunSince.getTime() - Date.now());
        await Promise.all([task1.waitForNextRun(), task2.waitForNextRun(), task3.waitForNextRun()]);

        assert(task1.callTimes[1].startedAt > task2.callTimes[1].finishedAt);
        assert(task3.callTimes[1].startedAt > task1.callTimes[1].finishedAt);
    });

    /**
     * Lock-renewal invariant: while a handler runs longer than the lock
     * duration, the scheduler must prolong the lock in the background
     * enough times that `lockedTill` stays safely ahead of `now`.
     */
    it('prolongs the lock while a handler runs longer than lockTaskTime', async () => {
        const lockTimes: { at: Date; lockedTill: Date }[] = [];

        const { taskId, task, getDocument, callTimes } = getTestingTask(async () => {
            const taskStart = new Date();
            while (Date.now() - taskStart.getTime() < 2 * lockTaskTime) {
                const { lockedTill } = await getDocument();
                lockTimes.push({ at: new Date(), lockedTill: lockedTill! });
                await wait(15 * 1000);
            }
        });
        const task2 = getTestingTask();
        const task3 = getTestingTask();

        await cronTask(task2.taskId, getRunOnceInterval(), task2.task);
        await cronTask(taskId, getRunOnceInterval(), task);
        await cronTask(task3.taskId, getRunOnceInterval(), task3.task);
        prolongLockStub.resetHistory();

        while (callTimes.length === 0) {
            await sandbox.clock.tickAsync(100);
        }

        assert(prolongLockStub.callCount > 0, 'prolongLock must fire during a long-running handler');
        assert(lockTimes.length >= 20, `enough lock observations (${lockTimes.length})`);
        assert(lockTimes.every(({ at, lockedTill }) => lockedTill.getTime() - at.getTime() > 0.2 * lockTaskTime));

        prolongLockStub.resetHistory();
        for (let i = 10 * 150; i >= 0; i--) {
            await sandbox.clock.tickAsync(100);
        }
        assert(prolongLockStub.notCalled, 'no prolonging after the handler ended');
    }, 30000);

    /**
     * Race regression: when the handler finishes while a prolongLock query
     * is in flight, no additional prolong must fire. Previously this could
     * leak a second prolong call.
     */
    it('stops prolonging when the handler finishes mid-prolong', async () => {
        const { taskId, task } = getTestingTask(async () => {
            await new Promise<void>((resolve) => {
                onNextCall(prolongLockStub).callsFake(async (...args) => {
                    const queryResult = await prolongLockStub.wrappedMethod.apply(collection, args);
                    resolve();
                    await wait(100); // let the task finish and stop the prolong loop
                    return queryResult;
                });
            });
        });

        await cronTask(taskId, getRunOnceInterval(), task);

        while (!finishTaskStub.called) {
            await triggerNextRound();
        }

        prolongLockStub.resetHistory();
        for (let i = 10; i >= 0; i--) {
            sandbox.clock.next();
            await wait(50);
        }
        assert(prolongLockStub.notCalled, 'no prolong after handler finish');
    });

    /**
     * Cost invariant: findNextTask must use a projection; the scheduler
     * never loads full documents when it only needs scheduling fields.
     */
    it('findNextTask query uses a projection', async () => {
        const { taskId, task } = getTestingTask();

        findNextTaskStub.resetHistory();
        await cronTask(taskId, distantFutureInterval, task);

        while (findNextTaskStub.notCalled) {
            sandbox.clock.next();
            await wait(50);
        }

        const optionArguments = findNextTaskStub.firstCall.args[2];
        assert(!isEmpty(optionArguments.projection));
    });

    /**
     * Cost invariant: findNextRunSince (the wait-time query) must use a
     * projection of `{ runSince: 1 }` and sort by `{ runSince: 1 }` so the
     * data can be served from the index without fetching documents.
     */
    it('findNextRunSince uses { runSince: 1 } projection + sort', async () => {
        const { taskId, task } = getTestingTask();

        findNextRunSinceStub.resetHistory();
        await cronTask(taskId, getRunOnceInterval(), task);

        while (findNextRunSinceStub.notCalled) {
            sandbox.clock.next();
            await wait(50);
        }

        const optionArguments = findNextRunSinceStub.firstCall.args[1];
        assert.deepStrictEqual(optionArguments.projection, { runSince: 1 });
        assert.deepStrictEqual(optionArguments.sort, { runSince: 1 });
    });

    /**
     * Race regression: if `stopCronTasks` is called in the window between
     * the task being locked (runSince + lockedTill updated) and the handler
     * actually running, the document must be reverted to its pre-lock
     * state - including runImmediately=true when applicable.
     */
    it('reverts runSince + runImmediately when a locked task is cancelled before running', async () => {
        const task1 = getTestingTask();
        const task2 = getTestingTask(); // extra tasks so matchers on the revert are not trivial
        const task3 = getTestingTask();

        const firstRunPromise = task1.waitForNextRun();

        await cronTask(task2.taskId, distantFutureInterval, task2.task);
        await cronTask(task1.taskId, scheduledInterval(new Date(Date.now()), new Date(Date.now() + 5000)), task1.task);
        await cronTask(task3.taskId, distantFutureInterval, task3.task);

        assert.strictEqual((await task1.getDocument()).runImmediately, false);

        await firstRunPromise;
        await wait(100);
        const originalDocument = await task1.getDocument();

        const documentDuringProcessingPromise = new Promise<TaskDocument>((resolve) => {
            onNextCall(findNextTaskStub).callsFake(async function (...args) {
                const document = await findNextTaskStub.wrappedMethod.call(collection, ...args);
                resolve(await task1.getDocument());
                stopCronTasks(); // cancel right before the returned task is processed
                return document;
            });
        });

        await task1.setRunImmediately();

        await triggerNextRound();
        const documentBeforeProcessing = await documentDuringProcessingPromise;
        assert.strictEqual(documentBeforeProcessing.runLog.length, 2);
        assert(documentBeforeProcessing.runLog[0].startedAt);
        assert(!documentBeforeProcessing.runLog[0].finishedAt);

        await wait(100);
        const documentAfterCancellation = await task1.getDocument();
        assert.deepStrictEqual(documentAfterCancellation, { ...originalDocument, runImmediately: true });
        assert.strictEqual(task1.callTimes.length, 1, 'task must not run a second time');
    });

    describe('database fault tolerance', () => {
        /** DB fault regression: findOneAndUpdate rejection must surface via onError and not break the loop. */
        it('onError fires and loop continues when findOneAndUpdate rejects', async () => {
            const { taskId, task } = getTestingTask();

            findNextTaskStub.resetHistory();
            const someMongoError = new Error('Some MongoError');
            onNextCall(findNextTaskStub).rejects(someMongoError);

            await cronTask(taskId, getRunOnceInterval(new Date(Date.now() + 1000)), task);

            while (task.callCount === 0) {
                await triggerNextRound();
            }

            assert(findNextTaskStub.callCount >= 2, 'loop must not break');
            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
        });

        /** runCronTask must reject to the caller (not swallow via onError) when the DB query rejects. */
        it('runCronTask rejects directly when findOneAndUpdate rejects', async () => {
            const { taskId, task } = getTestingTask();

            await cronTask(taskId, distantFutureInterval, task);

            findNextTaskStub.resetHistory();
            const someMongoError = new Error('Some MongoError');
            onNextCall(findNextTaskStub).rejects(someMongoError);

            await assert.rejects(() => runCronTask(taskId), pick(someMongoError, 'name', 'message'));
            assert(onError.notCalled);

            await triggerNextRound();
            await triggerNextRound();
            assert(findNextTaskStub.callCount >= 2, 'loop must not break');
        });

        /** DB fault regression: failure of the finish-task updateOne must surface via onError, loop continues. */
        it('onError fires and loop continues when finish-task updateOne rejects', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask();

            await cronTask(task1.taskId, getRunOnceInterval(new Date(Date.now() + 2000)), task1.task);
            await cronTask(task2.taskId, getRunOnceInterval(new Date(Date.now() + 5000)), task2.task);

            finishTaskStub.resetHistory();
            const someMongoError = new Error('Some MongoError AAA');
            onNextCall(finishTaskStub).rejects(someMongoError);

            while (task1.task.callCount === 0 || task2.task.callCount === 0) {
                await triggerNextRound();
            }

            assert(finishTaskStub.callCount >= 2);
            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
            assert(onError.calledBefore(task2.task), 'onError must fire before the second task runs');
        });

        /** DB fault regression: failure of the find-next-wait-time query must not break the loop. */
        it('onError fires and loop continues when findNextRunSince rejects', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask();

            await cronTask(task1.taskId, getRunOnceInterval(new Date(Date.now() + 2000)), task1.task);
            await cronTask(task2.taskId, getRunOnceInterval(new Date(Date.now() + 5000)), task2.task);

            findNextRunSinceStub.resetHistory();
            const someMongoError = new Error('Some MongoError BBB');
            onNextCall(findNextRunSinceStub).rejects(someMongoError);

            while (task1.task.callCount === 0 || task2.task.callCount === 0) {
                await triggerNextRound();
            }

            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
            assert(onError.calledBefore(task2.task), 'onError must fire before the second task runs');
        });

        /** Race regression: failure of a single prolongLock query must not tear down the long-running handler's lock loop. */
        it('prolongLock failure is reported via onError but loop continues', async () => {
            const someMongoError = new Error('Some MongoError BBB');

            const { taskId, task, callTimes } = getTestingTask(async () => {
                const taskStart = new Date();

                prolongLockStub.resetHistory();
                onError.resetHistory();
                onNextCall(prolongLockStub).rejects(someMongoError);

                // Keep the handler alive long enough for multiple prolong
                // rounds, so the loop has a chance to fail once and recover.
                while (Date.now() - taskStart.getTime() < 2 * lockTaskTime) {
                    await wait(15 * 1000);
                }
            });

            await cronTask(taskId, getRunOnceInterval(), task);

            while (callTimes.length === 0) {
                await sandbox.clock.tickAsync(100);
            }

            assert(prolongLockStub.callCount > 2, 'prolong fired multiple times despite one rejection');
            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
            assert(onError.calledAfter(task), 'onError must fire after the handler entered');
        });
    });
});
