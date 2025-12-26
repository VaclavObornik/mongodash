import _debug from 'debug';
import { createSandbox } from 'sinon';
import { getNewInstance, wait } from '../testHelpers';

const debug = _debug('mongodash:reactiveTasks:stress');

describe('Reactive Tasks - Stress Test', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should handle high load of 500 tasks', async () => {
        await instance.initInstance({
            onError: (err) => console.error('Stress Test Error:', err),
            onInfo: () => {},
        });
        const collection = instance.mongodash.getCollection('stressTasks');

        let handledCount = 0;
        const processedIds = new Set<string>();

        const handler = async (doc: any) => {
            handledCount++;
            processedIds.add(doc.docId);
            // Simulate some work
            await wait(5);
        };

        const TASK_COUNT = 500;

        await instance.mongodash.reactiveTask({
            collection,
            task: 'stressTask',
            handler,
            debounce: 0,
            retryPolicy: { type: 'fixed', interval: '100ms', maxAttempts: 3 },
        });

        await instance.mongodash.startReactiveTasks();

        // 1. Bulk Insert Tasks
        debug(`Inserting ${TASK_COUNT} documents...`);
        const docs = Array.from({ length: TASK_COUNT }).map((_, i) => ({
            _id: `doc_${i}`,
            status: 'pending',
            payload: `data_${i}`,
        }));

        // Insert in batches to be realistic
        const BATCH = 100;
        for (let i = 0; i < TASK_COUNT; i += BATCH) {
            await collection.insertMany(docs.slice(i, i + BATCH) as any);
        }
        debug('Insertion complete.');

        // 2. Wait for completion
        // With concurrency=5 (default) and 5ms processing, it should take ~500ms + overhead.
        // We give it plenty of time (30s) but poll for early finish.
        const startTime = Date.now();

        while (handledCount < TASK_COUNT) {
            if (Date.now() - startTime > 30000) {
                break;
            }
            await wait(200);
        }

        const duration = Date.now() - startTime;
        debug(`Processed ${handledCount}/${TASK_COUNT} tasks in ${duration}ms`);

        // 3. Verify
        expect(handledCount).toBe(TASK_COUNT);
        expect(processedIds.size).toBe(TASK_COUNT);

        // Verify DB status (Wait for finalization)
        const tasksCollection = instance.mongodash.getCollection('stressTasks_tasks');
        let completedCount = 0;
        const dbStart = Date.now();
        while (Date.now() - dbStart < 5000) {
            completedCount = await tasksCollection.countDocuments({ status: 'completed' });
            if (completedCount === TASK_COUNT) break;
            await wait(100);
        }
        expect(completedCount).toBe(TASK_COUNT);
    }, 60000);
});
