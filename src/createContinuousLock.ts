import { Collection, Filter, ObjectId, UpdateFilter } from 'mongodb';
import { onError } from './OnError';

type StopContinuousLock = () => Promise<void>;

export interface CreateContinuousLockOptions {
    /**
     * Initial value of the lock property written by whoever acquired the lock.
     * When provided, every renewal becomes a compare-and-swap: the update only
     * succeeds if the lock still carries the previously-written value. If another
     * actor has taken over the lock in the meantime, `onLockLost` is invoked and
     * no further renewals are attempted. This prevents a slow renewal from
     * accidentally extending a lock that has already been stolen.
     */
    expectedInitialValue?: unknown;
    /**
     * Invoked once when CAS detects we no longer own the lock. Only fires when
     * `expectedInitialValue` is set. Renewals stop after this callback.
     */
    onLockLost?: () => void;
}

export function createContinuousLock<DocumentType extends { _id: string | ObjectId }>(
    collection: Collection<DocumentType>,
    documentId: DocumentType['_id'],
    lockProperty: keyof DocumentType,
    lockTime: number,
    options?: CreateContinuousLockOptions,
): StopContinuousLock {
    let taskInProgress = true;
    let prolongLockTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let lastProlongPromise: Promise<unknown> = Promise.resolve(); // all errors have to be suppressed

    const casEnabled = options?.expectedInitialValue !== undefined;
    let expectedValue: unknown = options?.expectedInitialValue;
    let lockLostNotified = false;

    function scheduleLockProlong() {
        prolongLockTimeoutId = setTimeout(() => {
            prolongLockTimeoutId = null;
            lastProlongPromise = (async () => {
                try {
                    if (!taskInProgress) return;
                    const newValue = new Date(Date.now() + lockTime);
                    const filter: Filter<DocumentType> = (
                        casEnabled ? { _id: documentId, [lockProperty]: expectedValue as never } : { _id: documentId }
                    ) as Filter<DocumentType>;

                    const result = await collection.updateOne(filter, {
                        $set: { [lockProperty]: newValue },
                    } as UpdateFilter<DocumentType>);

                    if (casEnabled && result.matchedCount === 0) {
                        taskInProgress = false;
                        if (!lockLostNotified) {
                            lockLostNotified = true;
                            try {
                                options?.onLockLost?.();
                            } catch (err) {
                                onError(err as Error);
                            }
                        }
                        return;
                    }
                    expectedValue = newValue;
                } catch (err) {
                    onError(err as Error);
                } finally {
                    if (taskInProgress) {
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
