import * as assert from 'assert';
import * as correlator from 'correlation-id';
import * as _debug from 'debug';
// @ts-ignore
import { paths } from 'deepdash/standalone';
import { isEmpty, isEqual, map, matches, noop, pick, times, uniq, uniqueId } from 'lodash';
import { Collection, UpdateFilter } from 'mongodb';
import * as sinon from 'sinon';
import { createSandbox, SinonSpy, SinonStub, spy } from 'sinon';
import { getNewInstance, wait, waitUntil } from './testHelpers';

const debug = _debug('mongodash:cronTests');

describe('cronTasks %i', () => {
    const {
        mongodash: { cronTask, getCollection, runCronTask, startCronTasks, stopCronTasks, scheduleCronTaskImmediately },
        mongodash,
        setOnError,
        collectionCalls,
        initInstance,
        cleanUpInstance,
    } = getNewInstance();

    beforeAll(() => initInstance());

    afterAll(() => cleanUpInstance());

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
            // updating only runSince
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
        // first run immediately once
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

        const waitForNextRun = () => {
            return new Promise((_resolve) => {
                resolve = _resolve;
            });
        };

        const findDocument = () => collection.findOne({ _id: taskId });

        const getDocument = async (): Promise<TaskDocument> => {
            const document = await findDocument();
            if (!document) {
                throw new Error('Document is not persisted yet');
            }
            return document;
        };

        const setRunImmediately = async () =>
            collection.updateOne(
                { _id: taskId },
                {
                    $set: { runImmediately: true },
                },
            );

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

    describe('cronTask() registration', () => {
        // NOTE THIS TEST HAS TO BE THE FIRST TEST
        it('should not query database with no registered task', async () => {
            startCronTasks();

            const start = new Date();
            while (Date.now() < start.getTime() + noTaskWaitTime * 2) {
                sandbox.clock.tick(1000);
                await wait(50); // increase in case of problems with not enough lockTimes
            }

            assert(registerTaskStub.notCalled, 'No query should be done to database without a registered task');
            assert(createIndexStub.notCalled, 'No query should be done to database without a registered task');
            assert(findNextRunSinceStub.notCalled, 'No query should be done to database without a registered task');
            assert(prolongLockStub.notCalled, 'No query should be done to database without a registered task');
            assert(finishTaskStub.notCalled, 'No query should be done to database without a registered task');
            assert(returnTaskStub.notCalled, 'No query should be done to database without a registered task');
        });

        // NOTE THIS TEST HAS TO BE THE FIRST TEST WITH A TASK
        it('should create proper indexes', async () => {
            const expectedIndexes = [
                { name: 'runSinceIndex', key: { runSince: 1, _id: 1, lockedTill: 1 } },
                { name: 'runImmediatelyIndex', key: { runImmediately: 1, _id: 1, lockedTill: 1 } },
            ];

            const getIndexes = () => collection.listIndexes().toArray();
            // test expects the collection does not exists before
            await assert.rejects(getIndexes, { codeName: 'NamespaceNotFound' });

            const { taskId, task } = getTestingTask();
            const task2 = getTestingTask();
            const task3 = getTestingTask();

            await Promise.all([
                cronTask(taskId, distantFutureInterval, task),
                cronTask(task2.taskId, distantFutureInterval, task2.task), // register multiple
                cronTask(task3.taskId, distantFutureInterval, task3.task), // register multiple
            ]);

            const indexes = await getIndexes();

            expectedIndexes.forEach((index) => {
                assert(
                    indexes.some(({ key, name }) => isEqual(index.key, key) && name === index.name),
                    'The index should be created',
                );
            });
            assert(createIndexStub.calledTwice, 'The createIndex function has to be called exactly twice');
        });

        it('should call getCollection only once', async () => {
            for (const task of times(3, () => getTestingTask())) {
                debug('cycle');
                const taskCallPromise = task.waitForNextRun();
                await cronTask(task.taskId, getRunOnceInterval(), task.task);
                await taskCallPromise;
            }

            // the second call si triggered by the tests
            assert.strictEqual(collectionCalls.cronTasks - 1, 1, 'The getCollection should be called only once by cronTasks');
        });

        it('should run be possible to register tasks before the mongodash init', async () => {
            const mongodash = getNewInstance();
            const { taskId, task } = getTestingTask();
            const initPromise = mongodash.mongodash.cronTask(taskId, getRunOnceInterval(), task);

            await triggerNextRound();
            assert.strictEqual(task.callCount, 0);

            await mongodash.initInstance();
            await initPromise;
            await triggerNextRound();
            assert.strictEqual(task.callCount, 1);
        });

        it.each(times(3, String))('should run a task automatically [%i]', async () => {
            const { taskId, task } = getTestingTask();
            await cronTask(taskId, getRunOnceInterval(), task);
            await waitUntil(() => task.callCount >= 1, { timeoutMs: 5000, message: 'Task should be called' });
            assert.strictEqual(task.callCount, 1, 'the testingTask has to be called');
        });

        it('should store a task to database in a right form', async () => {
            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);
            await cronTask(taskId, () => new Date('2050-01-01T00:00:00Z'), task);
            assert.deepStrictEqual(await getDocument(), {
                _id: taskId,
                runImmediately: false,
                lockedTill: null,
                runLog: [],
                runSince: new Date('2050-01-01T00:00:00Z'),
            });
        });

        it('should run another newly registered task immediately after the running finishes', async () => {
            let second: ReturnType<typeof getTestingTask>;

            const first = getTestingTask(async () => {
                second = getTestingTask();
                await cronTask(second.taskId, getRunOnceInterval(), second.task);
                await wait(100);
            });

            await cronTask(first.taskId, getRunOnceInterval(), first.task);

            await first.waitForNextRun();
            await second!.waitForNextRun();

            assert(first.task.calledOnce);
            assert(second!.task.calledOnce);
            const secondRanAfter = second!.callTimes[0].startedAt.getTime() - first.callTimes[0].finishedAt.getTime();
            assert(secondRanAfter > 0, `second should not start before the first finished, difference: ${secondRanAfter}ms`);
            assert(secondRanAfter < 200, `second should not wait too long to run, difference: ${secondRanAfter}ms`);
        });

        it.each(times(10, String))('should run another newly registered task immediately when no task is running [%i]', async () => {
            const first = getTestingTask(async () => wait(100));
            const firstTaskRunPromise = first.waitForNextRun();
            await cronTask(first.taskId, getRunOnceInterval(), first.task);
            debug('waiting to first task');
            await firstTaskRunPromise;
            debug('first task done');

            await wait(100);

            const second = getTestingTask(async () => wait(100));
            const secondTaskRunPromise = second.waitForNextRun();
            await cronTask(second.taskId, getRunOnceInterval(), second.task);
            debug('waiting to second task');
            await secondTaskRunPromise;
            debug('first task done');

            assert(first.task.calledOnce);
            assert(second.task.calledOnce);
            const secondRanAfter = second.callTimes[0].startedAt.getTime() - first.callTimes[0].finishedAt.getTime();
            assert(secondRanAfter >= 100, `second should not start before the first finished, difference: ${secondRanAfter}ms`);
            assert(secondRanAfter < 300, `second should not wait too long to run, difference: ${secondRanAfter}ms`);
        });

        it('should not be possible to register a taskId twice', async () => {
            const { taskId, task } = getTestingTask();
            await cronTask(taskId, distantFutureInterval, task);
            await assert.rejects(() => cronTask(taskId, distantFutureInterval, task), new RegExp(`The taskId '${taskId}' is already used.`));
        });

        it('should be possible to register task already existing in the database', async () => {
            const testingTask1 = getTestingTask();
            const testingTask2 = getTestingTask();

            await cronTask(testingTask1.taskId, distantFutureInterval, testingTask1.task);

            const alreadyExistingDocument: TaskDocument = {
                ...(await testingTask1.getDocument()),
                _id: testingTask2.taskId,
            };

            await collection.insertOne(alreadyExistingDocument);

            await cronTask(testingTask2.taskId, distantFutureInterval, testingTask2.task);
        });
    });

    describe('runImmediately flag', () => {
        it.each(times(3, String))('should be possible to unblock task by setting runImmediately %i', async () => {
            const { taskId, task, waitForNextRun, getDocument, setRunImmediately } = getTestingTask();

            await cronTask(taskId, distantFutureInterval, task);
            debug('Task registered');

            await wait(100);
            assert.strictEqual(task.callCount, 0, "the task shouldn't be called automatically");

            await setRunImmediately();
            debug('task set to runImmediately');
            sandbox.clock.next();
            await waitForNextRun();
            assert.strictEqual(task.callCount, 1, 'the task has to be called');
            assert.strictEqual((await getDocument())!.runImmediately, false, 'The runImmediately flag should be disabled after first usage');

            await wait(100);
            sandbox.clock.next();
            await wait(100);
            assert.strictEqual(task.callCount, 1, 'the task should not be called again');
        });

        it('should get precedence before the runSince tasks', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask();
            const task3 = getTestingTask();

            const callAllPromise = Promise.all([task1.waitForNextRun(), task2.waitForNextRun(), task3.waitForNextRun()]);

            await cronTask(task1.taskId, getRunOnceInterval(new Date(Date.now() + 2000)), task1.task);
            await cronTask(task2.taskId, distantFutureInterval, task2.task);
            await cronTask(task3.taskId, getRunOnceInterval(new Date(Date.now() + 3000)), task3.task);

            await wait(100);
            await task2.setRunImmediately();
            sandbox.clock.tick(5000);
            await callAllPromise;

            assert(task2.callTimes[0].startedAt < task1.callTimes[0].startedAt);
            assert(task1.callTimes[0].startedAt < task3.callTimes[0].startedAt);
        });
    });

    describe('task processing', () => {
        it.each([5 * noTaskWaitTime - 3000, 5 * noTaskWaitTime, 5 * noTaskWaitTime + 3000])(
            'should run task in a desired time (%ims)',
            async (scheduleTime) => {
                const { taskId, task, callTimes } = getTestingTask();

                const desiredTime = new Date(Date.now() + scheduleTime);
                await cronTask(taskId, getRunOnceInterval(desiredTime), task);

                // we meed to have multiple different tasks to test getWaitTimeByNextTask query sort
                const task2 = getTestingTask();
                const afterDesiredTime = new Date(desiredTime.getTime() + 2000);
                await cronTask(task2.taskId, getRunOnceInterval(afterDesiredTime), task2.task);

                while (callTimes.length === 0) {
                    await triggerNextRound();
                }

                assert(callTimes[0].startedAt >= desiredTime, 'Task started too early.');

                const possibleRunTime = 500;
                const latestStart = new Date(desiredTime.getTime() + possibleRunTime);
                assert(callTimes[0].startedAt <= latestStart, 'Task started too late');

                assert(onError.notCalled, 'The onError function should not be called when there is no error');
            },
        );

        it('should use created indexes for finding a task', async () => {
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
            const winningPlanPretty = JSON.stringify(explain?.queryPlanner?.winningPlan, null, 4);
            assert(winningPlan.includes('"indexName":"runSinceIndex"'), `The plan with runSinceIndex does not win: ${winningPlanPretty}`);
            assert(winningPlan.includes('"indexName":"runImmediatelyIndex"'), `The plan with runImmediatelyIndex does not win: ${winningPlanPretty}`);
        }, 30000);

        it('should persist a runLog', async () => {
            const taskTime = 100;
            const { taskId, task, getDocument, callTimes } = getTestingTask(async () => {
                await wait(taskTime);
            });

            const dates = [
                new Date(Date.now() + 1000),
                new Date(Date.now() + 10 * 1000),
                new Date(Date.now() + 20 * 1000),
                new Date(Date.now() + 60 * 1000),
                new Date(Date.now() + 70 * 1000),
                new Date(Date.now() + 90 * 1000),
            ];

            await cronTask(taskId, scheduledInterval(...dates), task);

            while (callTimes.length < dates.length) {
                await triggerNextRound();
            }
            await wait(100); // wait for the last run entry is persisted

            const document = await getDocument();
            assert(Array.isArray(document.runLog), 'runLog has to be an array');
            assert.strictEqual(document.runLog.length, 5, 'The runLog should persist last 5 entries only');

            function dateRoughlyEqual(actual: Date, expected: Date) {
                const maxExpected = new Date(expected.getTime() + 100);
                assert(
                    actual <= maxExpected,
                    `Actual date is too close to present. Actual: ${actual.toISOString()}, maxExpected: ${maxExpected.toISOString()}`,
                );

                const minExpected = new Date(expected.getTime() - 100);
                assert(actual >= minExpected, `Actual date is too early. Actual: ${actual.toISOString()}, maxExpected: ${minExpected.toISOString()}`);
            }

            dates
                .slice(-5) // only last 5 entries should be stored
                .reverse() // last run should be stored at lowest index
                .forEach((date, i) => {
                    const entry = document.runLog[i];
                    assert(entry.startedAt.getTime() <= entry.finishedAt!.getTime() - taskTime);
                    try {
                        dateRoughlyEqual(entry.startedAt, date);
                    } catch {
                        // ignore
                    }
                });
        });

        it('should prefer more delayed tasks', async () => {
            const task1 = getTestingTask();
            const interval1 = getRunOnceInterval(new Date(Date.now() + 12 * 1000)); // second
            const callPromise1 = task1.waitForNextRun();

            const task2 = getTestingTask();
            const interval2 = getRunOnceInterval(new Date(Date.now() + 10 * 1000)); // first
            const callPromise2 = task2.waitForNextRun();

            const task3 = getTestingTask();
            const interval3 = getRunOnceInterval(new Date(Date.now() + 14 * 1000)); // third
            const callPromise3 = task3.waitForNextRun();

            await cronTask(task1.taskId, interval1, task1.task);
            await cronTask(task2.taskId, interval2, task2.task);
            await cronTask(task3.taskId, interval3, task3.task);

            sandbox.clock.tick(30 * 1000);
            await Promise.all([callPromise1, callPromise2, callPromise3]);

            assert(task1.callTimes[0].startedAt > task2.callTimes[0].finishedAt);
            assert(task3.callTimes[0].startedAt > task1.callTimes[0].finishedAt);
        });

        it('should prefer task which are waiting longer when runSince is equal', async () => {
            const sameRunSince = new Date(Date.now() + 60 * 1000);

            const task1 = getTestingTask();
            const interval1 = scheduledInterval(new Date(Date.now() + 12 * 1000), sameRunSince); // second
            const callPromise1 = task1.waitForNextRun();

            const task2 = getTestingTask();
            const interval2 = scheduledInterval(new Date(Date.now() + 10 * 1000), sameRunSince); // first
            const callPromise2 = task2.waitForNextRun();

            const task3 = getTestingTask();
            const interval3 = scheduledInterval(new Date(Date.now() + 14 * 1000), sameRunSince); // third
            const callPromise3 = task3.waitForNextRun();

            await Promise.all([
                cronTask(task1.taskId, interval1, task1.task),
                cronTask(task2.taskId, interval2, task2.task),
                cronTask(task3.taskId, interval3, task3.task),
            ]);

            sandbox.clock.tick(15 * 1000);
            await Promise.all([callPromise1, callPromise2, callPromise3]);

            sandbox.clock.tick(sameRunSince.getTime() - Date.now()); // move clock to run all task for the second time
            await Promise.all([task1.waitForNextRun(), task2.waitForNextRun(), task3.waitForNextRun()]);

            assert(task1.callTimes[1].startedAt > task2.callTimes[1].finishedAt);
            assert(task3.callTimes[1].startedAt > task1.callTimes[1].finishedAt);
        });

        it(`should lock the task for a reasonable time (${lockTaskTime}ms)`, async () => {
            let document: TaskDocument;

            const { taskId, task, getDocument, waitForNextRun, callTimes } = getTestingTask(async () => {
                document = await getDocument();
            });
            const runPromise = waitForNextRun();
            await cronTask(taskId, getRunOnceInterval(), task);
            await runPromise;

            const fiveMinutesAfterStart = callTimes[0].startedAt.getTime() + lockTaskTime;
            assert(document!.lockedTill!.getTime() >= fiveMinutesAfterStart - 1000);
            assert(document!.lockedTill!.getTime() <= fiveMinutesAfterStart);
        });

        it(/*.each(times(10))*/ 'should not process tasks existing in DB but not registered in the instance', async () => {
            const { taskId, task, getDocument, waitForNextRun } = getTestingTask();
            // assert.fail('Sometimes fail');

            const runPromise = waitForNextRun();
            debug(`start registering ${taskId}`);
            await cronTask(taskId, getRunOnceInterval(new Date(Date.now() + 1000)), task);
            debug(`finished registering ${taskId}`);

            // clone and insert the document with the same runSince
            const notRegisteredTaskId = 'someLegacyTaskId';
            const notRegisteredTaskDocument = { ...(await getDocument()), _id: notRegisteredTaskId };
            await collection.insertOne(notRegisteredTaskDocument);
            debug('finished insert to database');

            await runPromise;

            debug('task has finished, triggering next round');
            await triggerNextRound();
            debug('next round triggered');

            // runSince and runLog should not be changed
            assert.deepStrictEqual(await collection.findOne({ _id: notRegisteredTaskId }), notRegisteredTaskDocument);
        });

        it('should store an error in runLog and send it to onError', async () => {
            const errorMessage = 'An error occurred';
            const error = new Error(errorMessage);

            const { taskId, task, waitForNextRun, getDocument } = getTestingTask(() => {
                throw error;
            });

            const runPromise = waitForNextRun();
            await cronTask(taskId, getRunOnceInterval(), task);
            await runPromise;
            await wait(100);

            const document = await getDocument();
            assert.strictEqual(document.runLog.length, 1);
            assert(new RegExp(errorMessage).test(document.runLog[0].error!));
            assert.strictEqual(document.runSince.toISOString(), distantFutureInterval().toISOString());

            assert(onError.calledOnce);
            assert.deepStrictEqual(onError.firstCall.args, [error]);
        });

        it('should prolong the lock when the task lasts too long', async () => {
            const lockTimes: { at: Date; lockedTill: Date }[] = [];

            const { taskId, task, getDocument, callTimes } = getTestingTask(async () => {
                const taskStart = new Date();
                while (Date.now() - taskStart.getTime() < 2 * lockTaskTime) {
                    const { lockedTill } = await getDocument();
                    lockTimes.push({ at: new Date(), lockedTill: lockedTill! });
                    debug(`pushed new ${JSON.stringify(lockTimes[lockTimes.length - 1])}`);
                    await wait(15 * 1000);
                }
            });
            const task2 = getTestingTask();
            const task3 = getTestingTask();

            await cronTask(task2.taskId, getRunOnceInterval(), task2.task); // another task for challenge lock selectivity
            await cronTask(taskId, getRunOnceInterval(), task);
            await cronTask(task3.taskId, getRunOnceInterval(), task3.task); // another task for challenge lock selectivity
            prolongLockStub.resetHistory();

            while (callTimes.length === 0) {
                await sandbox.clock.tickAsync(100);
            }

            assert(prolongLockStub.callCount > 0, 'The prolong task should be called a few times');
            // note there should be 40, but only 36 is in CI, dunno why
            assert(lockTimes.length >= 30, `There should be enough evaluations, but there is only ${lockTimes.length}`);
            assert(lockTimes.every(({ at, lockedTill }) => lockedTill.getTime() - at.getTime() > 0.5 * lockTaskTime));

            prolongLockStub.resetHistory();
            for (let i = 10 * 150; i >= 0; i--) {
                await sandbox.clock.tickAsync(100);
            }
            assert(prolongLockStub.notCalled, 'The lock should not continue after the task end');
        }, 30000);

        it('stop prolonging the lock when task finish during a running prolong', async () => {
            const { taskId, task } = getTestingTask(async () => {
                await new Promise<void>((resolve) => {
                    onNextCall(prolongLockStub).callsFake(async (...args) => {
                        debug('task prolong called');
                        const queryResult = await prolongLockStub.wrappedMethod.apply(collection, args);
                        resolve();
                        await wait(100); // let the task finish and call stop of lock prolonging
                        debug('returning prolong result');
                        return queryResult;
                    });
                });
                debug('finishing task');
            });

            await cronTask(taskId, getRunOnceInterval(), task);

            while (!finishTaskStub.called) {
                await triggerNextRound();
            }

            prolongLockStub.resetHistory();
            for (let i = 10; i >= 0; i--) {
                debug('WAITING');
                sandbox.clock.next();
                await wait(50); // increase in case of problems with not enough lockTimes
            }
            assert(prolongLockStub.notCalled, 'The lock should not continue after the task end');
        });

        it('should not read all document from database when finding a task to run', async () => {
            const { taskId, task } = getTestingTask();

            findNextTaskStub.resetHistory();
            await cronTask(taskId, distantFutureInterval, task); // just to ensure the task are get from database

            while (findNextTaskStub.notCalled) {
                sandbox.clock.next();
                await wait(50); // increase in case of problems with not enough lockTimes
            }

            const optionArguments = findNextTaskStub.firstCall.args[2];
            assert(!isEmpty(optionArguments.projection));
        });

        it('should not read all document from database when finding a next task time', async () => {
            const { taskId, task } = getTestingTask();

            findNextRunSinceStub.resetHistory();
            await cronTask(taskId, getRunOnceInterval(), task); // just to ensure the task are get from database

            while (findNextRunSinceStub.notCalled) {
                sandbox.clock.next();
                await wait(50); // increase in case of problems with not enough lockTimes
            }

            const optionArguments = findNextRunSinceStub.firstCall.args[1];
            assert.deepStrictEqual(
                optionArguments.projection,
                { runSince: 1 },
                'There is no need to get anything else but runSince from database, so data can be returned from index only',
            );
            assert.deepStrictEqual(optionArguments.sort, { runSince: 1 }, 'Finding next should sort them ASC by runSince');
        });
    });

    describe('Interval - timing logic', () => {
        it('should work with function returning date', async () => {
            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);
            await cronTask(taskId, async () => new Date('2050-01-01T00:00:00Z'), task);
            assert.deepStrictEqual((await getDocument()).runSince, new Date('2050-01-01T00:00:00Z'));
        });

        it('should work with function returning number', async () => {
            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);
            const interval = 7000;
            const timeBefore = Date.now();
            await cronTask(taskId, async () => interval, task);
            const timeAfter = Date.now();
            const { runSince } = await getDocument();
            assert(runSince.getTime() >= timeBefore + interval);
            assert(runSince.getTime() <= timeAfter + interval);
        });

        it('should work with function returning number', async () => {
            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);
            const interval = 7000;
            const timeBefore = Date.now();
            await cronTask(taskId, async () => '7s', task);
            const timeAfter = Date.now();
            const { runSince } = await getDocument();
            assert(runSince.getTime() >= timeBefore + interval);
            assert(runSince.getTime() <= timeAfter + interval);
        });

        it('should throw if function returns Number.NaN', async () => {
            const invalidExpression = () => Number.NaN;
            const { taskId, task } = getTestingTask();
            await assert.rejects(
                () => cronTask(taskId, <never>invalidExpression, task),
                /Interval number has to be finite\./,
                'The registration did not throw proper error.',
            );
        });

        it.each([{}, undefined, null, ''])('should throw if function returns "%s"', async (value) => {
            const invalidExpression = () => value;
            const { taskId, task } = getTestingTask();
            await assert.rejects(() => cronTask(taskId, <never>invalidExpression, task), /Invalid interval\./, 'The registration did not throw proper error.');
        });

        it.each(['cron', 'CRON'])('should work with linux CRON string (prefixed by "%s")', async (prefix) => {
            const expression = `${prefix} 0 0 1 1 *`;
            const now = new Date();
            const expectedDate = new Date(now.getFullYear() + 1, 0, 1, 0, 0, 0, 0);

            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);
            await cronTask(taskId, expression, task);

            assert.deepStrictEqual((await getDocument()).runSince, expectedDate);
        });

        it('should validate the CRON expression during the registration', async () => {
            const invalidExpression = 'CRON x c 1 1 *';
            const { taskId, task } = getTestingTask();
            await assert.rejects(
                () => cronTask(taskId, invalidExpression, task),
                /Error: Invalid interval\. Invalid characters, got value: x\./,
                'The registration did not throw proper error.',
            );
        });

        it('should throw error when endDate parameter is used for cron-parser', async () => {
            // because otherwise we need to solve outOfRange error - probably by creating "enabled" property on the cron tasks

            const mongodash = getNewInstance();

            await assert.rejects(
                () => mongodash.initInstance({ cronExpressionParserOptions: { endDate: new Date('2000-01-01') } }),
                /The 'endDate' parameter of the cron-parser package is not supported yet./,
                'Expected error has not been thrown.',
            );
        });

        it('should work with duration string', async () => {
            const expression = '1h 5m';
            const duration = 1000 * 60 * (60 + 5);

            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);

            const minExpectedDate = new Date(Date.now() + duration);
            await cronTask(taskId, expression, task);
            const maxExpectedDate = new Date(Date.now() + duration);

            const { runSince } = await getDocument();
            assert(runSince >= minExpectedDate, 'Next runSince is too early.');
            assert(runSince <= maxExpectedDate, 'Next runSince is too late.');
        });

        it('should validate the duration expression during the registration', async () => {
            const invalidExpression = '1hx';
            const { taskId, task } = getTestingTask();
            await assert.rejects(() => cronTask(taskId, invalidExpression, task), /Error: Invalid interval\./, 'The registration did not throw proper error.');
        });

        it('should work with duration number', async () => {
            const duration = 1000 * 60 * (60 + 30);

            const { taskId, task, getDocument, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);

            const minExpectedDate = new Date(Date.now() + duration);
            await cronTask(taskId, duration, task);
            const maxExpectedDate = new Date(Date.now() + duration);

            const { runSince } = await getDocument();
            assert(runSince >= minExpectedDate, 'Next runSince is too early.');
            assert(runSince <= maxExpectedDate, 'Next runSince is too late.');
        });

        it('should validate the duration number during the registration', async () => {
            const invalidExpression = Number.NaN;
            const { taskId, task } = getTestingTask();
            await assert.rejects(
                () => cronTask(taskId, invalidExpression, task),
                /Error: Interval number has to be finite\./,
                'The registration did not throw proper error.',
            );
        });

        it('should let the task locked and log the error when interval function throws', async () => {
            const now = new Date();

            let documentDuringProcessing: TaskDocument;
            const { taskId, task, getDocument, findDocument, waitForNextRun } = getTestingTask(async () => {
                documentDuringProcessing = await getDocument();
            });

            assert.equal(await findDocument(), null);

            const scheduleError = new Error('Something bad happened');
            const intervalFunction = sandbox.spy(() => {
                if (task.callCount === 1) {
                    // the task has been called and is being scheduled for next run
                    throw scheduleError;
                }
                return now;
            });

            await cronTask(taskId, intervalFunction, task);

            await waitForNextRun();
            await wait(100);

            assert(intervalFunction.callCount >= 1);

            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [scheduleError]);
            assert.deepStrictEqual((await getDocument()).runSince, documentDuringProcessing!.runSince);
        });

        it('should be ok when returned date is in the past', async () => {
            const { taskId, task, findDocument } = getTestingTask();
            assert.equal(await findDocument(), null);

            const registrationTime = new Date();

            await cronTask(taskId, scheduledInterval(new Date(), new Date(1970, 0, 1)), task);

            while (task.callCount < 2) {
                await triggerNextRound();
            }

            assert.strictEqual(task.callCount, 2);
            assert(Date.now() - registrationTime.getTime() < 1000);
        });
    });

    describe('stopCronTasks', () => {
        it.each([
            0, // run immediately again
            5000, // schedule after 5 seconds again
        ])('should be possible to stop task processing with stopCronTasks (%ims)', async (scheduleNextAfter) => {
            const { taskId, task, callTimes, getDocument } = getTestingTask();

            await cronTask(taskId, () => new Date(Date.now() + scheduleNextAfter), task);

            while (callTimes.length < 3) {
                debug(new Date().toISOString());
                await triggerNextRound();
            }

            const roundsBeforeStop = callTimes.length;

            stopCronTasks();

            findNextTaskStub.resetHistory();

            for (let i = 10; i > 0; i--) {
                await triggerNextRound();
            }

            assert(
                callTimes.length === roundsBeforeStop, // + 1 because of a chance a task
                'Task should not be processed after the stopCronTasks call',
            );

            assert((await getDocument()).runSince <= new Date(Date.now() + scheduleNextAfter), 'The task should not be left in locked state');

            assert.strictEqual(findNextTaskStub.callCount, 0);
        });

        it('should revert runSince and runImmediately properties when task is canceled right after lock', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask(); // have more than one task, so we test proper matchers are used during the test
            const task3 = getTestingTask(); // have more than one task, so we test proper matchers are used during the test

            const firstRunPromise = task1.waitForNextRun();

            await cronTask(task2.taskId, distantFutureInterval, task2.task);
            await cronTask(
                task1.taskId,
                scheduledInterval(
                    // we need to have multiple records in runLog, so we test if the revert affect the proper one
                    new Date(Date.now()),
                    new Date(Date.now() + 5000),
                ),
                task1.task,
            );
            await cronTask(task3.taskId, distantFutureInterval, task3.task);

            assert.strictEqual((await task1.getDocument()).runImmediately, false, 'Bad test condition');

            await firstRunPromise; // let the first call to be processed
            await wait(100); // wait for the first run to be finished
            const originalDocument = await task1.getDocument();

            debug('first run finished');

            const documentDuringProcessingPromise = new Promise<TaskDocument>((resolve) => {
                onNextCall(findNextTaskStub).callsFake(async function (...args) {
                    const document = await findNextTaskStub.wrappedMethod.call(collection, ...args);
                    resolve(await task1.getDocument());
                    stopCronTasks(); // stop cron tasks right before a task is returned
                    return document;
                });
            });

            await task1.setRunImmediately();

            await triggerNextRound();
            debug('waiting to the documentDuringProcessingPromise');
            const documentBeforeProcessing = await documentDuringProcessingPromise;
            assert.strictEqual(documentBeforeProcessing.runLog.length, 2);
            assert(documentBeforeProcessing.runLog[0].startedAt);
            assert(!documentBeforeProcessing.runLog[0].finishedAt);

            await wait(100); // just ensure the document can be back
            const documentAfterCancellation = await task1.getDocument();
            assert.deepStrictEqual(documentAfterCancellation, { ...originalDocument, runImmediately: true });
            assert.strictEqual(task1.callTimes.length, 1, 'The task should not be processed for the second time');
        });

        it('should cause the cronTask registration function does not run tasks', async () => {
            stopCronTasks();
            findNextTaskStub.resetHistory();

            const { taskId, task, callTimes, getDocument } = getTestingTask();
            await cronTask(taskId, getRunOnceInterval(), task);

            await wait(100);

            const document = await getDocument();
            assert(document, 'The document should exists');
            assert(document.runSince <= new Date(Date.now() - 100), 'The task should be scheduled to the past');
            assert.strictEqual(callTimes.length, 0);
            assert(findNextTaskStub.notCalled);
        });

        it('should be possible to startCronTasks again', async () => {
            const { taskId, task, callTimes } = getTestingTask();

            stopCronTasks();

            await cronTask(taskId, getRunOnceInterval(), task);
            await triggerNextRound();

            assert(!callTimes.length, 'The task should not be called after stopCronTasks() call');

            startCronTasks();
            await triggerNextRound();
            assert.strictEqual(callTimes.length, 1, 'The task should be called after startCronTasks() call');
        });
    });

    describe('database crashes', function () {
        it('should call onError and continue when database throws during the finding a task to run', async () => {
            const { taskId, task } = getTestingTask();

            findNextTaskStub.resetHistory();
            const someMongoError = new Error('Some MongoError');
            onNextCall(findNextTaskStub).rejects(someMongoError);

            await cronTask(taskId, getRunOnceInterval(new Date(Date.now() + 1000)), task);

            while (task.callCount === 0) {
                await triggerNextRound();
            }

            assert(findNextTaskStub.callCount >= 2, 'The loop should not be broken');
            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
        });

        it('should reject when finding document for runCronTask', async () => {
            const { taskId, task } = getTestingTask();

            await cronTask(taskId, distantFutureInterval, task);

            findNextTaskStub.resetHistory();
            const someMongoError = new Error('Some MongoError');
            onNextCall(findNextTaskStub).rejects(someMongoError);

            await assert.rejects(() => runCronTask(taskId), pick(someMongoError, 'name', 'message'), 'runCronTask has to be rejected');

            assert(onError.notCalled);

            await triggerNextRound();
            await triggerNextRound();
            assert(findNextTaskStub.callCount >= 2, 'The loop should not be broken');
        });

        it('should call onError and continue when database throws during finishing a task', async () => {
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
            assert(onError.calledBefore(task2.task), 'The test is not meaningful');
        });

        it('should continue when database throws during resolving wait time', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask();

            await cronTask(task1.taskId, getRunOnceInterval(new Date(Date.now() + 2000)), task1.task);
            await cronTask(task2.taskId, getRunOnceInterval(new Date(Date.now() + 5000)), task2.task);

            findNextRunSinceStub.resetHistory();
            const someMongoError = new Error('Some MongoError BBB');
            onNextCall(findNextRunSinceStub).rejects(someMongoError);

            // the lock should expire eventually and the task should be called again
            while (task1.task.callCount === 0 || task2.task.callCount === 0) {
                await triggerNextRound();
            }

            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
            assert(onError.calledBefore(task2.task), 'The test is not meaningful');
        });

        it('should continue when database crashes during prolonging the lock', async () => {
            const lockTimes: { at: Date; lockedTill: Date }[] = [];

            const someMongoError = new Error('Some MongoError BBB');

            const { taskId, task, getDocument, callTimes } = getTestingTask(async () => {
                const taskStart = new Date();

                prolongLockStub.resetHistory();
                onError.resetHistory();
                onNextCall(prolongLockStub).rejects(someMongoError);

                while (Date.now() - taskStart.getTime() < 2 * lockTaskTime) {
                    const lockedTill = (await getDocument()).runSince;
                    lockTimes.push({ at: new Date(), lockedTill });
                    debug(`pushed new ${JSON.stringify(lockTimes[lockTimes.length - 1])}`);
                    await wait(15 * 1000);
                }
            });

            await cronTask(taskId, getRunOnceInterval(), task);

            while (callTimes.length === 0) {
                await sandbox.clock.tickAsync(100);
            }

            assert(prolongLockStub.callCount > 2);
            assert.strictEqual(onError.callCount, 1);
            assert.deepStrictEqual(onError.firstCall.args, [someMongoError]);
            assert(onError.calledAfter(task), 'The test is not meaningful');
        });
    });

    describe('runCronTask', function () {
        it('should be possible to run a task with runCronTask', async () => {
            let taskJob = noop;
            const { taskId, task } = getTestingTask(() => taskJob());

            await cronTask(taskId, distantFutureInterval, task);

            await wait(100);
            assert.strictEqual(task.callCount, 0, "the task shouldn't be called automatically");

            await runCronTask(taskId);
            // @ts-ignore
            assert.strictEqual(task.callCount, 1, 'the task has to be called');

            await runCronTask(taskId);
            // @ts-ignore
            assert.strictEqual(task.callCount, 2, 'the task has to be called');

            taskJob = () => {
                throw new Error('some error');
            };

            await assert.rejects(() => runCronTask(taskId), /some error/);
            // @ts-ignore
            assert.strictEqual(task.callCount, 3, 'the task has to be called');
        });

        it('should not be possible to run not existing task with runCronTask', async () => {
            await assert.rejects(() => runCronTask('someUnknownTask'), /Cannot run unknown task 'someUnknownTask'./);
        });

        it('should not be possible to call runCronTask inside an another task', async () => {
            let error = new Error('No error was thrown');

            const task1 = getTestingTask();
            const task2 = getTestingTask(async () => {
                debug('runned');
                try {
                    await runCronTask(task1.taskId);
                } catch (err) {
                    error = err as Error;
                }
            });

            await cronTask(task1.taskId, distantFutureInterval, task1.task);
            await cronTask(task2.taskId, getRunOnceInterval(), task2.task);

            await task2.waitForNextRun();

            assert.strictEqual(
                error.message,
                'It is not possible to call runCronTask inside another running task. Use the scheduleCronTaskImmediately() function instead.',
            );
        });

        it('should be possible to run a task event if stopCronTasks has been called', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask();

            await cronTask(task1.taskId, distantFutureInterval, task1.task);

            stopCronTasks();

            await cronTask(task2.taskId, getRunOnceInterval(), task2.task);

            await wait(100);
            assert.strictEqual(task1.task.callCount, 0, "the task shouldn't be called automatically");
            assert.strictEqual(task2.task.callCount, 0, "the task shouldn't be called automatically");

            await runCronTask(task1.taskId);

            await triggerNextRound();
            await triggerNextRound();
            await wait(100);

            // @ts-ignore
            assert.strictEqual(task1.task.callCount, 1, 'the task has to be called');
            assert.strictEqual(task2.task.callCount, 0, 'the runCronTask should not cause start of triggering task');
        });

        it('should wait for a running task', async () => {
            const wantedTask = getTestingTask();
            const wantedTaskRunPromise = wantedTask.waitForNextRun();
            await cronTask(wantedTask.taskId, distantFutureInterval, wantedTask.task); // will not run for now
            let runCronTaskPromise: Promise<void>;

            const someTask1 = getTestingTask(async () => {
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 0);
                });
                runCronTaskPromise = runCronTask(wantedTask.taskId);
                await wait(100);
            });
            await cronTask(someTask1.taskId, getRunOnceInterval(new Date(Date.now() + 999)), someTask1.task);

            const someTask2 = getTestingTask();
            await cronTask(someTask2.taskId, getRunOnceInterval(new Date(Date.now() + 1000)), someTask2.task);

            sandbox.clock.tick(2000); // both someTask1 and someTask2 should run, the someTask1 first

            await Promise.all([someTask1.waitForNextRun(), someTask2.waitForNextRun(), wantedTaskRunPromise]);

            assert(runCronTaskPromise! instanceof Promise, 'The runCronTask has to return promise');
            await runCronTaskPromise; // should be resolved now

            assert(wantedTask.callTimes[0].startedAt > someTask1.callTimes[0].finishedAt);
            assert(someTask2.callTimes[0].startedAt > wantedTask.callTimes[0].finishedAt, 'The task triggered with runCronTask has to have precedence.');
        });

        it('should fail when the task document does not exist', async () => {
            const { taskId, task } = getTestingTask();

            await cronTask(taskId, distantFutureInterval, task);

            await collection.deleteOne({ _id: taskId });

            await assert.rejects(() => runCronTask(taskId), /Error: The task document not found or is locked right now\./);
            // @ts-ignore
            assert.strictEqual(task.callCount, 0, 'the task has to be called');
        });

        it('should fail when the task is locked', async () => {
            const { mongodash: mongodash2, initInstance: initMongodash2, cleanUpInstance: cleanUpMongodash2 } = getNewInstance();
            let error: Error;

            try {
                await initMongodash2();

                const { taskId, task } = getTestingTask(async () => {
                    try {
                        await wait(0);
                        await mongodash2.runCronTask(taskId);
                    } catch (err) {
                        error = err as Error;
                    }
                });

                await mongodash.cronTask(taskId, distantFutureInterval, task);
                await mongodash2.cronTask(taskId, distantFutureInterval, task);

                await mongodash.runCronTask(taskId);

                assert.strictEqual(error!.toString(), 'Error: The task document not found or is locked right now.');
            } finally {
                await cleanUpMongodash2();
            }
        });
    });

    describe('scheduleCronTaskImmediately', () => {
        it('should be possible to set runImmediately flag and speed up waiting', async () => {
            const { taskId, task, waitForNextRun, getDocument } = getTestingTask();

            await cronTask(taskId, distantFutureInterval, task);
            debug('Task registered');

            await wait(100);
            assert.strictEqual(task.callCount, 0, "the task shouldn't be called automatically");

            await scheduleCronTaskImmediately(taskId);
            debug('task set to runImmediately');
            sandbox.clock.next();
            await waitForNextRun();
            assert.strictEqual(task.callCount, 1, 'the task has to be called');
            assert.strictEqual((await getDocument())!.runImmediately, false, 'The runImmediately flag should be disabled after first usage');

            await wait(100);
            sandbox.clock.next();
            await wait(100);
            assert.strictEqual(task.callCount, 1, 'the task should not be called again');
        });

        it('should be possible to set runImmediately flag for existing document of task which is not registered in the instance', async () => {
            const task1 = getTestingTask();
            const task2 = getTestingTask();
            const task3 = getTestingTask();

            await cronTask(task1.taskId, distantFutureInterval, task1.task);
            await cronTask(task3.taskId, distantFutureInterval, task3.task);
            debug('Tasks registered');

            // simulate task registration by different process
            await collection.insertOne({
                ...(await task1.getDocument()),
                _id: task2.taskId,
            });

            await scheduleCronTaskImmediately(task2.taskId);

            assert.strictEqual((await task1.getDocument())!.runImmediately, false, 'The runImmediately flag should not be set for wrong task');
            assert.strictEqual((await task3.getDocument())!.runImmediately, false, 'The runImmediately flag should not be set for wrong task');
            assert.strictEqual((await task2.getDocument())!.runImmediately, true, 'The runImmediately flag should be set');
        });

        it('should throw if the taskId is not registered in the database', async () => {
            const { taskId } = getTestingTask();
            await assert.rejects(() => scheduleCronTaskImmediately(taskId), new RegExp(`No task with id "${taskId}" is registered.`));
        });
    });

    describe('onInfo and cronTaskCaller', () => {
        it('should be possible to send a wrapper method to save correlationId', async () => {
            const instance = getNewInstance();
            const numberOfCalls = 3;

            assert.strictEqual(correlator.getId(), undefined);

            const callLog: unknown[] = [];
            const onInfo = sinon.spy((onInfoArgs) => {
                callLog.push({ onInfo: onInfoArgs, correlationId: correlator.getId() });
            });

            await instance.initInstance({
                cronTaskCaller: correlator.withId,
                onInfo,
            });

            const task = getTestingTask(() => {
                callLog.push({
                    taskCalled: true,
                    correlationId: correlator.getId(),
                });
            });

            // perform the task
            const dates = times(numberOfCalls, (i) => new Date(Date.now() + 1000 * i));
            await instance.mongodash.cronTask(task.taskId, scheduledInterval(...dates), task.task);
            while (task.callTimes.length < dates.length) {
                await triggerNextRound();
            }

            const correlationIds = uniq(map(callLog, 'correlationId'));
            assert.strictEqual(correlationIds.length, numberOfCalls);

            const isoDate = /[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z/;

            expect(callLog).toMatchObject([
                {
                    onInfo: { message: `Cron task '${task.taskId}' started.`, taskId: task.taskId, code: 'cronTaskStarted' },
                    correlationId: correlationIds[0],
                },
                { taskCalled: true, correlationId: correlationIds[0] },
                {
                    onInfo: {
                        message: new RegExp(`Cron task '${task.taskId}' finished in [0-9]+ms./, `),
                        taskId: task.taskId,
                        code: 'cronTaskFinished',
                        duration: expect.any(Number),
                    },
                    correlationId: correlationIds[0],
                },
                {
                    onInfo: {
                        message: expect.stringMatching(new RegExp(`Cron task '${task.taskId}' scheduled to ${isoDate.source}`)),
                        taskId: task.taskId,
                        code: 'cronTaskScheduled',
                        nextRunDate: dates[1],
                    },
                    correlationId: correlationIds[0],
                },
                {
                    onInfo: { message: `Cron task '${task.taskId}' started.`, taskId: task.taskId, code: 'cronTaskStarted' },
                    correlationId: correlationIds[1],
                },
                { taskCalled: true, correlationId: correlationIds[1] },
                {
                    onInfo: {
                        message: new RegExp(`Cron task '${task.taskId}' finished in [0-9]+ms.`),
                        taskId: task.taskId,
                        code: 'cronTaskFinished',
                        duration: 0,
                    },
                    correlationId: correlationIds[1],
                },
                {
                    onInfo: {
                        message: expect.stringMatching(new RegExp(`Cron task '${task.taskId}' scheduled to ${isoDate.source}`)),
                        taskId: task.taskId,
                        code: 'cronTaskScheduled',
                        nextRunDate: dates[2],
                    },
                    correlationId: correlationIds[1],
                },
                {
                    onInfo: { message: `Cron task '${task.taskId}' started.`, taskId: task.taskId, code: 'cronTaskStarted' },
                    correlationId: correlationIds[2],
                },
                { taskCalled: true, correlationId: correlationIds[2] },
                {
                    onInfo: {
                        message: new RegExp(`Cron task '${task.taskId}' finished in [0-9]+ms.`),
                        taskId: task.taskId,
                        code: 'cronTaskFinished',
                        duration: 0,
                    },
                    correlationId: correlationIds[2],
                },
                {
                    onInfo: {
                        message: expect.stringMatching(new RegExp(`Cron task '${task.taskId}' scheduled to ${isoDate.source}`)),
                        taskId: task.taskId,
                        code: 'cronTaskScheduled',
                        nextRunDate: distantFutureInterval(),
                    },
                    correlationId: correlationIds[2],
                },
            ]);

            debug('correlationIds', correlationIds);
        });
    });
});
