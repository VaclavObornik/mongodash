import { processInBatches } from '../src/processInBatches';
import { Collection, Document } from 'mongodb';
import { getNewInstance, Instance } from './testHelpers';
import { noop } from 'lodash';

describe('processInBatches', () => {
    let instance: Instance;
    let collection: Collection<Document>;

    beforeAll(async () => {
        instance = getNewInstance();
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        collection = instance.mongodash.getCollection('test_process_in_batches');
    });

    afterAll(async () => {
        await instance.cleanUpInstance();
    });

    beforeEach(async () => {
        await collection.deleteMany({});
    });

    it('should process documents in batches', async () => {
        const docs = Array.from({ length: 25 }, (_, i) => ({ _id: i as any, val: i }));
        await collection.insertMany(docs);

        const processedBatches: number[][] = [];
        const result = await processInBatches(
            collection,
            [{ $sort: { val: 1 } }], // Ensure deterministic order using aggregation
            (doc) => doc.val,
            async (batch) => {
                processedBatches.push(batch);
            },
            { batchSize: 10 },
        );

        expect(processedBatches).toHaveLength(3); // 10, 10, 5
        expect(processedBatches[0]).toHaveLength(10);
        expect(processedBatches[1]).toHaveLength(10);
        expect(processedBatches[2]).toHaveLength(5);
        expect(result.processedDocuments).toBe(25);
        expect(result.operationsPerformed).toBe(25);
    });

    it('should return correct metadata', async () => {
        await collection.insertMany([{ _id: 1 as any }, { _id: 2 as any }, { _id: 3 as any }]);

        const result = await processInBatches(
            collection,
            {},
            (doc) => doc._id,
            async () => {},
            { batchSize: 2 },
        );

        expect(result.processedDocuments).toBe(3);
        expect(result.operationsPerformed).toBe(3);
    });

    it('should respect shouldStop callback', async () => {
        const docs = Array.from({ length: 10 }, (_, i) => ({ _id: i as any }));
        await collection.insertMany(docs);

        let processedCount = 0;
        const result = await processInBatches(
            collection,
            {},
            (doc) => {
                processedCount++;
                return doc._id;
            },
            async () => {},
            {
                batchSize: 1,
                shouldStop: () => processedCount >= 5,
            },
        );

        expect(processedCount).toBe(5);
        expect(result.processedDocuments).toBe(5);
    });

    it('should handle empty result from transform', async () => {
        await collection.insertMany([
            { _id: 1 as any, skip: false },
            { _id: 2 as any, skip: true },
            { _id: 3 as any, skip: false },
        ]);

        const processedItems: any[] = [];
        const result = await processInBatches(
            collection,
            [{ $sort: { _id: 1 } }],
            (doc) => (doc.skip ? null : doc._id),
            async (batch) => {
                processedItems.push(...batch);
            },
            { batchSize: 10 },
        );

        expect(processedItems).toEqual([1, 3]);
        expect(result.processedDocuments).toBe(3);
        expect(result.operationsPerformed).toBe(2);
    });

    it('should handle array result from transform', async () => {
        await collection.insertMany([
            { _id: 1 as any, vals: [1, 2] },
            { _id: 2 as any, vals: [3] },
        ]);

        const processedItems: any[] = [];
        const result = await processInBatches(
            collection,
            [{ $sort: { _id: 1 } }],
            (doc) => doc.vals,
            async (batch) => {
                processedItems.push(...batch);
            },
            { batchSize: 10 },
        );

        expect(processedItems).toEqual([1, 2, 3]);
        expect(result.processedDocuments).toBe(2);
        expect(result.operationsPerformed).toBe(3);
    });

    it('should handle empty collection', async () => {
        const result = await processInBatches(
            collection,
            {},
            (doc) => doc,
            async () => {},
        );

        expect(result.processedDocuments).toBe(0);
        expect(result.operationsPerformed).toBe(0);
    });
});
