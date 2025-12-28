import { Collection, Filter, ObjectId, UpdateFilter } from 'mongodb';
import { onError } from './OnError';

type StopContinuousLock = () => Promise<void>;

export function createContinuousLock<DocumentType extends { _id: string | ObjectId }>(
    collection: Collection<DocumentType>,
    documentId: DocumentType['_id'],
    lockProperty: keyof DocumentType,
    lockTime: number,
): StopContinuousLock {
    let taskInProgress = true;
    let prolongLockTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastProlongPromise: Promise<unknown> = Promise.resolve(); // all errors have to be suppressed

    function scheduleLockProlong() {
        prolongLockTimeoutId = setTimeout(() => {
            prolongLockTimeoutId = null;
            lastProlongPromise = (async () => {
                try {
                    // debug('performing lock prolong');
                    if (!taskInProgress) return;
                    await collection.updateOne(
                        { _id: documentId } as Filter<DocumentType>,
                        {
                            $set: { [lockProperty]: new Date(Date.now() + lockTime) },
                        } as UpdateFilter<DocumentType>,
                    );
                } catch (err) {
                    // debug('Error during task prolong', err);
                    onError(err as Error);
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
