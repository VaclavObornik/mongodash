'use strict';

// import * as _debug from 'debug';
import { Collection, Document, ObjectId } from 'mongodb';
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

export type LockerOptions = {
    maxWaitForLock?: number;
    startingDelay?: number;
    expireIn?: number;
};

const lockAcquiredMessage = 'The lock is already acquired.';
const expirationKey = 'expiresAt';

let collectionPromise: Promise<Collection<Document>>;
async function getLockerCollection() {
    if (!collectionPromise) {
        collectionPromise = (async () => {
            const collection = getCollection<Document>('locks');
            await collection.createIndex({ [expirationKey]: 1 }, { name: 'expiresAtIndex', expireAfterSeconds: 0 });
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
    const maxDate = new Date(Date.now() + maxWaitForLock);

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

    const maxDelay = Math.max(startingDelay, maxWaitForLock / 3);

    for (let n = 0; n < Number.MAX_SAFE_INTEGER; n++) {
        try {
            await acquireLock();
            break;
        } catch (err) {
            const randomMultiplier = random(1, 1.2, true);
            const waitTime = Math.min(2 ** n * randomMultiplier * startingDelay, maxDelay);
            const nextTime = new Date(Date.now() + waitTime);
            // debug(`wait time ${waitTime} for ${n}`);

            if (err.message === lockAcquiredMessage && nextTime < maxDate) {
                await new Promise((resolve) => setTimeout(resolve, waitTime));
            } else {
                throw err;
            }
        }
    }

    // todo solve the "any"
    const stopContinuousLock = createContinuousLock(<any>collection, stringKey, expirationKey, expireIn, onError);

    let value: T;
    try {
        value = await callback();
    } finally {
        await Promise.all([stopContinuousLock(), releaseLock()]);
    }
    return value;
}
