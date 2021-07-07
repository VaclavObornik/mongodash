/* eslint-disable @typescript-eslint/no-var-requires */
import * as assert from 'assert';
import _debug from 'debug';
import { times } from 'lodash';
import { createSandbox } from 'sinon';
import { getNewInstance, wait } from './testHelpers';

const debug = _debug('mongodash:withLockTests');

describe('withLock', () => {
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
        const minSuccessfulJobs = maxSuccessfulJobs - 1;
        assert(successfulJobs.length >= minSuccessfulJobs, `Count of successfulJobs (${successfulJobs.length}) is lower than minSuccessfulJobs (${minSuccessfulJobs})`);
        assert(successfulJobs.length <= maxSuccessfulJobs, `Count of successfulJobs (${successfulJobs.length}) is greater than maxSuccessfulJobs (${maxSuccessfulJobs})`);

        assert(
            callTimes.every((time, i) => {
                const previousCall = callTimes[i - 1];
                return !previousCall || time.startedAt >= previousCall.finishedAt;
            }),
            `The job call times should not overlap:\n ${JSON.stringify(callTimes, null, 2)}`,
        );
    }, 7000);
});
