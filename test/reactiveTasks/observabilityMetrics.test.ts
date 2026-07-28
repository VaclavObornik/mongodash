import { noop } from 'lodash';
import { Document, MongoError } from 'mongodb';
import { createSandbox } from 'sinon';
import { createReusableWaitableStub, getNewInstance, wait, waitUntil } from '../testHelpers';
import { getMetric, getMetricValue } from '../testHelpersReactive';

const GLOBAL_COLLECTION_NAME = '_mongodash_globals';

async function waitUntilLeader(scheduler: any, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (scheduler.leaderElector?.isLeader) return;
        await wait(50);
    }
    throw new Error('Timeout waiting for leader election');
}

/**
 * Iter 3: Integration coverage for the four event counters added in iter 4.
 *
 * Each test exercises a specific recording path end-to-end:
 *   leader_elections_total   – onBecomeLeader fires on startup
 *   stream_errors_total      – change-stream 'error' event is emitted
 *   flush_failures_total     – batch planning throws and flushTaskBatch catches it
 *   lock_lost_total          – CAS renewal detects nextRunAt was changed by another actor
 */
describe('Reactive Task Observability Metrics', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('leader_elections_total increments when this instance becomes leader', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: { enabled: true, scrapeMode: 'local' },
        });

        await instance.mongodash.startReactiveTasks();
        const scheduler = (instance.mongodash as any)._scheduler;

        try {
            await waitUntilLeader(scheduler);

            const registry = await instance.mongodash.getPrometheusMetrics();
            expect(registry).not.toBeNull();
            const json = await registry!.getMetricsAsJSON();

            const metric = getMetric(json, 'reactive_tasks_leader_elections_total');
            expect(getMetricValue(metric, {}).value).toBeGreaterThanOrEqual(1);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('stream_errors_total increments when the change stream emits an error', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: { enabled: true, scrapeMode: 'local' },
        });

        const collection = instance.mongodash.getCollection('streamErrObsTask');
        await instance.mongodash.reactiveTask({
            collection,
            task: 'streamErrObsTask',
            handler: async () => {},
        });

        await instance.mongodash.startReactiveTasks();
        const scheduler = (instance.mongodash as any)._scheduler;

        try {
            await waitUntilLeader(scheduler);
            await wait(300); // Let planner start and change stream attach

            const planner = scheduler.taskPlannerInstance;
            expect(planner).toBeDefined();
            const stream = (planner as any).changeStream;
            expect(stream).not.toBeNull();

            stream.emit('error', new MongoError('Simulated stream error'));
            await wait(300);

            const registry = await instance.mongodash.getPrometheusMetrics();
            expect(registry).not.toBeNull();
            const json = await registry!.getMetricsAsJSON();

            const metric = getMetric(json, 'reactive_tasks_stream_errors_total');
            expect(getMetricValue(metric, {}).value).toBeGreaterThanOrEqual(1);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('flush_failures_total increments when executePlanningPipeline throws during a batch flush', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: { enabled: true, scrapeMode: 'local' },
        });

        const collection = instance.mongodash.getCollection('flushFailObsTask');
        await instance.mongodash.reactiveTask({
            collection,
            task: 'flushFailObsTask',
            handler: async () => {},
        });

        await instance.mongodash.startReactiveTasks();
        const scheduler = (instance.mongodash as any)._scheduler;

        try {
            await waitUntilLeader(scheduler);
            await wait(200);

            const planner = scheduler.taskPlannerInstance;
            expect(planner).toBeDefined();
            const ops = (planner as any).ops;

            // Fail the first planning call only; subsequent calls pass through so
            // the planner can recover after the forced stream restart.
            const origExecute: (...args: unknown[]) => Promise<unknown> = ops.executePlanningPipeline.bind(ops);
            let hasFailed = false;
            sandbox.stub(ops, 'executePlanningPipeline').callsFake(async (...args: unknown[]) => {
                if (!hasFailed) {
                    hasFailed = true;
                    throw new Error('Simulated flush failure');
                }
                return origExecute(...args);
            });

            // Insert a document so a change event arrives and triggers a batch flush
            await collection.insertOne({ _id: 'flush-fail-trigger' } as Document);
            await wait(800); // Allow batch flush timer + async failure path

            const registry = await instance.mongodash.getPrometheusMetrics();
            expect(registry).not.toBeNull();
            const json = await registry!.getMetricsAsJSON();

            const metric = getMetric(json, 'reactive_tasks_flush_failures_total');
            expect(getMetricValue(metric, {}).value).toBeGreaterThanOrEqual(1);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('queue-gauge refresh is scoped per collection - one collection cannot erase another collection series', async () => {
        // collectQueueMetrics clears a collection's series only AFTER its stats
        // query succeeded. A global clear (the bug this pins) would erase the
        // series of a collection whose refresh failed or did not run.
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: { enabled: true, scrapeMode: 'local' },
        });

        const colA = instance.mongodash.getCollection('queueGaugeColA');
        const colB = instance.mongodash.getCollection('queueGaugeColB');
        await instance.mongodash.reactiveTask({ collection: colA, task: 'queueGaugeTaskA', handler: async () => {} });
        await instance.mongodash.reactiveTask({ collection: colB, task: 'queueGaugeTaskB', handler: async () => {} });

        await instance.mongodash.startReactiveTasks();
        const scheduler = (instance.mongodash as any)._scheduler;

        try {
            await waitUntilLeader(scheduler);

            await colA.insertOne({ _id: 'a1' } as Document);
            await colB.insertOne({ _id: 'b1' } as Document);

            // Both task records must exist before the stats query can emit rows.
            const tasksA = instance.mongodash.getCollection('queueGaugeColA_tasks');
            const tasksB = instance.mongodash.getCollection('queueGaugeColB_tasks');
            await waitUntil(async () => (await tasksA.countDocuments()) >= 1 && (await tasksB.countDocuments()) >= 1, { timeoutMs: 10000 });

            const scrapeQueueDepth = async () => {
                const registry = await instance.mongodash.getPrometheusMetrics();
                expect(registry).not.toBeNull();
                const json = await registry!.getMetricsAsJSON();
                return getMetric(json, 'reactive_tasks_queue_depth');
            };

            // Baseline scrape: both collections' series are present.
            await waitUntil(
                async () => {
                    const metric = await scrapeQueueDepth();
                    return (
                        getMetricValue(metric, { task_name: 'queueGaugeTaskA' }, false) !== undefined &&
                        getMetricValue(metric, { task_name: 'queueGaugeTaskB' }, false) !== undefined
                    );
                },
                { timeoutMs: 10000, message: 'both queue_depth series should appear' },
            );

            // Make collection B's stats refresh fail from now on.
            const entries = scheduler.getRegistry().getAllEntries();
            const entryB = entries.find((e: any) => e.tasksCollection.collectionName === 'queueGaugeColB_tasks');
            expect(entryB).toBeDefined();
            sandbox.stub(entryB.repository, 'getStatistics').rejects(new Error('Simulated stats failure'));

            // A's refresh succeeds and rewrites A; B's failure must leave B's
            // previous (stale) series in place instead of erasing it.
            const metric = await scrapeQueueDepth();
            expect(getMetricValue(metric, { task_name: 'queueGaugeTaskA' }, false)).toBeDefined();
            expect(getMetricValue(metric, { task_name: 'queueGaugeTaskB' }, false)).toBeDefined();
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 30000);

    it('lock_lost_total{task_name} increments when CAS renewal detects the visibility lock was stolen', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: { enabled: true, scrapeMode: 'local' },
            // Short timeout: renewal fires at visibilityTimeoutMs / 5 = 60 ms.
            // Handler runs for 700 ms, giving plenty of time for the CAS to detect the steal.
            visibilityTimeoutMs: 300,
        });

        let taskStartedResolve: () => void = noop;
        const taskStartedPromise = new Promise<void>((r) => {
            taskStartedResolve = r;
        });

        const { stub: handler } = createReusableWaitableStub(async (_context: any) => {
            taskStartedResolve();
            await wait(700);
        });

        const collection = instance.mongodash.getCollection('lockLostObsTask');
        await instance.mongodash.reactiveTask({
            collection,
            task: 'lockLostObsTask',
            handler,
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // Trigger task creation
            await collection.insertOne({ _id: 'lock-lost-trigger' } as Document);

            // Wait for the handler to begin executing
            await taskStartedPromise;

            // Overwrite nextRunAt in the tasks document so the CAS renewal
            // (which fires at ~60 ms) sees a value different from the one it wrote
            // and fires onLockLost.
            const tasksCol = instance.mongodash.getCollection('lockLostObsTask_tasks');
            await tasksCol.updateOne({ sourceDocId: 'lock-lost-trigger' }, { $set: { nextRunAt: new Date(Date.now() + 99999) } });

            // Give the renewal timer time to fire and detect the mismatch
            await wait(500);

            const registry = await instance.mongodash.getPrometheusMetrics();
            expect(registry).not.toBeNull();
            const json = await registry!.getMetricsAsJSON();

            const metric = getMetric(json, 'reactive_tasks_lock_lost_total');
            expect(getMetricValue(metric, { task_name: 'lockLostObsTask' }).value).toBeGreaterThanOrEqual(1);
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 20000);
});
