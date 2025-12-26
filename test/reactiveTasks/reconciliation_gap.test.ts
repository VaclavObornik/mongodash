import { MongoClient } from 'mongodb';
import { init } from '../../src/index';
import { ReactiveTaskPlanner } from '../../src/reactiveTasks/ReactiveTaskPlanner';
import { ReactiveTaskRegistry } from '../../src/reactiveTasks/ReactiveTaskRegistry';
import { getConnectionString } from '../../tools/testingDatabase';

// Helper to delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ReactiveTaskPlanner - Reconciliation Gap Race Condition', () => {
    let client: MongoClient;
    let dbName: string;

    beforeAll(async () => {
        // Use a unique DB/Collection for this test
        dbName = `mongodash_test_gap_${Date.now()}`;
        client = new MongoClient(getConnectionString());
        await client.connect();

        // 0. Init Mongodash Global State
        await init({
            mongoClient: client,
            globalsCollection: client.db(dbName).collection('_mongodash_globals'),
            collectionFactory: (name) => client.db(dbName).collection(name),
            cronTaskCaller: (task) => task(),
            reactiveTaskCaller: (task) => task(),
        });
    });

    afterAll(async () => {
        if (client) {
            await client.db(dbName).dropDatabase();
            await client.close();
        }
    });

    it('should reconcile ALL documents even when inserted concurrently with startup (No Gap)', async () => {
        const db = client.db(dbName);
        const globalsColl = db.collection('_mongodash_globals');
        const sourceColl = db.collection('gap_source');
        const tasksColl = db.collection('gap_source_tasks');

        // 1. Setup Reactive Task using the main API to ensure full wiring
        // We reuse the init logic but need to capture the internal planner/scheduler if possible,
        // or just use the side effects.
        // Actually, simpler to instantiate Planner directly to control start(), but
        // initReactiveTasks wires everything up nicely. Let's try to mock the registry around Planner?
        // No, let's use the public API components manually to retain control.

        const registry = new ReactiveTaskRegistry();
        await registry.addTask({
            task: 'gap_test_task',
            filter: {},
            collection: sourceColl,
            handler: async () => {
                // simple loopback, maybe update task status?
                // The runner handles the status update regardless of logic.
            },
            cleanupPolicy: { deleteWhen: 'never' },
            evolution: {},
        } as any);

        const planner = new ReactiveTaskPlanner(
            globalsColl as any,
            'test-instance',
            registry,
            { onStreamError: () => console.error('Stream Error'), onTaskPlanned: () => {} },
            { batchSize: 100, batchIntervalMs: 50, getNextCleanupDate: () => new Date() }, // fast batching
        );

        // 2. Insert INITIAL documents (simulating pre-existing backlog)
        const initialCount = 1000; // Large enough to take some time to reconcile
        const initialDocs = Array.from({ length: initialCount }).map(() => ({ created: new Date(), type: 'initial' }));
        await sourceColl.insertMany(initialDocs);

        // 3. Prepare Concurrent Inserter
        const concurrentCount = 500;
        const insertConcurrentDocs = async () => {
            // Wait a tiny bit to hit exactly the overlap window if possible
            // But "concurrent" means "while start() is running".
            // We'll write in chunks to spread it out over the start duration.
            const chunkSize = 50;
            for (let i = 0; i < concurrentCount / chunkSize; i++) {
                const docs = Array.from({ length: chunkSize }).map(() => ({ created: new Date(), type: 'concurrent' }));
                await sourceColl.insertMany(docs);
                await delay(10); // small delay to span across the reconciliation time
            }
        };

        // 4. Start Planner AND Insert Concurrent Docs
        await Promise.all([planner.start(), insertConcurrentDocs()]);

        console.log('Planner started and inserts finished. Waiting for tasks to settle...');

        // 5. Wait for tasks to populate
        // We need to wait until tasksCount == sourceCount.
        // Give it some time.
        const totalDocs = initialCount + concurrentCount;
        let tasksCount = 0;
        let attempts = 0;
        while (attempts < 50) {
            // Wait up to 25 seconds
            tasksCount = await tasksColl.countDocuments();
            if (tasksCount >= totalDocs) break;
            await delay(500);
            attempts++;
        }

        console.log(`Final Counts - Source: ${totalDocs} | Tasks: ${tasksCount}`);

        await planner.stop();

        // 6. Assertions
        expect(tasksCount).toEqual(totalDocs);

        // Optional: Check specific gap-prone IDs?
        // If counts match, we are good.
    }, 60000); // 60s timeout
});
