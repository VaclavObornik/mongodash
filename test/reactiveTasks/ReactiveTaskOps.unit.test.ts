import { isDuplicateKeyError, ReactiveTaskOps } from '../../src/reactiveTasks/ReactiveTaskOps';

// The shapes below mirror what MongoDB actually returns for a $merge collision
// on the planning index (verified against a live server): code 11000 plus
// keyPattern/keyValue, and an errmsg naming the index.
const PLANNING_KEY_PATTERN = { sourceDocId: 1, task: 1 };

describe('isDuplicateKeyError', () => {
    it('detects the planning-index duplicate-key race', () => {
        expect(isDuplicateKeyError({ code: 11000, keyPattern: PLANNING_KEY_PATTERN })).toBe(true);
        expect(isDuplicateKeyError({ code: 11001, keyPattern: PLANNING_KEY_PATTERN })).toBe(true);
    });

    it('detects it when wrapped in writeErrors', () => {
        expect(isDuplicateKeyError({ writeErrors: [{ code: 11000, keyPattern: PLANNING_KEY_PATTERN }] })).toBe(true);
    });

    it('falls back to the error message when no keyPattern is present', () => {
        expect(
            isDuplicateKeyError({ code: 11000, errmsg: "E11000 duplicate key error ... index: sourceDocId_1_task_1 dup key: { sourceDocId: 1, task: 't' }" }),
        ).toBe(true);
    });

    // The important guard: a violation of some OTHER unique index is a real
    // error. Swallowing it would silently drop planning and advance the resume
    // token past documents that were never written.
    it('does NOT treat an unrelated unique-index violation as benign', () => {
        expect(isDuplicateKeyError({ code: 11000, keyPattern: { email: 1 } })).toBe(false);
        expect(isDuplicateKeyError({ code: 11000, keyPattern: { _id: 1 } })).toBe(false);
        expect(isDuplicateKeyError({ writeErrors: [{ code: 11000, keyPattern: { email: 1 } }] })).toBe(false);
        expect(isDuplicateKeyError({ code: 11000, errmsg: 'E11000 duplicate key error ... index: email_1' })).toBe(false);
    });

    it('returns false for non-duplicate / missing errors', () => {
        expect(isDuplicateKeyError(null)).toBe(false);
        expect(isDuplicateKeyError(undefined)).toBe(false);
        expect(isDuplicateKeyError({ code: 26 })).toBe(false);
        expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
        expect(isDuplicateKeyError({ writeErrors: [{ code: 121 }] })).toBe(false);
    });
});

function makeEntry(aggregateImpl: () => { toArray: () => Promise<unknown[]> }) {
    const taskDef = {
        task: 't1',
        filter: {},
        watchProjection: {},
        debounceMs: 1000,
        retryStrategy: { policy: { resetRetriesOnDataChange: true } },
        tasksCollection: { collectionName: 'src_tasks' },
    };
    return {
        tasks: new Map([['t1', taskDef]]),
        tasksCollection: { collectionName: 'src_tasks' },
        sourceCollection: { aggregate: jest.fn(aggregateImpl) },
    };
}

describe('ReactiveTaskOps.executePlanningPipeline duplicate-key handling', () => {
    it('retries a duplicate-key race then reports tasks planned', async () => {
        let calls = 0;
        const entry = makeEntry(() => ({
            toArray: async () => {
                calls++;
                if (calls < 3) {
                    const err = new Error('E11000 duplicate key') as Error & { code: number; keyPattern: unknown };
                    err.code = 11000;
                    err.keyPattern = PLANNING_KEY_PATTERN;
                    throw err;
                }
                return [];
            },
        }));
        const onTaskPlanned = jest.fn();
        const ops = new ReactiveTaskOps({ getEntry: () => entry } as never, onTaskPlanned);

        await ops.executePlanningPipeline('src', [1, 2]);

        expect(calls).toBe(3); // two collisions then success
        expect(onTaskPlanned).toHaveBeenCalledTimes(1);
        expect(onTaskPlanned).toHaveBeenCalledWith('src_tasks', 1000);
    });

    it('rethrows a non-duplicate-key error', async () => {
        const entry = makeEntry(() => ({
            toArray: async () => {
                throw new Error('some other failure');
            },
        }));
        const onTaskPlanned = jest.fn();
        const ops = new ReactiveTaskOps({ getEntry: () => entry } as never, onTaskPlanned);

        await expect(ops.executePlanningPipeline('src', [1])).rejects.toThrow('some other failure');
        expect(onTaskPlanned).not.toHaveBeenCalled();
    });

    it('fails the flush after persistent duplicate-key collisions (no silent loss)', async () => {
        const entry = makeEntry(() => ({
            toArray: async () => {
                const err = new Error('E11000 duplicate key') as Error & { code: number; keyPattern: unknown };
                err.code = 11000;
                err.keyPattern = PLANNING_KEY_PATTERN;
                throw err;
            },
        }));
        const onTaskPlanned = jest.fn();
        const ops = new ReactiveTaskOps({ getEntry: () => entry } as never, onTaskPlanned);

        // Throwing keeps the caller's resume token / checkpoint where it is, so
        // the batch is replayed rather than silently skipped.
        await expect(ops.executePlanningPipeline('src', [1])).rejects.toThrow(/duplicate key after 3 attempts/);
        expect(entry.sourceCollection.aggregate).toHaveBeenCalledTimes(3); // maxAttempts
        expect(onTaskPlanned).not.toHaveBeenCalled();
    });

    it('is a no-op when the collection has no registered entry', async () => {
        const onTaskPlanned = jest.fn();
        const ops = new ReactiveTaskOps({ getEntry: () => undefined } as never, onTaskPlanned);
        await expect(ops.executePlanningPipeline('missing', [1])).resolves.toBeUndefined();
        expect(onTaskPlanned).not.toHaveBeenCalled();
    });
});
