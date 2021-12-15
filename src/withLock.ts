'use strict';

// import * as _debug from 'debug';
import { Collection, MongoError, ObjectId } from 'mongodb';
import { createContinuousLock } from './createContinuousLock';
import { getCollection } from './getCollection';
import { OnError } from './OnError';
import { random } from 'lodash';

// const debug = _debug('mongodash:withLock');

let onError: OnError;

export function init(options: { onError: OnError }): void {
    onError = options.onError;
}

export type LockKey = string | number | ObjectId;

export type LockCallback<T> = () => Promise<T>;

interface LockDocument {
    _id: string;
    expiresAt: Date;
    lockId: ObjectId;
}

export type WithLockOptions = {
    maxWaitForLock?: number;
    startingDelay?: number;
    expireIn?: number;
};

const lockAcquiredMessage = 'The lock is already acquired.';
const expirationKey = 'expiresAt';

let collectionPromise: Promise<Collection<LockDocument>>;
async function getLockerCollection() {
    if (!collectionPromise) {
        collectionPromise = (async () => {
            const collection = getCollection<LockDocument>('locks');
            await collection.createIndex({ [expirationKey]: 1 }, { name: 'expiresAtIndex', expireAfterSeconds: 0 });
            return collection;
        })();
    }
    return collectionPromise;
}

export class LockAlreadyAcquiredError extends Error {
    constructor(public readonly key: LockKey) {
        super(lockAcquiredMessage);
    }
}

export function isLockAlreadyAcquiredError(err: unknown, key?: LockKey): boolean {
    const rightError = err instanceof LockAlreadyAcquiredError;
    if (!rightError) {
        return false;
    }
    return key ? err.key === key : true;
}

export async function withLock<T>(
    key: LockKey,
    callback: LockCallback<T>,
    { maxWaitForLock = 3 * 1000, startingDelay = 50, expireIn = 15 * 1000 }: WithLockOptions = {},
): Promise<T> {
    const lockId = new ObjectId();
    const stringKey = `${key}`;
    const maxDate = new Date(Date.now() + maxWaitForLock);
    // maxDate is lowered for a queryDurationEstimate because we will try to acquire the lock after last wait

    const collection = await getLockerCollection();

    const releaseLock = () => collection.deleteOne({ _id: stringKey, lockId });

    let lastAcquireDuration = 0;
    const acquireLock = async () => {
        // debug('acquireLock called');
        const now = new Date();
        try {
            const matcher = { _id: stringKey, [expirationKey]: { $lte: now } };
            const doc = { lockId, [expirationKey]: new Date(now.getTime() + expireIn) };
            await collection.replaceOne(matcher, doc, { upsert: true });
        } catch (err) {
            if ([11000, 11001].includes(<number>(err as MongoError).code)) {
                throw new LockAlreadyAcquiredError(key);
            }
            await releaseLock(); // the lock could be possible acquired
            throw err;
        } finally {
            lastAcquireDuration = Date.now() - now.getTime();
            // debug(`lastAcquireDuration: ${lastAcquireDuration}`);
        }
    };

    const maxDelay = Math.max(startingDelay, maxWaitForLock / 3);

    for (let n = 0; n < Number.MAX_SAFE_INTEGER; n++) {
        try {
            await acquireLock();
            break;
        } catch (err) {
            const randomMultiplier = random(1, 1.2, true);
            let waitTime = Math.min(2 ** n * randomMultiplier * startingDelay, maxDelay);
            let nextTime = new Date(Date.now() + waitTime);

            const ultimateAttemptStart = new Date(maxDate.getTime() - lastAcquireDuration);
            const restTime = ultimateAttemptStart.getTime() - Date.now();
            if (nextTime >= ultimateAttemptStart && restTime >= startingDelay) {
                // debug(`optimizing last wait time`);
                waitTime = restTime;
                nextTime = ultimateAttemptStart;
            }

            // debug(`wait time ${waitTime} for ${n}`);

            if (isLockAlreadyAcquiredError(err, key) && nextTime <= ultimateAttemptStart) {
                await new Promise((resolve) => setTimeout(resolve, waitTime));
            } else {
                throw err;
            }
        }
    }

    const stopContinuousLock = createContinuousLock(collection, stringKey, expirationKey, expireIn, onError);

    const cleanUp = () => Promise.all([stopContinuousLock(), releaseLock()]);

    let value: T;
    let err: Error;
    try {
        value = await callback();
    } catch (error) {
        err = error as Error;
    }

    await cleanUp();
    if (err!) {
        throw err;
    }

    return value!;
}
