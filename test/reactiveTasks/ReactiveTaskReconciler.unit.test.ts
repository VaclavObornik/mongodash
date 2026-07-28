import { ReactiveTaskReconciler } from '../../src/reactiveTasks/ReactiveTaskReconciler';
import { CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED } from '../../src/reactiveTasks/ReactiveTaskTypes';
import { getNewInstance, Instance } from '../testHelpers';

/**
 * Deterministic unit tests: the reconciler is instantiated directly with stub
 * dependencies, so every branch is driven by plain function calls (no change
 * streams, no timing). Only the performPeriodicCleanup block needs a real DB,
 * because it goes through the real withLock.
 */

type AnyFn = jest.Mock;

function makeEntry(aggregateImpl?: () => unknown) {
    return {
        sourceCollection: {
            collectionName: 'sourceColl',
            aggregate: jest.fn(aggregateImpl as any),
        },
        tasksCollection: { collectionName: 'tasksColl' },
        tasks: new Map([['t1', { task: 't1', filter: {} }]]),
        repository: { deleteOrphanedTasks: jest.fn() },
    };
}

function buildReconciler(options: {
    entries?: ReturnType<typeof makeEntry>[];
    findOne?: AnyFn;
    updateOne?: AnyFn;
    getNextCleanupDate?: (date?: Date) => Date;
    ReconcilerClass?: typeof ReactiveTaskReconciler;
}) {
    const findOne = options.findOne ?? jest.fn().mockResolvedValue(null);
    const updateOne = options.updateOne ?? jest.fn().mockResolvedValue({});
    const globals = { findOne, updateOne };
    const entries = options.entries ?? [];
    const registry = {
        getAllTasks: () => [],
        getAllEntries: jest.fn(() => entries),
    };
    const ops = { executePlanningPipeline: jest.fn() };
    const onInfo = jest.fn();
    const onError = jest.fn();
    const ReconcilerClass = options.ReconcilerClass ?? ReactiveTaskReconciler;
    const reconciler = new ReconcilerClass(
        'unit-instance',
        globals as any,
        registry as any,
        ops as any,
        onInfo,
        {
            batchSize: 5,
            batchIntervalMs: 10,
            minBatchIntervalMs: 10,
            getNextCleanupDate: options.getNextCleanupDate ?? ((date?: Date) => new Date((date?.getTime() ?? 0) + 1)),
        },
        onError,
    );
    return { reconciler, globals, registry, ops, onInfo, onError, findOne, updateOne };
}

const finishedEmitted = (onInfo: AnyFn) => onInfo.mock.calls.some((call) => call[0]?.code === CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED);

