import { isDuplicateKeyError, ReactiveTaskOps } from '../../src/reactiveTasks/ReactiveTaskOps';

describe('isDuplicateKeyError', () => {
    it('detects a direct duplicate-key error', () => {
        expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
        expect(isDuplicateKeyError({ code: 11001 })).toBe(true);
    });

    it('detects a duplicate-key error wrapped in writeErrors', () => {
        expect(isDuplicateKeyError({ writeErrors: [{ code: 11000 }] })).toBe(true);
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
                    const err = new Error('E11000 duplicate key') as Error & { code: number };
                    err.code = 11000;
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

    it('gives up (does not throw) after persistent duplicate-key collisions', async () => {
        const entry = makeEntry(() => ({
            toArray: async () => {
                const err = new Error('E11000 duplicate key') as Error & { code: number };
                err.code = 11000;
                throw err;
            },
        }));
        const onTaskPlanned = jest.fn();
        const ops = new ReactiveTaskOps({ getEntry: () => entry } as never, onTaskPlanned);

        await expect(ops.executePlanningPipeline('src', [1])).resolves.toBeUndefined();
        expect(entry.sourceCollection.aggregate).toHaveBeenCalledTimes(3); // maxAttempts
        expect(onTaskPlanned).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the collection has no registered entry', async () => {
        const onTaskPlanned = jest.fn();
        const ops = new ReactiveTaskOps({ getEntry: () => undefined } as never, onTaskPlanned);
        await expect(ops.executePlanningPipeline('missing', [1])).resolves.toBeUndefined();
        expect(onTaskPlanned).not.toHaveBeenCalled();
    });
});
