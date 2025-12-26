import { Document } from 'mongodb';
import { ReactiveTaskRegistry } from '../../src/reactiveTasks/ReactiveTaskRegistry';
import { createReusableWaitableStub, getNewInstance, wait } from '../testHelpers';

const COLLECTION_NAME = 'test_evolution_source';
const TASK_NAME = 'test-evolution-task';
const GLOBALS_COLLECTION = '_mongodash_globals';

describe('Reactive Task - E2E Evolution Scenarios', () => {
    let instance: ReturnType<typeof getNewInstance>;

    // We keep track of instances to clean them up
    const activeInstances: ReturnType<typeof getNewInstance>[] = [];

    async function deployApp(versionLabel: string, setupFn: (api: typeof instance.mongodash) => Promise<void>, skipDbClean = true) {
        const app = getNewInstance();
        activeInstances.push(app);

        // Initialize (skipClean = true allows data persistence across "deploys")
        // We ensure we reuse the same global collection name
        await app.initInstance({ globalsCollection: GLOBALS_COLLECTION }, skipDbClean);

        await setupFn(app.mongodash);

        await app.mongodash.startReactiveTasks();

        // Wait for leader election and initial scan to stabilize
        await wait(500);

        return app;
    }

    afterEach(async () => {
        // Stop all instances
        for (const app of activeInstances) {
            await app.cleanUpInstance();
        }
        activeInstances.length = 0;

        // Just in case, try to reset singleton
        (ReactiveTaskRegistry as any).instance = null;
    });

    it('Scenario 1: Filter Evolution (System should pick up previously ignored documents)', async () => {
        // --- DEPLOY V1 ---
        // Filter: ONLY status='A'

        const { stub: handlerV1, waitForNextCall: waitForV1 } = createReusableWaitableStub();

        const appV1 = await deployApp(
            'v1',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV1,
                    filter: { status: 'A' },
                    watchProjection: { status: 1 },
                });
            },
            false,
        ); // First deploy cleans DB (skipDbClean=false)

        const sourceCol = appV1.mongodash.getCollection(COLLECTION_NAME);

        // 1. Insert Doc A (Should be processed)
        await sourceCol.insertOne({ _id: 'docA', status: 'A' } as Document);
        await waitForV1(2000);

        // 2. Insert Doc B (Should be IGNORED by v1)
        await sourceCol.insertOne({ _id: 'docB', status: 'B' } as Document);

        // Verify Doc B is NOT processed by V1
        try {
            await waitForV1(1000);
            throw new Error('Doc B should not have been processed');
        } catch (e: any) {
            // Expected timeout
            if (e.message.includes('Doc B should not have been processed')) throw e;
        }

        // --- SHUTDOWN V1 ---
        await appV1.mongodash.stopReactiveTasks();
        await appV1.cleanUpInstance();

        // --- DEPLOY V2 ---
        // Filter WIDENED: status in ['A', 'B']
        // We expect Doc B (already in DB) to be picked up by reconciliation

        const { stub: handlerV2, waitForNextCall: waitForV2 } = createReusableWaitableStub();

        await deployApp(
            'v2',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV2,
                    filter: { status: { $in: ['A', 'B'] } }, // Widened filter
                    watchProjection: { status: 1 },
                });
            },
            true,
        ); // Persist DB (skipDbClean=true)

        // Wait for Reconciliation to find docB
        // waitForNextCall returns arguments for ONE call.
        const handlerArgs = await waitForV2(5000);
        const context = handlerArgs[0];
        const processedDoc = await context.getDocument();

        // Verify Doc B was processed
        expect(processedDoc._id).toBe('docB');
    }, 30000);

    it('Scenario 2: Logic Evolution (Bug Fix & Reprocess Failed)', async () => {
        // --- DEPLOY V1 (Buggy) ---
        // This handler crashes if doc.shouldCrash needed

        const { stub: handlerV1, waitForNextCall: waitForV1 } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            if (doc.shouldCrash) throw new Error('V1 Bug');
        });

        const appV1 = await deployApp(
            'v1',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV1,
                    retryPolicy: { type: 'linear', interval: '10ms', maxAttempts: 2 }, // Fail fast
                });
            },
            false,
        ); // Clean DB

        const sourceCol = appV1.mongodash.getCollection(COLLECTION_NAME);

        // 1. Insert Buggy Doc
        await sourceCol.insertOne({ _id: 'buggyDoc', shouldCrash: true } as Document);

        // It should try and fail maxAttempts times (2 times)
        // We consume the failure calls
        try {
            await waitForV1(2000);
        } catch (e) {
            console.warn('Wait 1 timeout', e);
        }
        try {
            await waitForV1(2000);
        } catch (e) {
            console.warn('Wait 2 timeout', e);
        }

        // Verify it is permanently failed in DB (poll for update)
        const tasksCol = appV1.mongodash.getCollection(`${COLLECTION_NAME}_tasks`);
        let failedTask;
        for (let i = 0; i < 30; i++) {
            failedTask = await tasksCol.findOne({ sourceDocId: 'buggyDoc' });
            if (failedTask?.status === 'failed') break;
            await wait(100);
        }

        expect(failedTask).toBeDefined();
        // If it's still pending/retrying, attempts might be < 2 or visible timeout
        expect(failedTask?.status).toBe('failed');
        expect(failedTask?.attempts).toBeGreaterThanOrEqual(2);

        // --- SHUTDOWN V1 ---
        await appV1.mongodash.stopReactiveTasks();
        await appV1.cleanUpInstance();

        // --- DEPLOY V2 (Fixed) ---
        // We bump handlerVersion and ask to Reprocess Failed items

        const { stub: handlerV2, waitForNextCall: waitForV2 } = createReusableWaitableStub(async (_context: any) => {
            // Fixed handler (doesn't crash)
        });

        await deployApp(
            'v2',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV2,
                    evolution: {
                        handlerVersion: 2, // Bump version
                        onHandlerVersionChange: 'reprocess_failed', // Policy
                    },
                    retryPolicy: { type: 'linear', interval: '10ms', maxAttempts: 3 },
                });
            },
            true,
        ); // Persist DB

        // Verification: The failed task should be reset to pending and processed by the new handler
        const calls = await waitForV2(5000);
        const processedDoc = await calls[0].getDocument();
        expect(processedDoc._id).toBe('buggyDoc');

        // Check DB status
        const tasksColV2 = activeInstances[1].mongodash.getCollection(`${COLLECTION_NAME}_tasks`);

        // Poll for completion
        let finalTask;
        for (let i = 0; i < 30; i++) {
            finalTask = await tasksColV2.findOne({ sourceDocId: 'buggyDoc' });
            if (finalTask?.status === 'completed') break;
            await wait(100);
        }

        expect(finalTask?.status).toBe('completed');
    });

    it('Scenario 3: Logic Evolution (Reprocess All)', async () => {
        // --- DEPLOY V1 ---
        const { stub: handlerV1, waitForNextCall: waitForV1 } = createReusableWaitableStub();

        const appV1 = await deployApp(
            'v1',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV1,
                });
            },
            false,
        );

        const sourceCol = appV1.mongodash.getCollection(COLLECTION_NAME);
        await sourceCol.insertOne({ _id: 'docA', status: 'A' } as Document);

        // Wait for V1 to process
        await waitForV1(2000);

        // --- SHUTDOWN V1 ---
        await appV1.mongodash.stopReactiveTasks();
        await appV1.cleanUpInstance();

        // --- DEPLOY V2 (Reprocess All) ---
        const { stub: handlerV2, waitForNextCall: waitForV2 } = createReusableWaitableStub();

        await deployApp(
            'v2',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV2,
                    evolution: {
                        handlerVersion: 3, // Bump version
                        onHandlerVersionChange: 'reprocess_all', // Should re-run COMPLETED tasks
                    },
                });
            },
            true,
        );

        // Verification: docA should be processed again by V2
        const calls = await waitForV2(5000);
        const processedDoc = await calls[0].getDocument();
        expect(processedDoc._id).toBe('docA');
    });

    it('Scenario 4: Watch Projection Evolution', async () => {
        // --- DEPLOY V1 (Watch ONLY field 'a') ---
        const { stub: handlerV1, waitForNextCall: waitForV1 } = createReusableWaitableStub();

        const appV1 = await deployApp(
            'v1',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV1,
                    watchProjection: { a: 1 },
                });
            },
            false,
        );

        const sourceCol = appV1.mongodash.getCollection<any>(COLLECTION_NAME);

        // 1. Insert Doc: { a: 1, b: 1 } -> V1 processes it
        await sourceCol.insertOne({ _id: 'docA', a: 1, b: 1 } as Document);
        await waitForV1(2000);

        // 2. Update Doc: { a: 1, b: 2 } -> V1 should IGNORE (b is not watched)
        await sourceCol.updateOne({ _id: 'docA' }, { $set: { b: 2 } });

        try {
            await waitForV1(1000);
            throw new Error('Should have ignored change to field b');
        } catch (e: any) {
            if (e.message.includes('Should have ignored change')) throw e;
        }

        // --- SHUTDOWN V1 ---
        await appV1.mongodash.stopReactiveTasks();
        await appV1.cleanUpInstance();

        // --- DEPLOY V2 (Watch 'a' AND 'b') ---
        const { stub: handlerV2, waitForNextCall: waitForV2 } = createReusableWaitableStub();

        await deployApp(
            'v2',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV2,
                    watchProjection: { a: 1, b: 1 }, // Added 'b'
                });
            },
            true,
        );

        // Verification: Reconciliation should detect that for 'docA', the observed hash {a:1} (from V1)
        // differs from current state {a:1, b:2} under NEW projection.
        // So it should trigger processing.

        const calls = await waitForV2(5000);
        const processedDoc = await calls[0].getDocument();
        expect(processedDoc._id).toBe('docA');
        expect(processedDoc.b).toBe(2);
    });

    it('Scenario 5: Opt-out of Reconciliation', async () => {
        // --- DEPLOY V1 (Filter: status='A') ---
        const { stub: handlerV1, waitForNextCall: waitForV1 } = createReusableWaitableStub();

        const appV1 = await deployApp(
            'v1',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV1,
                    filter: { status: 'A' },
                });
            },
            false,
        );

        const sourceCol = appV1.mongodash.getCollection(COLLECTION_NAME);

        // 1. Insert docB (Ignored)
        await sourceCol.insertOne({ _id: 'docB', status: 'B' } as Document);

        // 2. Insert Marker Doc (Processed) to force Token Advance
        await sourceCol.insertOne({ _id: 'docMarker', status: 'A' } as Document);

        // Wait for Marker - this guarantees Stream has checkpointed past docB
        const markerCall = await waitForV1(2000);
        const markerDoc = await markerCall[0].getDocument();
        expect(markerDoc._id).toBe('docMarker');

        await wait(1000); // Wait for token flush to DB

        // --- SHUTDOWN V1 ---
        await appV1.mongodash.stopReactiveTasks();
        await appV1.cleanUpInstance();

        // --- DEPLOY V2 (Filter: 'A' or 'B', but NO RECONCILIATION) ---
        const { stub: handlerV2, waitForNextCall: waitForV2 } = createReusableWaitableStub();

        const appV2 = await deployApp(
            'v2',
            async (api) => {
                await api.reactiveTask({
                    task: TASK_NAME,
                    collection: COLLECTION_NAME,
                    handler: handlerV2,
                    filter: { status: { $in: ['A', 'B'] } },
                    evolution: {
                        reconcileOnTriggerChange: false, // OPT-OUT
                    },
                });
            },
            true,
        );

        // Verification 1: docB (existing) should NOT be picked up
        // Because Token > docB (so no Stream replay) AND Reconciliation is OFF.
        try {
            await waitForV2(1000); // Shorter wait, if it happens it happens fast
            throw new Error('Should not have reconciled docB');
        } catch (e: any) {
            if (e.message.includes('Should not have reconciled')) throw e;
        }

        // Verification 2: New docs should still be processed
        const sourceColV2 = appV2.mongodash.getCollection(COLLECTION_NAME);
        await sourceColV2.insertOne({ _id: 'docC', status: 'B' } as Document);
        const calls = await waitForV2(5000);
        const processedDoc = await calls[0].getDocument();
        expect(processedDoc._id).toBe('docC');
    }, 20000);

    it('Scenario 6: Validation (Should prevent startup on invalid config)', async () => {
        const app = getNewInstance();
        activeInstances.push(app);

        // Initialize
        await app.initInstance({ globalsCollection: GLOBALS_COLLECTION }, false);

        // Expect reactiveTask REJECTION (Immediate Validation)
        let registrationError: Error | undefined;

        try {
            await app.mongodash.reactiveTask({
                task: TASK_NAME,
                collection: COLLECTION_NAME,
                handler: async (_context: any) => {},
                evolution: {
                    handlerVersion: 'invalid' as any, // INTENTIONAL ERROR
                },
            });
        } catch (e: any) {
            registrationError = e;
        }

        expect(registrationError).toBeDefined();
        expect(registrationError?.message).toContain('must be a non-negative integer');
    });
});
