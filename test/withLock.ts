/* eslint-disable @typescript-eslint/no-var-requires */
import * as assert from 'assert';
import _debug from 'debug';
import { isEqual, matches, noop, times } from 'lodash';
import { createSandbox } from 'sinon';
import { getNewInstance, wait } from './testHelpers';
import { IndexSpecification } from 'mongodb';
import { equal } from 'assert';
import { unexpectedExitRegistry } from '@stryker-mutator/core/dist/src/di/core-tokens';

const debug = _debug('mongodash:withLockTests');

describe.only('withLock', () => {
    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
    });
    afterEach(() => instance.cleanUpInstance());

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
            withLock(key, stub, { maxWaitForLock, firstDelay: 50, expireIn: 15 * 1000 }).then(
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
        const { withLock } = instance.mongodash;
        const key = `key-${time}`;
        const promise = withLock(key, async () => {
            await wait(time * 2);
        });

        const start = new Date();
        await assert.rejects(() => withLock(key, noop, { maxWaitForLock: time }), /The lock is already acquired./);
        const end = new Date();
        const realWait = end.getTime() - start.getTime();
        debug(`start at ${start.toISOString()}, end at ${end.toISOString()}, difference ${realWait}`);
        assert(realWait >= time * 0.66, `The wait time was not long enough (${realWait}).`);
        assert(realWait <= time, `The wait time was too long (${realWait})`);

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
                assert(timeDiff < 100, `It taken too long to acquire lock: ${timeDiff}`);
            },
            { maxWaitForLock: 5000, startDelay: 1000 },
        );
    });

    it('should propagate error and release the lock on failure', async () => {
        const { withLock } = instance.mongodash;
        const key = 3;
        await assert.rejects(
            () =>
                withLock(key, async () => {
                    throw new Error('Some error!!!');
                }),
            /Some error!!!/,
        );

        const start = new Date();
        await withLock(
            key,
            async () => {
                const timeDiff = Date.now() - start.getTime();
                assert(timeDiff < 50, `It taken too long to acquire lock: ${timeDiff}`);
            },
            { maxWaitForLock: 5000, startDelay: 1000 },
        );
    });

    it('should create expiration index on right field and use it in lock', async () => {
        const { withLock, getCollection } = instance.mongodash;
        const key = 5;
        const defaultExpiration = 15 * 1000;
        const collection = getCollection('locks');
        const expirationKey = 'expiresAt';

        await withLock(key, async () => {
            const doc = await collection.findOne({ _id: `${key}` });
            assert(doc[expirationKey] <= new Date(Date.now() + defaultExpiration), 'expiration is too long');
            assert(doc[expirationKey] >= new Date(Date.now() + defaultExpiration - 1000), 'expiration is too short');

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
