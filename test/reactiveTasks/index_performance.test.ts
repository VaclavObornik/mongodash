import { getNewInstance } from '../testHelpers';

describe('ReactiveTask Index Performance', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeAll(async () => {
        instance = getNewInstance();
        await instance.initInstance({ monitoring: { enabled: false } });
    });

    afterAll(async () => {
        await instance.cleanUpInstance();
    });

    it('should verify Optimized Partial Index performance', async () => {
        // New Index: { task: 1, nextRunAt: 1 } with partialFilterExpression: { nextRunAt: { $ne: null } }
        // Query: { task: '...', nextRunAt: { $lte: now } }

        await runBenchmark(
            'New Partial Index',
            {
                task: 1,
                nextRunAt: 1,
            },
            'perf_new',
            { nextRunAt: { $type: 'date' } },
        );

        // We expect this to be extremely fast and use the index for sorting.
        // Since we cannot easily compare with "Old Code" (as it's gone),
        // we just verify that the new approach is optimal (no SORT stage, low keys examined).
    });

    async function runBenchmark(title: string, indexDef: any, collectionName: string, partialFilter?: any) {
        console.log(`\n=== Benchmark: ${title} ===`);
        console.log('Index:', JSON.stringify(indexDef));

        const perfCollection = instance.mongodash.getCollection(collectionName);
        if (partialFilter) {
            await perfCollection.createIndex(indexDef, { partialFilterExpression: partialFilter });
        } else {
            await perfCollection.createIndex(indexDef);
        }

        const taskName = 'perf-task';
        const now = new Date();

        // 1. Populate Data
        const docs: any[] = [];
        // 9,000 completed (nextRunAt: null) - Should be excluded from index
        for (let i = 0; i < 9000; i++) {
            docs.push({
                task: taskName,
                status: 'completed',
                nextRunAt: null,
                dueAt: new Date(now.getTime() - 100000),
            });
        }
        // 900 pending future (nextRunAt: future)
        for (let i = 0; i < 900; i++) {
            docs.push({
                task: taskName,
                status: 'pending',
                nextRunAt: new Date(now.getTime() + 100000 + i),
                dueAt: new Date(now.getTime() + 100000 + i),
            });
        }
        // 100 pending ready NOW (nextRunAt: past)
        for (let i = 0; i < 100; i++) {
            docs.push({
                task: taskName,
                status: 'pending',
                nextRunAt: new Date(now.getTime() - 1000 + i),
                dueAt: new Date(now.getTime() - 1000 + i),
            });
        }
        await perfCollection.insertMany(docs);

        // 2. Query (New Simple Query)
        const filter = {
            task: { $in: [taskName] },
            nextRunAt: { $lte: now, $type: 'date' },
        };

        const explanation: any = await perfCollection
            .find(filter, {
                sort: { nextRunAt: 1 },
                limit: 1,
            })
            .explain('executionStats');

        const stats = explanation.executionStats;
        const totalKeysExamined = stats.totalKeysExamined;
        const totalDocsExamined = stats.totalDocsExamined;
        const nReturned = stats.nReturned;
        const hasSortStage = JSON.stringify(explanation.queryPlanner).includes('"stage":"SORT"');

        console.log(`Results for ${title}:`, {
            totalKeysExamined,
            totalDocsExamined,
            nReturned,
            executionTimeMillis: stats.executionTimeMillis,
            hasBlockingSort: hasSortStage,
        });

        // Assertions for Optimality
        // 1. Should NOT have blocking sort
        expect(hasSortStage).toBe(false);

        // 2. Should only examine keys that match the query (approx 100 ready tasks + scanned range)
        // With partial index, it should not even look at the 9000 nulls.
        // It might scan a bit more than nReturned if it scans into the future tasks, but it should be low.
        // Actually, since we sort by nextRunAt, it should find the first one immediately.
        // totalKeysExamined should be very close to 1 if we limit 1.
        expect(totalKeysExamined).toBeLessThan(50);

        return { totalKeysExamined, totalDocsExamined, hasSortStage };
    }
});
