import * as assert from 'assert';
import _debug from 'debug';
import { isEqual, times } from 'lodash';
import { Document } from 'mongodb';
import { createSandbox } from 'sinon';
import { getNewInstance, wait } from './testHelpers';

const debug = _debug('mongodash:withLockTests');

describe('withLock', () => {
    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
    });
    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should process concurrent tasks one by one', async () => {
        const { withLock } = instance.mongodash;
        const expectedReturnValue = 1000;

        const key = '1';
        const callTimes: Array<{ startedAt: Date; finishedAt: Date }> = [];
        const jobTime = 1000;
        const maxWaitForLock = 5000;

        const stubs = times(10, () =>
            sandbox.spy(async () => {
                const startedAt = new Date();
                debug('Called method');
                await wait(jobTime);
                callTimes.push({ startedAt, finishedAt: new Date() });
                return expectedReturnValue;
            }),
        );

        const jobs = stubs.map((stub) =>
            withLock(key, stub, { maxWaitForLock, startingDelay: 50, expireIn: 15 * 1000 }).then(
                (result: number) => debug(`Result ${result}`),
                (err: Error) => debug(`Thrown ${err}`), // Need to suppress error, NodeJS 10 cannot Promise.allSettled()
            ),
        );

        await Promise.all(jobs);

        const successfulJobs = stubs.filter((stub) => stub.called);
        const maxSuccessfulJobs = maxWaitForLock / jobTime;
        const minSuccessfulJobs = maxSuccessfulJobs * 0.5;
        assert(
            successfulJobs.length >= minSuccessfulJobs,
            `Count of successfulJobs (${successfulJobs.length}) is lower than minSuccessfulJobs (${minSuccessfulJobs}); maxSuccessfulJobs (${maxSuccessfulJobs})`,
        );
        assert(
            successfulJobs.length <= maxSuccessfulJobs,
            `Count of successfulJobs (${successfulJobs.length}) is greater than maxSuccessfulJobs (${maxSuccessfulJobs})`,
        );

        assert(
            callTimes.every((time, i) => {
                const previousCall = callTimes[i - 1];
                return !previousCall || time.startedAt >= previousCall.finishedAt;
            }),
            `The job call times should not overlap:\n ${JSON.stringify(callTimes, null, 2)}`,
        );
    }, 7000);

    it.each([100, 500, 1000])('should throw if the lock cannot be acquired in a %i ms', async (time) => {
        const { withLock, isLockAlreadyAcquiredError, LockAlreadyAcquiredError } = instance.mongodash;
        const key = `key-${time}`;
        const promise = withLock(key, async () => {
            await wait(time * 2);
        });

        const startingDelay = 50;
        const start = new Date();
        let caughtError: any;
        await assert.rejects(async () => {
            try {
                await withLock(
                    key,
                    async () => {
                        /* noop */
                    },
                    { maxWaitForLock: time, startingDelay },
                );
            } catch (err) {
                caughtError = err;
                throw err;
            }
        }, /The lock is already acquired./);

        const end = new Date();
        const realWait = end.getTime() - start.getTime();
        debug(`start at ${start.toISOString()}, end at ${end.toISOString()}, difference ${realWait}`);
        const tolerance = 100;
        assert(realWait >= time - startingDelay - tolerance, `The wait time was not long enough (${realWait}).`);
        assert(realWait <= time + startingDelay + tolerance, `The wait time was too long (${realWait})`);

        assert.strictEqual(caughtError instanceof LockAlreadyAcquiredError, true);
        assert.strictEqual(isLockAlreadyAcquiredError(caughtError), true);
        assert.strictEqual(isLockAlreadyAcquiredError(caughtError, key), true);
        assert.strictEqual(isLockAlreadyAcquiredError(caughtError, 'anotherKey'), false);

        await promise;
    });

    it('should acquire lock immediately', async () => {
        const { withLock } = instance.mongodash;
        const key = 2;
        const start = new Date();
        await withLock(
            key,
            async () => {
                const timeDiff = Date.now() - start.getTime();
                assert(timeDiff < 500, `It taken too long to acquire lock: ${timeDiff}`);
            },
            { maxWaitForLock: 5000, startingDelay: 1000 },
        );
    });

    it('should propagate error and release the lock on failure', async () => {
        const { withLock, LockAlreadyAcquiredError, isLockAlreadyAcquiredError } = instance.mongodash;
        const key = 3;
        let caughtError: any;
        await assert.rejects(async () => {
            try {
                await withLock(key, async () => {
                    throw new Error('Some error!!!');
                });
            } catch (err) {
                caughtError = err;
                throw err;
            }
        }, /Some error!!!/);

        const start = new Date();
        await withLock(
            key,
            async () => {
                const timeDiff = Date.now() - start.getTime();
                assert(timeDiff < 300, `It taken too long to acquire lock: ${timeDiff}`);
            },
            { maxWaitForLock: 5000, startingDelay: 1000 },
        );

        assert.strictEqual(caughtError instanceof LockAlreadyAcquiredError, false);
        assert.strictEqual(isLockAlreadyAcquiredError(caughtError), false);
        assert.strictEqual(isLockAlreadyAcquiredError(caughtError, key), false);
        assert.strictEqual(isLockAlreadyAcquiredError(caughtError, 'anotherKey'), false);
    });

    it('should create expiration index on right field and use it in lock', async () => {
        const { withLock, getCollection } = instance.mongodash;
        const key = 5;
        const defaultExpiration = 15 * 1000;
        const collection = getCollection<Document & { _id: string }>('locks');
        const expirationKey = 'expiresAt';

        await withLock(key, async () => {
            const doc = await collection.findOne({ _id: `${key}` });
            assert(doc![expirationKey] <= new Date(Date.now() + defaultExpiration), 'expiration is too long');
            assert(doc![expirationKey] >= new Date(Date.now() + defaultExpiration - 1000), 'expiration is too short');

            const expectedIndex = { name: 'expiresAtIndex', key: { [expirationKey]: 1 }, expireAfterSeconds: 0 };
            const indexes = await collection.listIndexes().toArray();
            assert(
                indexes.some(
                    ({ key, name, expireAfterSeconds }: { key: string; name: string; expireAfterSeconds?: number }) =>
                        isEqual(expectedIndex.key, key) && name === expectedIndex.name && expireAfterSeconds === expectedIndex.expireAfterSeconds,
                ),
                'The index should be created',
            );
        });
    });

    it.todo(
        'should prolong the lock if the task lasts too long' /*, async () => {
        const { withLock, getCollection } = instance.mongodash;
        const key = 2;
        const start = new Date();
        await withLock(key, async () => {
            const timeDiff = Date.now() - start.getTime();
            assert(timeDiff < 50, `It taken too long to acquire lock: ${timeDiff}`);
        });
    }*/,
    );
});
