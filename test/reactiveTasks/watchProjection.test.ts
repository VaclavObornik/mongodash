import _debug from 'debug';
import { noop } from 'lodash';
import { Document } from 'mongodb';
import * as sinon from 'sinon';
import { createSandbox } from 'sinon';
import { createReusableWaitableStub, getNewInstance } from '../testHelpers';

const debug = _debug('mongodash:reactiveTasks:watchedFields');

describe('reactiveTasks - watchedFields', () => {
    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);
    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should only schedule task if watched fields change', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('watchedFieldsTasks');

        const {
            stub: handler,
            waitForNextCall,
            expectNoCall,
        } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'watchedFieldsTask',
            watchProjection: { status: 1, 'nested.value': 1 },
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert document with watched fields
            await collection.insertOne({
                _id: 'doc1',
                status: 'A',
                nested: { value: 1 },
                other: 'ignore',
            } as Document);

            // Should run
            const [doc1] = await waitForNextCall(2000);
            expect(doc1.watchedValues.status).toBe('A');
            sinon.assert.calledOnce(handler);

            // 2. Update ignored field
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { other: 'changed' } });

            // Should NOT run
            await expectNoCall(500);
            sinon.assert.calledOnce(handler); // Count remains 1

            // 3. Update watched field (status)
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { status: 'B' } });

            // Should run
            const [doc2] = await waitForNextCall(2000);
            expect(doc2.watchedValues.status).toBe('B');
            sinon.assert.calledTwice(handler);

            // 4. Update watched field (nested.value)
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { 'nested.value': 2 } });

            // Should run
            const [doc3] = await waitForNextCall(2000);
            expect(doc3.watchedValues.nested.value).toBe(2);
            sinon.assert.calledThrice(handler);

            // 5. Update watched field to SAME value (idempotency check)
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { status: 'B' } });

            // Should NOT run
            await expectNoCall(500);
            sinon.assert.calledThrice(handler); // Count remains 3
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('should handle edge cases for watched fields', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('watchedFieldsEdgeCases');

        const {
            stub: handler,
            waitForNextCall,
            expectNoCall,
        } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'edgeCaseTask',
            watchProjection: { missingField: 1, nullField: 1, arrayField: 1, objectField: 1 },
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert document with missing and null fields
            await collection.insertOne({
                _id: 'doc1',
                nullField: null,
                // missingField is missing
                arrayField: [1, 2],
                objectField: { a: 1 },
            } as Document);

            // Should run
            await waitForNextCall(2000);
            sinon.assert.calledOnce(handler);

            // 2. Update missing field to undefined (effectively no change if it was missing)
            // Note: In MongoDB, setting to null is different from missing.
            // But if we extract value, missing usually becomes undefined.
            // Let's see how extractWatchedValues handles it.
            // If we set it to something, it should trigger.
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { missingField: 'nowPresent' } });
            await waitForNextCall(2000);
            sinon.assert.calledTwice(handler);

            // 3. Update null field to another value
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { nullField: 0 } });
            await waitForNextCall(2000);
            sinon.assert.calledThrice(handler);

            // 4. Update array field with same content (but new array reference)
            // MongoDB change stream might see this as a change, but our logic compares values.
            // However, $set usually triggers update.
            // Our logic: extract value -> compare with lastObservedValues.
            // [1, 2] vs [1, 2] should be equal.
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { arrayField: [1, 2] } });
            await expectNoCall(500);
            sinon.assert.calledThrice(handler);

            // 5. Update array field with different content
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { arrayField: [1, 2, 3] } });
            await waitForNextCall(2000);
            sinon.assert.callCount(handler, 4);

            // 6. Update object field with same content
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { objectField: { a: 1 } } });
            await expectNoCall(500);
            sinon.assert.callCount(handler, 4);

            // 7. Update object field with different content
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { objectField: { a: 2 } } });
            await waitForNextCall(2000);
            sinon.assert.callCount(handler, 5);

            // 8. Unset a watched field (should trigger change)
            await collection.updateOne({ _id: 'doc1' } as Document, { $unset: { objectField: '' } });
            await waitForNextCall(2000);
            sinon.assert.callCount(handler, 6);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('should handle deeply nested and mixed fields with typed interface', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });

        interface ComplexDoc extends Document {
            _id: string;
            simple: string;
            deep: {
                level1: {
                    level2: {
                        value: number;
                    };
                };
            };
            mixed: {
                array: number[];
            };
        }

        const collection = instance.mongodash.getCollection<ComplexDoc>('deepNestedTasks');

        const {
            stub: handler,
            waitForNextCall,
            expectNoCall,
        } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        // This also verifies the typing support for nested keys
        await instance.mongodash.reactiveTask<ComplexDoc>({
            collection: collection,
            task: 'deepNestedTask',
            watchProjection: { simple: 1, 'deep.level1.level2.value': 1 },
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert doc
            await collection.insertOne({
                _id: 'doc1',
                simple: 'A',
                deep: { level1: { level2: { value: 10 } } },
                mixed: { array: [1] },
                ignored: 'ignore',
            });

            // Should run
            const [doc1] = await waitForNextCall(2000);
            expect(doc1.watchedValues.simple).toBe('A');
            expect(doc1.watchedValues.deep.level1.level2.value).toBe(10);
            sinon.assert.calledOnce(handler);

            // 2. Update deep value
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { 'deep.level1.level2.value': 20 } });

            // Should run
            const [doc2] = await waitForNextCall(2000);
            expect(doc2.watchedValues.deep.level1.level2.value).toBe(20);
            sinon.assert.calledTwice(handler);

            // 3. Update simple value
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { simple: 'B' } });

            // Should run
            const [doc3] = await waitForNextCall(2000);
            expect(doc3.watchedValues.simple).toBe('B');
            sinon.assert.calledThrice(handler);

            // 4. Update ignored deep value (if we had one, but let's update 'mixed.array' which is ignored)
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { 'mixed.array': [2] } });

            // Should NOT run
            await expectNoCall(500);
            sinon.assert.calledThrice(handler);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('should NOT run task if document is updated but _id (the only watched field) did not change', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('watchedFieldsId');

        const {
            stub: handler,
            waitForNextCall,
            expectNoCall,
        } = createReusableWaitableStub(async (doc: any) => {
            debug('Processing task ', JSON.stringify(doc, null, 2));
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'watchedIdTask',
            watchProjection: { _id: 1 }, // Only watching _id
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert document
            await collection.insertOne({
                _id: 'doc1',
                status: 'A',
                value: 1,
            } as Document);

            // Should run (creation always triggers if watched fields exist, because they "changed" from missing to present)
            const [doc1] = await waitForNextCall(2000);
            expect(doc1.watchedValues._id).toBe('doc1');
            sinon.assert.calledOnce(handler);

            // 2. Update a non-watched field (status)
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { status: 'B' } });

            // Should NOT run, because _id did not change
            await expectNoCall(500);
            sinon.assert.calledOnce(handler); // Count remains 1

            // 3. Update another non-watched field (value)
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { value: 2 } });

            // Should NOT run
            await expectNoCall(500);
            sinon.assert.calledOnce(handler); // Count remains 1
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('should trigger task based on COMPUTED fields in watchProjection', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });

        const collection = instance.mongodash.getCollection('computedProjectionTasks');

        const { stub: handler, waitForNextCall } = createReusableWaitableStub();

        // Task watches the PRODUCT of price * quantity
        await instance.mongodash.reactiveTask({
            collection,
            task: 'computedTask',
            watchProjection: { total: { $multiply: ['$price', '$quantity'] } },
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert: price 10 * qty 2 = 20
            await collection.insertOne({ _id: 'order1', price: 10, quantity: 2 } as Document);
            await waitForNextCall(2000);
            sinon.assert.calledOnce(handler);

            // 2. Update price and quantity such that TOTAL remains 20 (price 5 * qty 4 = 20)
            await collection.updateOne({ _id: 'order1' } as Document, { $set: { price: 5, quantity: 4 } });

            // Should NOT trigger because computed 'total' is still 20
            // We use a small wait to ensure no call happens
            await new Promise((resolve) => setTimeout(resolve, 500));
            sinon.assert.calledOnce(handler);

            // 3. Update quantity to change total (price 5 * qty 5 = 25)
            await collection.updateOne({ _id: 'order1' } as Document, { $set: { quantity: 5 } });
            await waitForNextCall(2000);
            sinon.assert.calledTwice(handler);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('should THROW error if exclusion projection (0/false) is used', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });
        const collection = instance.mongodash.getCollection('exclusionErrorTasks');
        const { stub: handler } = createReusableWaitableStub();

        // Should throw because { field: 0 } is not supported yet
        await expect(
            instance.mongodash.reactiveTask({
                collection,
                task: 'exclusionTask',
                watchProjection: { field: 0 },
                handler,
            }),
        ).rejects.toThrow('Exclusion style projection (0) is not supported');
    });

    it('should trigger task based on COMPLEX nested and array projections ($filter, $reduce)', async () => {
        await instance.initInstance({
            onError: noop,
            onInfo: noop,
        });

        const collection = instance.mongodash.getCollection('complexProjectionTasks');
        const { stub: handler, waitForNextCall, expectNoCall } = createReusableWaitableStub();

        await instance.mongodash.reactiveTask({
            collection,
            task: 'complexTask',
            // Watch specific aggregated values:
            // 1. activeTotal: Sum of 'val' where 'active' is true
            // 2. hasHighValueItem: boolean if any item has 'val' > 50
            watchProjection: {
                activeTotal: {
                    $reduce: {
                        input: {
                            $filter: {
                                input: '$items',
                                as: 'item',
                                cond: '$$item.active',
                            },
                        },
                        initialValue: 0,
                        in: { $add: ['$$value', '$$this.val'] },
                    },
                },
                hasHighValueItem: {
                    $gt: [{ $max: '$items.val' }, 50],
                },
            },
            handler,
            debounce: 0,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Insert doc: Active Total = 10, Max Val = 20 (HighVal = false)
            await collection.insertOne({
                _id: 'doc1',
                items: [
                    { id: 1, active: true, val: 10 },
                    { id: 2, active: false, val: 20 },
                ],
            } as Document);

            await waitForNextCall(2000);
            sinon.assert.calledOnce(handler);

            // Verify the computed values in the tasks collection
            const tasksCollection = instance.mongodash.getCollection('complexProjectionTasks_tasks');
            const taskRecord1 = await tasksCollection.findOne({ task: 'complexTask', sourceDocId: 'doc1' });
            expect(taskRecord1).not.toBeNull();
            expect(taskRecord1!.lastObservedValues).toEqual({
                activeTotal: 10,
                hasHighValueItem: false,
            });

            // 2. Update INACTIVE item val: activeTotal should NOT change (10). Max Val = 25 (HighVal = false).
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { 'items.1.val': 25 } });
            await expectNoCall(500);
            sinon.assert.calledOnce(handler); // Still 1

            // 3. Update ACTIVE item val: activeTotal changes (10 -> 15).
            await collection.updateOne({ _id: 'doc1' } as Document, { $set: { 'items.0.val': 15 } });
            await waitForNextCall(2000);
            sinon.assert.calledTwice(handler);

            const taskRecord2 = await tasksCollection.findOne({ task: 'complexTask', sourceDocId: 'doc1' });
            expect(taskRecord2!.lastObservedValues).toEqual({
                activeTotal: 15,
                hasHighValueItem: false,
            });

            // 4. Add high value item (inactive): HighVal changes (false -> true). ActiveTotal same (15).
            await collection.updateOne(
                { _id: 'doc1' } as Document,
                {
                    $push: { items: { id: 3, active: false, val: 100 } },
                } as any,
            );
            await waitForNextCall(2000);
            sinon.assert.calledThrice(handler);

            const taskRecord3 = await tasksCollection.findOne({ task: 'complexTask', sourceDocId: 'doc1' });
            expect(taskRecord3!.lastObservedValues).toEqual({
                activeTotal: 15,
                hasHighValueItem: true,
            });
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    });
});
