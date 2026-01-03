import { ObjectId } from 'mongodb';
import { ReactiveTaskPlanner } from '../../src/reactiveTasks/ReactiveTaskPlanner';
import { ReactiveTaskRegistry } from '../../src/reactiveTasks/ReactiveTaskRegistry';

describe('ReactiveTaskPlanner Adaptive Batching', () => {
    let planner: ReactiveTaskPlanner;
    let registry: ReactiveTaskRegistry;
    let flushCount = 0;
    const batchIntervalMs = 200;
    const minBatchIntervalMs = 50;
    const batchSize = 1000;

    beforeEach(() => {
        flushCount = 0;
        registry = new ReactiveTaskRegistry();

        const callbacks = {
            onStreamError: jest.fn(),
            onTaskPlanned: jest.fn(),
        };

        const globalsCollection = {
            updateOne: jest.fn(),
            findOne: jest.fn(),
        } as any;

        planner = new ReactiveTaskPlanner(
            globalsCollection,
            'test-instance',
            registry,
            callbacks,
            {
                batchSize,
                batchIntervalMs,
                minBatchIntervalMs,
                getNextCleanupDate: () => new Date(),
            },
            jest.fn(),
            jest.fn(),
        );

        // Spy on flushTaskBatch to count flushes
        (planner as any).flushTaskBatch = jest.fn().mockImplementation(async () => {
            flushCount++;
            // Simulate clearing the batch like the real one does
            (planner as any).taskBatch.clear();
            (planner as any).batchFirstEventTime = null;
            if ((planner as any).batchFlushTimer) {
                clearTimeout((planner as any).batchFlushTimer);
                (planner as any).batchFlushTimer = null;
            }
        });

        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function mockChange(): any {
        return {
            _id: new ObjectId(),
            operationType: 'insert',
            ns: { db: 'test', coll: 'source' },
            documentKey: { _id: new ObjectId() },
            clusterTime: { getHighBits: () => 123 },
        };
    }

    it('should process a single event after minBatchIntervalMs', async () => {
        (planner as any).enqueueTaskChange(mockChange());

        expect(flushCount).toBe(0);

        // Advance by minBatchIntervalMs
        jest.advanceTimersByTime(minBatchIntervalMs);
        expect(flushCount).toBe(1);
    });

    it('should slide the window on subsequent events', async () => {
        (planner as any).enqueueTaskChange(mockChange()); // T=0

        jest.advanceTimersByTime(minBatchIntervalMs - 10); // T=40
        expect(flushCount).toBe(0);

        (planner as any).enqueueTaskChange(mockChange()); // T=40, Reset timer to 50ms from now

        jest.advanceTimersByTime(10); // T=50 (original timer would have fired here)
        expect(flushCount).toBe(0);

        jest.advanceTimersByTime(minBatchIntervalMs - 10); // T=90
        expect(flushCount).toBe(1);
    });

    it('should flush immediately once batchIntervalMs is reached (Max Wait)', async () => {
        (planner as any).enqueueTaskChange(mockChange()); // T=0 (First Event)

        // Send events every 40ms (less than 50ms minBatchIntervalMs)
        // This would normally keep sliding the window forever.
        for (let i = 1; i < 6; i++) {
            jest.advanceTimersByTime(40);
            (planner as any).enqueueTaskChange(mockChange());
        }
        // Total time passed: 5 * 40 = 200ms (equal to batchIntervalMs)

        expect(flushCount).toBe(1);
    });

    it('should flush immediately when batchSize is reached', async () => {
        for (let i = 0; i < batchSize; i++) {
            (planner as any).enqueueTaskChange(mockChange());
        }
        expect(flushCount).toBe(1);
    });
});
