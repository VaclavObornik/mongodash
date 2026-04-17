import { noop } from 'lodash';
import { Document, MongoError } from 'mongodb';
import { createSandbox } from 'sinon';
import { createReusableWaitableStub, getNewInstance, wait } from '../testHelpers';
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
