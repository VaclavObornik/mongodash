'use strict';

// import * as _debug from 'debug';
import { backOff } from 'exponential-backoff';
import { Collection, Document, ObjectId } from 'mongodb';
import { createContinuousLock } from './createContinuousLock';
import { getCollection } from './getCollection';
import { OnError } from './OnError';

// const debug = _debug('mongodash:withLock');

let onError: OnError;

export function init(options: { onError: OnError }): void {
    onError = options.onError;
}

export type LockKey = string | number | ObjectId;

export type LockCallback<T> = () => Promise<T>;

export type LockerOptions = {
    maxWaitForLock?: number;
    startingDelay?: number;
    expireIn?: number;
};

const lockAcquiredMessage = 'The lock is already acquired.';

let collectionPromise: Promise<Collection<Document>>;
async function getLockerCollection() {
    if (!collectionPromise) {
        collectionPromise = (async () => {
            const collection = getCollection<Document>('locks');
            await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
            return collection;
        })();
    }
    return collectionPromise;
}

export async function withLock<T>(
    key: LockKey,
    callback: LockCallback<T>,
    { maxWaitForLock = 3 * 1000, startingDelay = 50, expireIn = 15 * 1000 }: LockerOptions = {},
): Promise<T> {
    const lockId = new ObjectId();
    const stringKey = `${key}`;
    const expirationKey = 'expiresAt';

    const collection = await getLockerCollection();

    const releaseLock = () => collection.deleteOne({ _id: stringKey, lockId });

    const acquireLock = async () => {
        // debug('acquireLock called');
        try {
            const now = new Date();
            const matcher = { _id: stringKey, [expirationKey]: { $lte: now } };
            const doc = { lockId, [expirationKey]: new Date(now.getTime() + expireIn) };
            await collection.replaceOne(matcher, doc, { upsert: true });
        } catch (err) {
            if ([11000, 11001].includes(err.code)) {
                throw new Error(lockAcquiredMessage);
            }
            await releaseLock(); // the lock could be possible acquired
            throw err;
        }
    };

    const maxDate = new Date(Date.now() + maxWaitForLock);
    const maxDelay = Math.max(startingDelay, maxWaitForLock / 3);

    const timeMultiple = Math.random() * (3 - 1) + 1; // Random from 1 to 3

    await backOff(acquireLock, {
        delayFirstAttempt: false,
        jitter: 'none', // 'full' randomize is not convenient, it multiplies 0-1 times, so we randomize timeMultiple at least
        numOfAttempts: Number.MAX_SAFE_INTEGER,
        startingDelay,
        timeMultiple,
        maxDelay,
        retry: (err: Error /*, n*/) => {
            const possibleNextRetry = new Date(Date.now() + maxDelay);
            // debug(`resolving retry ${n}, timeMultiple ${timeMultiple}, maxDate ${maxDate.toLocaleTimeString()}.${maxDate.getMilliseconds()}, possibleNextRetry ${possibleNextRetry.toLocaleTimeString()}.${possibleNextRetry.getMilliseconds()}`);
            return err.message === lockAcquiredMessage && possibleNextRetry < maxDate;
        },
    });

    // todo solve the "any"
    const stopContinuousLock = createContinuousLock(<any>collection, stringKey, expirationKey, expireIn, onError);

    try {
        // intentional await because of finally block
        return await callback();
    } finally {
        await Promise.all([stopContinuousLock(), releaseLock()]);
    }
}
