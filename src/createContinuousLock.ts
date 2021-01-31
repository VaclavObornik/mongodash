import { Collection } from 'mongodb';
import { OnError } from './OnError';

export function createContinuousLock(collection: Collection, documentId: string, lockProperty: string, lockTime: number, onError: OnError) {
    let taskInProgress = true;
    let prolongLockTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastProlongPromise: Promise<unknown> = Promise.resolve(); // all errors has to be suppressed

    function scheduleLockProlong() {
        prolongLockTimeoutId = setTimeout(() => {
            prolongLockTimeoutId = null;
            lastProlongPromise = (async () => {
                try {
                    // debug('performing lock prolong');
                    await collection.updateOne({ _id: documentId }, { $set: { lockedTill: new Date(Date.now() + lockTime) } });
                } catch (err) {
                    // debug('Error during task prolong', err);
                    onError(err);
                } finally {
                    if (taskInProgress) {
                        // debug('scheduling next lock prolong');
                        scheduleLockProlong();
                    }
                }
            })();
        }, lockTime / 5);
    }

    scheduleLockProlong();

    /** Should never throw! */
    return async () => {
        taskInProgress = false; // prevent next scheduling
        if (prolongLockTimeoutId) {
            clearTimeout(prolongLockTimeoutId);
        }
        await lastProlongPromise;
    };
}
