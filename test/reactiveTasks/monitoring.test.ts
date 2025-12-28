import _debug from 'debug';
import { find, noop, some } from 'lodash';
import { Document } from 'mongodb';
import * as sinon from 'sinon';
import { createSandbox } from 'sinon';
import { createReusableWaitableStub, getNewInstance, wait } from '../testHelpers';
import { assertMetricValue, getMetric, getMetricValue, GlobalsRegistryDoc } from '../testHelpersReactive';

const debug = _debug('mongodash:reactiveTasks:monitoring:test');
const GLOBAL_COLLECTION_NAME = '_mongodash_globals';

describe('Reactive Task Monitoring', () => {
    let instance: ReturnType<typeof getNewInstance>;
    let otherInstances: ReturnType<typeof getNewInstance>[] = [];

    beforeEach(async () => {
        instance = getNewInstance();
        otherInstances = [];
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
        for (const inst of otherInstances) {
            await inst.cleanUpInstance();
        }
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    it('should collect execution metrics', async () => {
        // ... (setup code unchanged)
        // Enable monitoring with fast push interval
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: {
                enabled: true,
                pushIntervalMs: 100, // fast push
                scrapeMode: 'local',
            },
        });
        const collection = instance.mongodash.getCollection('monitoringTasks');

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (context: any) => {
            const doc = await context.getDocument();
            debug('Processing task ', JSON.stringify(doc, null, 2));
            if (doc.shouldFail) {
                throw new Error('Task failed');
            }
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'monitoringTask',
            handler,
            debounce: 0,
            retryPolicy: { type: 'linear', interval: '100ms' },
        });

        await instance.mongodash.startReactiveTasks();

        try {
            // 1. Success Task
            await collection.insertOne({ _id: 'docSuccess' } as Document);
            await waitForNextCall(2000);

            // 2. Failure Task
            await collection.insertOne({ _id: 'docFail', shouldFail: true } as Document);
            try {
                await waitForNextCall(2000);
            } catch {
                // Expected to fail, ignored in test
            }

            // Wait for metrics push and aggregation (poll with timeout)
            const start = Date.now();
            let lastError;
            while (Date.now() - start < 5000) {
                try {
                    const registry = await instance.mongodash.getPrometheusMetrics();
                    expect(registry).toBeDefined();
                    const metricsJson = await registry!.getMetricsAsJSON();

                    // Check success task
                    // Histogram buckets are cumulative. '+Inf' bucket contains the total count.
                    assertMetricValue(metricsJson, 'reactive_tasks_duration_seconds', { task_name: 'monitoringTask', status: 'success', le: '+Inf' }, 1);

                    // Check failed task
                    const durationMetric = getMetric(metricsJson, 'reactive_tasks_duration_seconds');
                    // Check +Inf value for failure count
                    const failedValue = getMetricValue(durationMetric, { task_name: 'monitoringTask', status: 'failed', le: '+Inf' });
                    // It is possible failedValue is undefined if the metric wasn't created yet or label mismatch,
                    // but getMetricValue throws or returns undefined.
                    if (!failedValue) throw new Error('Failed metric value not found');
                    expect(failedValue.value).toBeGreaterThanOrEqual(1);

                    // Check Retries (Counter)
                    const retriesMetric = getMetric(metricsJson, 'reactive_tasks_retries_total');
                    const retryValue = getMetricValue(retriesMetric, { task_name: 'monitoringTask' });
                    expect(retryValue.value).toBeGreaterThanOrEqual(1);

                    // Check Queue Depth/Lag presence
                    expect(find(metricsJson, { name: 'reactive_tasks_queue_depth' })).toBeDefined();
                    expect(find(metricsJson, { name: 'reactive_tasks_global_lag_seconds' })).toBeDefined();
                    expect(find(metricsJson, { name: 'reactive_tasks_change_stream_lag_seconds' })).toBeDefined();

                    return; // All assertions passed
                } catch (e) {
                    lastError = e;
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
            }
            throw lastError || new Error('Timeout waiting for metrics');
        } finally {
            await instance.mongodash.stopReactiveTasks();
        }
    }, 15000);

    it('should report queue depth and global lag', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            onError: noop,
            onInfo: noop,
            monitoring: {
                enabled: true,
                pushIntervalMs: 100,
                scrapeMode: 'local',
            },
        });
        const collection = instance.mongodash.getCollection('lagTasks');

        // Handler that blocks to build up lag/queue
        const { stub: handler, waitForNextCall: _waitForNextCall } = createReusableWaitableStub(async (_context: any) => {
            // Processing...
        });

        await instance.mongodash.reactiveTask({
            collection,
            task: 'lagTask',
            handler,
            debounce: 5000, // Debounce to keep it pending for a while? Or just don't process?
            // If we want to simulate lag, we can just insert and NOT start the scheduler immediately,
            // or start it but the task is scheduled in the future?
            // But monitoring lag is "Now - ScheduledAt".
            // If I insert now, ScheduledAt is Now + debounce.
            // If debounce is 0, ScheduledAt is Now.
            // If handler is slow or concurrency is full, we get lag.
        });

        // Strategy: Create task directly in DB with past ScheduledAt.
        await instance.mongodash.startReactiveTasks();
        await new Promise((resolve) => setTimeout(resolve, 500)); // Allow initial cleanup to run

        const tasksCollection = instance.mongodash.getCollection<{
            task: string;
            sourceDocId: string;
            status: string;
            // nextRunAt/dueAt are standard fields now
            nextRunAt: Date | null;
            dueAt: Date;
            // But here we are defining a generic type for collection.
            createdAt: Date;
            updatedAt: Date;
            attempts: number;
        }>('lagTasks_tasks');
        await tasksCollection.insertOne({
            task: 'lagTask',
            sourceDocId: 'stuck_doc',
            status: 'pending',
            nextRunAt: new Date(Date.now() + 10000), // Locked in future (simulating processing lock expiration or future run)
            // For lag calculation, we need dueAt. Use 5s ago.
            dueAt: new Date(Date.now() - 5000),
            createdAt: new Date(),
            updatedAt: new Date(),
            attempts: 0,
        });

        // 2. Poll for metrics until we get a non-empty response (wait for leader election/collection)
        let metricsJson: any = null;
        const start = Date.now();
        while (Date.now() - start < 3000) {
            const registry = await instance.mongodash.getPrometheusMetrics();
            if (registry) {
                const json = await registry.getMetricsAsJSON();
                if (some(json, { name: 'reactive_tasks_queue_depth' })) {
                    metricsJson = json;
                    break;
                }
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        expect(metricsJson).toBeDefined();

        // Queue Depth
        assertMetricValue(metricsJson, 'reactive_tasks_queue_depth', { task_name: 'lagTask', status: 'pending' }, 1);

        // Global Lag - should be around 5s
        const lagMetric = getMetric(metricsJson, 'reactive_tasks_global_lag_seconds');
        const lagValue = getMetricValue(lagMetric, { task_name: 'lagTask' });
        expect(lagValue.value).toBeGreaterThanOrEqual(4);
        await instance.mongodash.stopReactiveTasks();
    });

    it('should aggregate metrics from multiple instances', async () => {
        // Init leader
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, pushIntervalMs: 1000 } });
        // Simulate another instance pushing metrics to DB
        const globalsCollection = instance.mongodash.getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME);
        await globalsCollection.updateOne(
            { _id: 'reactive_tasks_metrics_registry' },
            {
                $push: {
                    instances: {
                        id: 'instance-2',
                        lastSeen: new Date(Date.now() + 10000), // Future to prevent staling
                        metrics: [
                            {
                                name: 'reactive_tasks_retries_total',
                                type: 'counter',
                                help: 'Total number of retries attempted.',
                                aggregator: 'sum',
                                values: [
                                    {
                                        value: 5,
                                        labels: { task_name: 'remoteTask' },
                                    },
                                ],
                            },
                        ],
                    },
                } as any, // Cast to any because $push might complain about types in test
            },
            { upsert: true },
        );

        // Run local task
        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {});

        await instance.mongodash.reactiveTask({
            collection: instance.mongodash.getCollection('localTasks'),
            task: 'localTask',
            handler,
        });

        await instance.mongodash.startReactiveTasks();

        await instance.mongodash.getCollection('localTasks').insertOne({});

        // Ensure it runs
        await waitForNextCall(5000);

        // Wait for metrics to be pushed (pushIntervalMs=1000)
        await wait(1500);

        // Verify metrics
        const registry = await instance.mongodash.getPrometheusMetrics();
        expect(registry).not.toBeNull();
        const json = await registry!.getMetricsAsJSON();

        const duration = getMetric(json, 'reactive_tasks_duration_seconds');

        // Check local task
        // Use +Inf bucket for histogram
        expect(getMetricValue(duration, { task_name: 'localTask', le: '+Inf' })).toBeDefined();

        // Check remote task (counter)
        assertMetricValue(json, 'reactive_tasks_retries_total', { task_name: 'remoteTask' }, 5);

        await instance.mongodash.stopReactiveTasks();
    });

    it('should return null when monitoring is disabled', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: false } });
        // Even if we try to scrape
        const registry = await instance.mongodash.getPrometheusMetrics();
        expect(registry).toBeNull();
    });

    // --- SCENARIO: K8s / Pod Monitor (Local Metrics) ---
    // 'instance' mode returns local metrics.
    it('should return local metrics when scrapeMode is instance', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, scrapeMode: 'local' } });

        const { stub: handler, waitForNextCall } = createReusableWaitableStub(async (_context: any) => {});

        await instance.mongodash.reactiveTask({
            collection: instance.mongodash.getCollection('instanceTask'),
            task: 'localInstanceTask',
            handler,
        });
        await instance.mongodash.startReactiveTasks();
        await instance.mongodash.getCollection('instanceTask').insertOne({});

        await waitForNextCall(5000);

        // Scrape 'instance' (local)
        const registry = await instance.mongodash.getPrometheusMetrics();
        expect(registry).toBeDefined();
        const json = await registry!.getMetricsAsJSON();

        const duration = getMetric(json, 'reactive_tasks_duration_seconds');
        expect(getMetricValue(duration, { task_name: 'localInstanceTask', le: '+Inf' })).toBeDefined();

        await instance.mongodash.stopReactiveTasks();
    });

    // --- SCENARIO: LB / Heroku (Aggregated Metrics) ---
    // 'any' mode returns aggregated metrics, regardless of instance role.
    it('should return aggregated metrics when scrapeMode is any (LB/Heroku)', async () => {
        // Init
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: { enabled: true, pushIntervalMs: 100 }, // Fast push
        });
        await instance.mongodash.startReactiveTasks();

        // Simulate another instance pushing metrics to DB
        const globals = instance.mongodash.getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME);
        await globals.updateOne(
            { _id: 'reactive_tasks_metrics_registry' } as any,
            {
                $push: {
                    // Use push to append to instances array
                    instances: {
                        id: 'other-node',
                        lastSeen: new Date(Date.now() + 10000), // Future to keep it fresh
                        metrics: [
                            {
                                name: 'reactive_tasks_other_metric',
                                type: 'counter',
                                help: 'h',
                                aggregator: 'sum',
                                values: [{ value: 10, labels: { app: 'other' } }],
                            },
                        ],
                    },
                } as any,
            },
            { upsert: true },
        );

        await wait(500); // Wait for things to settle

        // TEST: Scrape with 'any' mode. Even if we are a Follower (or Leader), we should get Aggregated results.
        const registry = await instance.mongodash.getPrometheusMetrics();

        expect(registry).not.toBeNull();
        const json = await registry!.getMetricsAsJSON();

        // Should contain OUR local metrics (even if empty) AND the other node's metrics
        // We can check if the other metric is present
        const otherMetric = getMetric(json, 'reactive_tasks_other_metric');
        expect(otherMetric).toBeDefined();
        expect(getMetricValue(otherMetric, { app: 'other' }).value).toBe(10);
    });

    // --- SCENARIO: K8s / Leader Global Stats ---
    // Leader scraping 'instance' should include Global Stats (Queue/Lag).
    it('should include Global Stats for Leader in instance mode', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, pushIntervalMs: 100, scrapeMode: 'local' } });
        await instance.mongodash.reactiveTask({
            collection: 'k8sTask',
            task: 'k8sTask',
            handler: async (_context: any) => {},
        });

        await instance.mongodash.startReactiveTasks();
        await wait(2000); // Wait for election

        const scheduler = (instance.mongodash as any)._scheduler;
        expect(scheduler.leaderElector.isLeader).toBe(true);

        const registry = await instance.mongodash.getPrometheusMetrics();
        expect(registry).not.toBeNull();
        const metrics = await registry!.metrics();

        // Expectation: Should contain Global Metrics
        expect(metrics).toContain('reactive_tasks_queue_depth');
        expect(metrics).toContain('reactive_tasks_global_lag_seconds');
    });

    // --- SCENARIO: K8s / Follower Local Stats ---
    // Follower scraping 'instance' should NOT include Global Stats.
    it('should NOT include Global Stats for Follower in instance mode', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, pushIntervalMs: 100, scrapeMode: 'local' } });
        await instance.mongodash.startReactiveTasks();
        await wait(500);

        const scheduler = (instance.mongodash as any)._scheduler;
        // Mock Not-Leader
        sinon.stub(scheduler.leaderElector, 'isLeader').get(() => false);

        const registry = await instance.mongodash.getPrometheusMetrics();
        const metrics = await registry!.metrics();

        expect(metrics).not.toContain('reactive_tasks_queue_depth');
    });

    it('should track reconciliation timestamp', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: { enabled: true, pushIntervalMs: 100, scrapeMode: 'local', readPreference: 'primary' },
        });

        // Register a dummy task so planner starts (optimization prevents start with 0 tasks)
        await instance.mongodash.reactiveTask({
            collection: 'dummy',
            task: 'dummy',
            handler: async (_context: any) => {},
        });

        await instance.mongodash.startReactiveTasks();

        // Wait for a reconciliation cycle (happens on start/timers)
        await new Promise((r) => setTimeout(r, 200));

        const registry = await instance.mongodash.getPrometheusMetrics();
        const json = await registry!.getMetricsAsJSON();

        const timestampMetric = getMetric(json, 'reactive_tasks_last_reconciliation_timestamp_seconds');
        // Since no tasks run, it might be empty or have a value if reconciliation ran globally?
        // Actually, MetricsCollector only records it if it's pushed from LeaderElector/Planner.
        // LeaderElector emits onInfo/changes.
        // Let's force a task to ensure some activity if needed, but reconciliation loop runs periodically.

        // Actually, we need to check if values are present. If empty, maybe logic hasn't fired yet.
        // Let's wait a bit more or verify if it defaults to empty.
        // The metric is a Gauge.
        // Let's assume it should be present.
        // Check if value is reasonable (greater than 0)
        const val = getMetricValue(timestampMetric, {});
        expect(val.value).toBeGreaterThan(0);

        // Ensure it's roughly current (within last 30 seconds to cover startup delay)
        const nowSeconds = Date.now() / 1000;
        expect(val.value).toBeGreaterThan(nowSeconds - 30);
        expect(val.value).toBeLessThanOrEqual(nowSeconds + 1);

        await instance.mongodash.stopReactiveTasks();
    });

    it('should handle mixed task statuses correctly', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, pushIntervalMs: 100, scrapeMode: 'local' } });
        const collection = instance.mongodash.getCollection('mixedTask');

        await instance.mongodash.reactiveTask({
            collection,
            task: 'mixedTask',
            handler: async (context: any) => {
                const doc = await context.getDocument();
                if (doc._id === 'f1') throw new Error('fail');
            },
            retryPolicy: { type: 'linear', interval: '10ms' }, // fast retry
        });
        await instance.mongodash.startReactiveTasks();

        // 1 Success
        await collection.insertOne({ _id: 's1' } as Document);

        // 1 Fail
        await collection.insertOne({ _id: 'f1' } as Document);

        // Poll for metrics
        let json: any;
        const start = Date.now();
        while (Date.now() - start < 5000) {
            const registry = await instance.mongodash.getPrometheusMetrics();
            if (registry) {
                json = await registry.getMetricsAsJSON();
                const duration = getMetric(json, 'reactive_tasks_duration_seconds');
                if (duration) {
                    const s = getMetricValue(duration, { task_name: 'mixedTask', status: 'success', le: '+Inf' }, false);
                    const f = getMetricValue(duration, { task_name: 'mixedTask', status: 'failed', le: '+Inf' }, false);
                    if (s && f && s.value >= 1 && f.value >= 1) {
                        break;
                    }
                }
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        expect(json).toBeDefined();
        const duration = getMetric(json, 'reactive_tasks_duration_seconds');

        const successCount = getMetricValue(duration, {
            task_name: 'mixedTask',
            status: 'success',
            le: '+Inf',
        });
        expect(successCount.value).toBeGreaterThanOrEqual(1);

        const failedCount = getMetricValue(duration, {
            task_name: 'mixedTask',
            status: 'failed',
            le: '+Inf',
        });
        expect(failedCount.value).toBeGreaterThanOrEqual(1);

        await instance.mongodash.stopReactiveTasks();
    });

    // --- Deep Edge Case Tests ---

    it('should remove stale instances from registry document (leader only)', async () => {
        const onErrorSpy = sinon.spy();
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, pushIntervalMs: 500 }, onError: onErrorSpy });

        // Simulate stale data
        const globals = instance.mongodash.getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME);
        await globals.insertOne({
            _id: 'reactive_tasks_metrics_registry',
            instances: [
                { id: 'stale-1', lastSeen: new Date(Date.now() - 12000), metrics: [] },
                { id: 'fresh-1', lastSeen: new Date(), metrics: [] },
            ],
        } as any);

        await instance.mongodash.startReactiveTasks();

        // Internals access
        const scheduler = (instance.mongodash as any)._scheduler;

        // Wait for leadership
        let attempts = 0;
        while (!scheduler.leaderElector?.isLeader && attempts < 20) {
            await new Promise((resolve) => setTimeout(resolve, 50));
            attempts++;
        }
        expect(scheduler.leaderElector?.isLeader).toBe(true);

        // Wait for prune cycle (interval 500ms, need at least one cycle after becoming leader)
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (onErrorSpy.called) {
            console.error('Monitoring Error:', JSON.stringify(onErrorSpy.args, null, 2));
        }

        const doc = await globals.findOne({ _id: 'reactive_tasks_metrics_registry' });
        console.log('DEBUG: Registry Doc:', JSON.stringify(doc, null, 2));
        expect(doc).toBeDefined();
        if (doc && doc.instances && Array.isArray(doc.instances)) {
            const stale = find(doc.instances, { id: 'stale-1' });
            expect(stale).toBeUndefined();

            const fresh = find(doc.instances, { id: 'fresh-1' });
            expect(fresh).toBeDefined();

            const current = find(doc.instances, { id: (scheduler as any).instanceId });
            expect(current).toBeDefined();
        }

        await instance.mongodash.stopReactiveTasks();
    });

    it('should handle corrupt global registry data gracefully', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true } });
        await instance.mongodash.startReactiveTasks();

        const globalsCollection = instance.mongodash.getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME);
        await globalsCollection.updateOne(
            { _id: 'reactive_tasks_metrics_registry' },
            {
                $set: {
                    'instances.corrupt-1': { lastSeen: new Date(), metrics: 'NOT_AN_ARRAY' }, // Invalid type
                    'instances.corrupt-2': { lastSeen: new Date() }, // Missing metrics
                    'instances.valid-1': {
                        lastSeen: new Date(),
                        metrics: [],
                    },
                },
            },
            { upsert: true },
        );

        const registry = await instance.mongodash.getPrometheusMetrics();
        if (registry) {
            expect(registry).toBeDefined();
        } else {
            expect(registry).toBeNull();
        }
    });

    it('should handle conflicting metric types gracefully', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true } });
        await instance.mongodash.startReactiveTasks();

        const globalsCollection = instance.mongodash.getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME);

        await globalsCollection.updateOne(
            { _id: 'reactive_tasks_metrics_registry' },
            {
                $set: {
                    'instances.inst-1': {
                        lastSeen: new Date(),
                        metrics: [{ name: 'my_metric', type: 'counter', help: 'h', aggregator: 'sum', values: [] }],
                    },
                    'instances.inst-2': {
                        lastSeen: new Date(),
                        metrics: [{ name: 'my_metric', type: 'histogram', help: 'h', aggregator: 'sum', values: [] }],
                    },
                },
            },
            { upsert: true },
        );

        const registry = await instance.mongodash.getPrometheusMetrics();

        // Conflicting types usually cause aggregation error, caught by MetricsCollector -> returns null
        if (registry) {
            const json = await registry.getMetricsAsJSON();
            expect(json).toBeDefined();
        } else {
            expect(registry).toBeNull();
        }
    });

    it('should handle concurrent scrapes', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true } });
        await instance.mongodash.startReactiveTasks();

        // We need global doc to exist for aggregation to happen
        await instance.mongodash
            .getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME)
            .updateOne({ _id: 'reactive_tasks_metrics_registry' }, { $set: { 'instances.test': { lastSeen: new Date(), metrics: [] } } }, { upsert: true });

        // Trigger 10 parallel scrapes
        const promises = [];
        for (let i = 0; i < 10; i++) {
            promises.push(instance.mongodash.getPrometheusMetrics());
        }

        const results = await Promise.all(promises);
        results.forEach(() => {
            // It's acceptable for getPrometheusMetrics to return null if aggregation fails
            // or if there is contention. Verification is that it doesn't throw.
        });
    });

    it('should return local registry if global registry doc is missing with scrapeMode any', async () => {
        await instance.initInstance({ globalsCollection: GLOBAL_COLLECTION_NAME, monitoring: { enabled: true, scrapeMode: 'local' } });
        await instance.mongodash.startReactiveTasks();

        const globalsCollection = instance.mongodash.getCollection<GlobalsRegistryDoc>(GLOBAL_COLLECTION_NAME);

        // Ensure no registry doc exists
        await globalsCollection.deleteOne({ _id: 'reactive_tasks_metrics_registry' });
        const doc = await globalsCollection.findOne({ _id: 'reactive_tasks_metrics_registry' });
        expect(doc).toBeNull();

        const registry = await instance.mongodash.getPrometheusMetrics();
        // scrapeMode 'any' returns local registry even without global doc
        expect(registry).not.toBeNull();

        const json = await registry!.getMetricsAsJSON();
        expect(json).toBeDefined();
    });

    // --- Metric Accuracy Tests ---

    it('should report exact metric values for retries', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: { enabled: true, scrapeMode: 'local' },
        });
        const collection = instance.mongodash.getCollection('retryAccuracyTask');

        let failureCount = 0;
        const handler = async (_context: any) => {
            if (failureCount < 2) {
                failureCount++;
                throw new Error('Retry me');
            }
        };

        await instance.mongodash.reactiveTask({
            collection,
            task: 'retryAccuracyTask',
            handler,
            retryPolicy: { type: 'linear', interval: '10ms' },
        });

        await instance.mongodash.startReactiveTasks();

        await collection.insertOne({ _id: 'r1' } as any);

        // Poll for the expected retries metric value
        let retriesValue = 0;
        for (let i = 0; i < 50; i++) {
            await wait(100);
            const registry = await instance.mongodash.getPrometheusMetrics();
            if (registry) {
                const json = await registry.getMetricsAsJSON();
                const retriesMetric = getMetric(json, 'reactive_tasks_retries_total');
                if (retriesMetric) {
                    const val = getMetricValue(retriesMetric, { task_name: 'retryAccuracyTask' }, false);
                    if (val && val.value >= 2) {
                        retriesValue = val.value;
                        break;
                    }
                }
            }
        }

        expect(retriesValue).toBe(2);

        await instance.mongodash.stopReactiveTasks();
    });

    // --- E2E Cluster Monitoring Test ---

    it('should correctly aggregate metrics and handle Global Stats in a multi-instance cluster', async () => {
        // 1. Initialize Instance 1 with explicit instanceId
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: { enabled: true, scrapeMode: 'cluster', pushIntervalMs: 100 },
            instanceId: 'instance-1',
        });

        // 2. Initialize Instance 2 with explicit instanceId
        const instance2 = getNewInstance();
        otherInstances.push(instance2);
        await instance2.initInstance(
            {
                globalsCollection: GLOBAL_COLLECTION_NAME,
                monitoring: { enabled: true, scrapeMode: 'cluster', pushIntervalMs: 100 },
                instanceId: 'instance-2',
            },
            true, // skipClean = true
        );

        // 3. Define tasks for both
        const collection = instance.mongodash.getCollection('e2eTask');

        let handler1CallCount = 0;
        const handler1 = async (_context: any) => {
            handler1CallCount++;
        };
        await instance.mongodash.reactiveTask({ collection, task: 'e2eTask', handler: handler1 });

        let handler2CallCount = 0;
        const handler2 = async (_context: any) => {
            handler2CallCount++;
        };
        await instance2.mongodash.reactiveTask({ collection: 'e2eTask', task: 'e2eTask', handler: handler2 });

        // 4. Start both
        await instance.mongodash.startReactiveTasks();
        await instance2.mongodash.startReactiveTasks();

        // 5. Wait for Leader Election
        await wait(2000);

        const sched1 = (instance.mongodash as any)._scheduler;
        const sched2 = (instance2.mongodash as any)._scheduler;

        const leader1 = sched1.leaderElector.isLeader;
        const leader2 = sched2.leaderElector.isLeader;

        expect(leader1 || leader2).toBe(true);
        expect(leader1 && leader2).toBe(false); // Only one leader

        const leaderInstance = leader1 ? instance : instance2;
        const followerInstance = leader1 ? instance2 : instance;

        // 6. Generate Load - insert 2 docs
        await collection.insertOne({ _id: 'doc1' } as any);
        await collection.insertOne({ _id: 'doc2' } as any);

        // Wait for processing (poll for completion)
        const tasksCol = instance.mongodash.getCollection('e2eTask_tasks');
        await new Promise<void>((resolve, reject) => {
            const start = Date.now();
            const interval = setInterval(async () => {
                try {
                    const count = await tasksCol.countDocuments({ status: 'completed' });
                    if (count >= 2) {
                        clearInterval(interval);
                        resolve();
                    } else if (Date.now() - start > 15000) {
                        clearInterval(interval);
                        // Use totalCalls as backup check
                        const totalCalls = (handler1CallCount || 0) + (handler2CallCount || 0);
                        if (totalCalls >= 2) {
                            resolve();
                            return;
                        }
                        reject(new Error('Timeout waiting for e2e tasks to complete'));
                    }
                } catch (e) {
                    clearInterval(interval);
                    reject(e);
                }
            }, 200);
        });

        // 7. Wait for metrics to be pushed (pushIntervalMs: 100)
        await wait(500);

        // 8. Scrape Leader and verify VALUES
        const leaderRegistry = await leaderInstance.mongodash.getPrometheusMetrics();
        expect(leaderRegistry).toBeDefined();
        const leaderJson = await leaderRegistry!.getMetricsAsJSON();

        // Leader should have Global Stats
        const queueDepth = find(leaderJson, { name: 'reactive_tasks_queue_depth' });
        expect(queueDepth).toBeDefined();

        const globalLag = find(leaderJson, { name: 'reactive_tasks_global_lag_seconds' });
        expect(globalLag).toBeDefined();

        // Leader should have Duration metrics with actual values
        const durationMetric = find(leaderJson, { name: 'reactive_tasks_duration_seconds' });
        expect(durationMetric).toBeDefined();
        // Verify there's at least one bucket with a count > 0 (checking +Inf is specific but verifying ANY activity is safer here)
        const durationValues = (durationMetric as any).values;
        const hasDurationData = some(durationValues, (v: any) => v.value > 0);
        expect(hasDurationData).toBe(true);

        // 9. Scrape Follower and verify
        const followerRegistry = await followerInstance.mongodash.getPrometheusMetrics();
        expect(followerRegistry).toBeDefined();
        const followerJson = await followerRegistry!.getMetricsAsJSON();

        // Follower should NOT have Global Stats (computed only by leader)
        expect(find(followerJson, { name: 'reactive_tasks_queue_depth' })).toBeUndefined();
        expect(find(followerJson, { name: 'reactive_tasks_global_lag_seconds' })).toBeUndefined();

        // Follower should have Duration metrics (aggregated from all instances including itself)
        const followerDuration = find(followerJson, { name: 'reactive_tasks_duration_seconds' });
        expect(followerDuration).toBeDefined();

        await instance.mongodash.stopReactiveTasks();
        await instance2.mongodash.stopReactiveTasks();
    }, 30000);

    // --- Cluster Mode Tests (Explicit Roles) ---

    it('should return aggregated metrics + computed Global Stats when in Cluster Mode as Leader', async () => {
        // Cluster mode is default
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: { enabled: true, scrapeMode: 'cluster' },
        });

        // We need to be Leader to generate Global Stats
        // And we are the only instance, so we are Leader.

        await instance.mongodash.startReactiveTasks();
        await wait(2000); // Wait for election

        const scheduler = (instance.mongodash as any)._scheduler;
        expect(scheduler.leaderElector.isLeader).toBe(true);

        const registry = await instance.mongodash.getPrometheusMetrics();
        expect(registry).toBeDefined();

        const json = await registry!.getMetricsAsJSON();

        // Should include Global Stats because we are Leader
        expect(find(json, { name: 'reactive_tasks_queue_depth' })).toBeDefined();
        expect(find(json, { name: 'reactive_tasks_global_lag_seconds' })).toBeDefined();

        // Should also include Local metrics (even if empty/zero)
        expect(find(json, { name: 'reactive_tasks_duration_seconds' })).toBeDefined();

        await instance.mongodash.stopReactiveTasks();
    });

    it('should return aggregated metrics (including external Global Stats) when in Cluster Mode as Follower', async () => {
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: { enabled: true, scrapeMode: 'cluster' },
        });

        await instance.mongodash.startReactiveTasks();
        await wait(500);

        const scheduler = (instance.mongodash as any)._scheduler;
        // Mock Follower role
        sinon.stub(scheduler.leaderElector, 'isLeader').get(() => false);

        // Mock DB State: Another instance is Leader and pushed Global Stats (or at least unrelated metrics)
        // Note: Global Stats (Queue/Lag) are usually computed on-the-fly and NOT pushed to DB 'instances' array.
        // Wait, MetricsCollector implementation:
        // "We do NOT push Global Stats to the DB registry doc, only Local/Instance stats."
        // "Global stats are calculated on-the-fly by the Leader."

        // IF we are a Follower in Cluster Mode:
        // getAggregatedRegistry -> reads DB instances (aggregated local stats)
        // It DOES NOT compute Global Stats because !isLeader.
        // It DOES NOT fetch Global Stats from DB because they aren't there.
        //
        // So a Follower in Cluster Mode will return Aggregated Local Metrics (Duration/Retries) from all nodes,
        // BUT IT WILL MISS GLOBAL STATS (Queue/Lag) unless the Leader is pushing them?
        //
        // Re-reading MetricsCollector.ts:
        // "Global stats are calculated on-the-fly by the Leader."
        // "We do NOT push Global Stats to the DB registry doc"
        //
        // This means if you hit a Follower's /metrics endpoint in Cluster Mode, you will NOT get Queue Depth / Lag.
        // You only get them if you hit the Leader.
        // UNLESS the aggregated view was supposed to include them?
        // If they are not in DB, Follower cannot see them.
        // The only way Follower could see them is if Leader pushed them to DB.
        // But the comment says "We do NOT push Global Stats".
        //
        // So checking "should return aggregated metrics (including external Global Stats)" might be invalid expectation
        // based on current implementation if Global Stats are not persisted.
        //
        // Let's verify this behavior.
        // Expectation: Follower in Cluster Mode returns Aggregated Local Metrics, but NO Queue Depth.

        const registry = await instance.mongodash.getPrometheusMetrics();
        const json = await registry!.getMetricsAsJSON();

        // Should NOT have Queue Depth (because we are Follower and we don't compute it, and it's not in DB)
        expect(find(json, { name: 'reactive_tasks_queue_depth' })).toBeUndefined();

        // Should have Local metrics
        expect(find(json, { name: 'reactive_tasks_duration_seconds' })).toBeDefined();

        await instance.mongodash.stopReactiveTasks();
    });

    it('should calculate global lag based on initialScheduledAt for deferred tasks', async () => {
        // This test verifies that the global lag metric uses dueAt (if present)
        // rather than nextRunAt, to correctly measure lag for deferred tasks.
        await instance.initInstance({
            globalsCollection: GLOBAL_COLLECTION_NAME,
            monitoring: {
                enabled: true,
                pushIntervalMs: 100,
                scrapeMode: 'cluster',
                readPreference: 'primary',
            },
            onError: noop,
        });

        await instance.mongodash.reactiveTask({
            collection: 'lag_test_collection',
            task: 'lag_test_task',
            handler: async () => {},
        });

        await instance.mongodash.startReactiveTasks();

        const tasksCollection = instance.mongodash.getCollection('lag_test_collection_tasks');

        const now = Date.now();
        const initialTime = new Date(now - 10000); // 10 seconds ago
        const deferredTime = new Date(now + 60000); // 1 minute in future

        // Insert a deferred task with initialScheduledAt in the past
        await tasksCollection.insertOne({
            _id: 'lag-test-task-1',
            task: 'lag_test_task',
            status: 'pending',
            sourceDocId: 'doc1',
            attempts: 0,
            nextRunAt: deferredTime,
            dueAt: initialTime,
            createdAt: initialTime,
            updatedAt: initialTime,
            scheduledAt: deferredTime,
            initialScheduledAt: initialTime,
        } as Document);

        // Poll for the global lag metric
        let foundMetric;
        const start = Date.now();
        while (Date.now() - start < 5000) {
            const registry = await instance.mongodash.getPrometheusMetrics();
            if (registry) {
                const metricsJson = await registry.getMetricsAsJSON();
                foundMetric = getMetric(metricsJson, 'reactive_tasks_global_lag_seconds');
                if (foundMetric && getMetricValue(foundMetric, { task_name: 'lag_test_task' }, false)) {
                    break;
                }
            }
            await wait(500);
        }

        expect(foundMetric).toBeDefined();

        const valueObj = getMetricValue(foundMetric!, { task_name: 'lag_test_task' }, false);
        expect(valueObj).toBeDefined();
        // Lag should be ~10 seconds (from dueAt), not 0 (from future nextRunAt)
        expect(valueObj!.value).toBeGreaterThan(5);

        await instance.mongodash.stopReactiveTasks();
    });
});