describe('ReactiveTaskReconciler (unit)', () => {
    describe('reconcile', () => {
        it('stops before touching a collection when shouldStop is already true', async () => {
            const entry = makeEntry();
            const { reconciler, onInfo, onError } = buildReconciler({ entries: [entry] });

            await reconciler.reconcile(() => true);

            expect(entry.sourceCollection.aggregate).not.toHaveBeenCalled();
            expect(finishedEmitted(onInfo)).toBe(false);
            expect(onError).not.toHaveBeenCalled();
        });

        it('suppresses a client-closed error when a stop was requested (shutdown race)', async () => {
            let stopRequested = false;
            const entry = makeEntry(() => {
                stopRequested = true;
                const err = new Error('client was closed');
                err.name = 'MongoClientClosedError';
                throw err;
            });
            const { reconciler, onInfo, onError, updateOne } = buildReconciler({ entries: [entry] });

            await reconciler.reconcile(() => stopRequested);

            expect(onError).not.toHaveBeenCalled();
            expect(finishedEmitted(onInfo)).toBe(false);
            expect(updateOne).not.toHaveBeenCalled();
        });

        it('surfaces a scan error via onError but still finishes the run', async () => {
            const scanError = new Error('aggregate blew up');
            const entry = makeEntry(() => {
                throw scanError;
            });
            const { reconciler, onInfo, onError } = buildReconciler({ entries: [entry] });

            await reconciler.reconcile(() => false);

            expect(onError).toHaveBeenCalledWith(scanError);
            expect(finishedEmitted(onInfo)).toBe(true);
        });

        it('surfaces a non-client-closed error even when a stop was requested', async () => {
            let stopRequested = false;
            const scanError = new Error('genuine failure');
            const entry = makeEntry(() => {
                stopRequested = true;
                throw scanError;
            });
            const { reconciler, onError } = buildReconciler({ entries: [entry] });

            await reconciler.reconcile(() => stopRequested);

            expect(onError).toHaveBeenCalledWith(scanError);
        });

        it('preserves the checkpoint when a stop arrives during batch processing', async () => {
            let stopRequested = false;
            const entry = makeEntry(() => ({
                // The cursor completes empty, but requesting a stop while it was
                // open must skip the "mark reconciled" phase entirely.
                hasNext: jest.fn(async () => {
                    stopRequested = true;
                    return false;
                }),
            }));
            const { reconciler, onInfo, onError, updateOne } = buildReconciler({ entries: [entry] });

            await reconciler.reconcile(() => stopRequested);

            expect(entry.repository.deleteOrphanedTasks).not.toHaveBeenCalled();
            expect(updateOne).not.toHaveBeenCalled();
            expect(finishedEmitted(onInfo)).toBe(false);
            expect(onError).not.toHaveBeenCalled();
        });

        it('still reports completion when the lastReconciledAt write fails (best effort)', async () => {
            const updateOne = jest.fn().mockRejectedValue(new Error('meta write failed'));
            const { reconciler, onInfo, onError } = buildReconciler({ entries: [], updateOne });

            await expect(reconciler.reconcile(() => false)).resolves.toBeUndefined();

            expect(finishedEmitted(onInfo)).toBe(true);
            expect(onError).not.toHaveBeenCalled();
        });
    });

    describe('markAsUnreconciled', () => {
        it('is a no-op for an empty task list', async () => {
            const { reconciler, updateOne } = buildReconciler({});
            await reconciler.markAsUnreconciled([]);
            expect(updateOne).not.toHaveBeenCalled();
        });

        it('unsets the reconciliation flag for each task', async () => {
            const { reconciler, updateOne } = buildReconciler({});
            await reconciler.markAsUnreconciled(['a', 'b']);
            expect(updateOne).toHaveBeenCalledWith(expect.anything(), { $unset: { 'reconciliation.a': '', 'reconciliation.b': '' } }, { upsert: true });
        });
    });

    describe('performPeriodicCleanup (uses real withLock)', () => {
        let instance: Instance;
        let ReconcilerClass: typeof ReactiveTaskReconciler;

        beforeEach(async () => {
            instance = getNewInstance();
            // Re-required after the module reset so it shares the freshly
            // initialized getMongoClient/withLock module instances.
            ReconcilerClass = require('../../src/reactiveTasks/ReactiveTaskReconciler').ReactiveTaskReconciler;
            await instance.initInstance();
        });

        afterEach(async () => {
            await instance.cleanUpInstance();
        });

        it('skips the cleanup when the fresh lastCleanupAt read under the lock says it already ran', async () => {
            const findOne = jest
                .fn()
                // Pre-lock read: never cleaned up -> proceed into the lock.
                .mockResolvedValueOnce(null)
                // Fresh read under the lock: cleaned up moments ago.
                .mockResolvedValueOnce({ lastCleanupAt: new Date() });
            const getNextCleanupDate = (date?: Date) => (date ? new Date(Date.now() + 3_600_000) : new Date(0));
            const { reconciler, registry, updateOne } = buildReconciler({ findOne, getNextCleanupDate, ReconcilerClass });

            await reconciler.performPeriodicCleanup(() => false);

            expect(registry.getAllEntries).not.toHaveBeenCalled();
            expect(updateOne).not.toHaveBeenCalled();

            // The fresh next-run time must be cached: an immediate second call
            // takes the fast path without another DB read.
            await reconciler.performPeriodicCleanup(() => false);
            expect(findOne).toHaveBeenCalledTimes(2);
        });

        it('swallows an error thrown inside the locked section (skip this run)', async () => {
            const findOne = jest.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('fresh read failed'));
            const getNextCleanupDate = () => new Date(0);
            const { reconciler, registry, updateOne } = buildReconciler({ findOne, getNextCleanupDate, ReconcilerClass });

            await expect(reconciler.performPeriodicCleanup(() => false)).resolves.toBeUndefined();

            expect(registry.getAllEntries).not.toHaveBeenCalled();
            expect(updateOne).not.toHaveBeenCalled();
        });
    });
});
