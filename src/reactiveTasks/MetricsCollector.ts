import type { Document } from 'mongodb';
import type { Counter, Gauge, Histogram, MetricObjectWithValues, MetricValue, Registry } from 'prom-client';
import { GlobalsCollection } from '../globalsCollection';
import { defaultOnError, OnError } from '../OnError';
import { LeaderElector } from './LeaderElector';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import { MetaDocument, ReactiveTaskSchedulerOptions, REACTIVE_TASK_META_DOC_ID, RegistryDocument } from './ReactiveTaskTypes';

// ============================================================================
// Constants
// ============================================================================

const METRIC_NAMES = {
    DURATION: 'reactive_tasks_duration_seconds',
    RETRIES: 'reactive_tasks_retries_total',
    QUEUE_DEPTH: 'reactive_tasks_queue_depth',
    GLOBAL_LAG: 'reactive_tasks_global_lag_seconds',
    CHANGE_STREAM_LAG: 'reactive_tasks_change_stream_lag_seconds',
    LAST_RECONCILIATION: 'reactive_tasks_last_reconciliation_timestamp_seconds',
    LEADER_ELECTIONS: 'reactive_tasks_leader_elections_total',
    LOCK_LOST: 'reactive_tasks_lock_lost_total',
    STREAM_ERRORS: 'reactive_tasks_stream_errors_total',
    FLUSH_FAILURES: 'reactive_tasks_flush_failures_total',
};

const REGISTRY_DOC_ID = 'reactive_tasks_metrics_registry';

/**
 * Instance entries older than this many push intervals are ignored
 * during scrape aggregation and pruned by the leader's next push.
 * Generous because an instance could be briefly unreachable but still
 * alive; its counters are cumulative anyway.
 */
const STALE_THRESHOLD_MULTIPLIER = 20;

/**
 * The leader-pushed `globalStats` blob is treated as stale sooner than
 * per-instance local metrics: it reflects a point-in-time DB query
 * (queue depth / lag) and is meaningless once the leader stops pushing.
 * With `2 * pushIntervalMs`, a single missed push (e.g. slow DB on the
 * leader) still serves the last known value; two missed pushes in a
 * row stop serving the gauge. Cluster-mode follower gauges are thus
 * bounded-stale at `GLOBAL_STATS_STALE_MULTIPLIER * pushIntervalMs`.
 */
const GLOBAL_STATS_STALE_MULTIPLIER = 2;

const DEFAULT_PUSH_INTERVAL = 60000;

/**
 * Shape returned by `Registry.getMetricsAsJSON()` and consumed by
 * `AggregatorRegistry.aggregate()`. Used for both local-instance
 * metrics pushed into `instances[].metrics` and the Leader's bundled
 * global stats stored under `globalStats.metrics`.
 */
type MetricsJson = MetricObjectWithValues<MetricValue<string>>[];

type MonitoringOptions = NonNullable<ReactiveTaskSchedulerOptions['monitoring']>;

const DEFAULT_OPTIONS: Required<Pick<MonitoringOptions, 'enabled' | 'scrapeMode' | 'readPreference' | 'pushIntervalMs'>> = {
    enabled: true,
    scrapeMode: 'cluster',
    readPreference: 'secondaryPreferred',
    pushIntervalMs: DEFAULT_PUSH_INTERVAL,
};

// ============================================================================
// MetricsCollector
// ============================================================================

/**
 * Collects and aggregates metrics for Reactive Tasks.
 *
 * Supports two scrape modes:
 * - **cluster**: Returns aggregated metrics from ALL instances (via DB registry).
 *   Use when Prometheus scrapes a single endpoint (e.g., behind a load balancer).
 * - **local**: Returns metrics from THIS instance only.
 *   Use when Prometheus scrapes each pod individually (K8s Pod Monitors).
 *
 * Global stats (queue depth, lag, change-stream lag, reconciliation timestamp)
 * are computed by the Leader. In `cluster` mode the Leader also pushes these
 * values into the registry document on each push interval so a scrape that
 * lands on a Follower still returns a complete metrics view - bounded-stale
 * at `GLOBAL_STATS_STALE_MULTIPLIER * pushIntervalMs` (2x by default,
 * i.e. a single missed push is tolerated).
 */
export class MetricsCollector {
    // Configuration
    private enabled: boolean;
    private readonly options: Required<Pick<MonitoringOptions, 'enabled' | 'scrapeMode' | 'readPreference' | 'pushIntervalMs'>>;
    private readonly instanceId: string;
    private readonly registry: ReactiveTaskRegistry;
    private readonly globalsCollection: GlobalsCollection;
    private readonly leaderElector: LeaderElector;
    private readonly onError: OnError;

    // Prom-client module (dynamically loaded for optional peer dependency)
    // Using 'any' because prom-client may not be installed. Full type: typeof import('prom-client')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private promClientModule: any;

    // Registries
    private localPromRegistry?: Registry;
    private globalStatsRegistry?: Registry;

    // Local Metrics
    private metricDuration?: Histogram;
    private metricRetries?: Counter;
    private metricLeaderElections?: Counter;
    private metricLockLost?: Counter;
    private metricStreamErrors?: Counter;
    private metricFlushFailures?: Counter;

    // State
    private pushInterval?: NodeJS.Timeout;
    private queueMetricsPromise: Promise<void> | null = null;

    // ========================================================================
    // Constructor
    // ========================================================================

    constructor(
        instanceId: string,
        registry: ReactiveTaskRegistry,
        globalsCollection: GlobalsCollection,
        leaderElector: LeaderElector,
        options: ReactiveTaskSchedulerOptions['monitoring'],
        onError: OnError = defaultOnError,
    ) {
        this.instanceId = instanceId;
        this.registry = registry;
        this.globalsCollection = globalsCollection;
        this.leaderElector = leaderElector;
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.enabled = this.options.enabled;
        this.onError = onError;

        if (this.enabled) {
            this.initPrometheus();
        }
    }

    // ========================================================================
    // Initialization
    // ========================================================================

    private initPrometheus(): void {
        try {
            this.promClientModule = require('prom-client');
        } catch {
            this.enabled = false;
            this.onError(new Error('ReactiveTasks Monitoring is enabled but "prom-client" is not installed. Monitoring disabled.'));
            return;
        }

        this.localPromRegistry = new this.promClientModule.Registry();
        this.globalStatsRegistry = new this.promClientModule.Registry();

        this.initLocalMetrics();
        this.initGlobalStatsMetrics();
    }

    private initLocalMetrics(): void {
        this.metricDuration = this.getOrCreateMetric(
            METRIC_NAMES.DURATION,
            this.promClientModule.Histogram,
            { help: 'Distribution of task execution durations.', labelNames: ['task_name', 'status'] },
            this.localPromRegistry!,
        );

        this.metricRetries = this.getOrCreateMetric(
            METRIC_NAMES.RETRIES,
            this.promClientModule.Counter,
            { help: 'Total number of retries attempted.', labelNames: ['task_name'] },
            this.localPromRegistry!,
        );

        this.metricLeaderElections = this.getOrCreateMetric(
            METRIC_NAMES.LEADER_ELECTIONS,
            this.promClientModule.Counter,
            { help: 'Number of times this instance became leader. A high rate indicates leader flapping.', labelNames: [] },
            this.localPromRegistry!,
        );

        this.metricLockLost = this.getOrCreateMetric(
            METRIC_NAMES.LOCK_LOST,
            this.promClientModule.Counter,
            {
                help: 'Number of tasks whose execution lock was stolen by another worker (CAS detection). Indicates visibility-timeout pressure or a slow worker.',
                labelNames: ['task_name'],
            },
            this.localPromRegistry!,
        );

        this.metricStreamErrors = this.getOrCreateMetric(
            METRIC_NAMES.STREAM_ERRORS,
            this.promClientModule.Counter,
            { help: 'Number of change-stream errors observed by this instance.', labelNames: [] },
            this.localPromRegistry!,
        );

        this.metricFlushFailures = this.getOrCreateMetric(
            METRIC_NAMES.FLUSH_FAILURES,
            this.promClientModule.Counter,
            { help: 'Number of planner flush batches that failed and required a stream restart.', labelNames: [] },
            this.localPromRegistry!,
        );
    }

    private initGlobalStatsMetrics(): void {
        const registry = this.globalStatsRegistry!;
        const promClient = this.promClientModule;

        // Queue Depth gauge (triggers collectQueueMetrics)
        new promClient.Gauge({
            name: METRIC_NAMES.QUEUE_DEPTH,
            help: 'Count of tasks in each state.',
            labelNames: ['task_name', 'status'],
            registers: [registry],
            collect: () => this.collectIfLeader(() => this.triggerQueueMetricsCollection()),
        });

        // Global Lag gauge (shares collection with Queue Depth via deduplication)
        new promClient.Gauge({
            name: METRIC_NAMES.GLOBAL_LAG,
            help: 'Age of oldest pending task.',
            labelNames: ['task_name'],
            registers: [registry],
            collect: () => this.collectIfLeader(() => this.triggerQueueMetricsCollection()),
        });

        // Reconciliation timestamp gauge
        const reconciliationGauge = new promClient.Gauge({
            name: METRIC_NAMES.LAST_RECONCILIATION,
            help: 'Timestamp of last successful reconciliation.',
            registers: [registry],
            collect: () => this.collectIfLeader(() => this.collectReconciliationMetrics((v) => reconciliationGauge.set(v))),
        });

        // Change Stream Lag gauge
        const changeStreamLagGauge = new promClient.Gauge({
            name: METRIC_NAMES.CHANGE_STREAM_LAG,
            help: 'Now - ResumeToken.ClusterTime.',
            registers: [registry],
            collect: () => this.collectIfLeader(() => this.collectChangeStreamLag((v) => changeStreamLagGauge.set(v))),
        });
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    public start(): void {
        if (!this.enabled || this.options.scrapeMode === 'local') return;

        this.pushInterval = setInterval(() => this.pushLocalMetrics(), this.options.pushIntervalMs);

        // Push immediately to register presence
        this.pushLocalMetrics().catch((err) => this.onError(err));
    }

    public stop(): void {
        if (this.pushInterval) {
            clearInterval(this.pushInterval);
            this.pushInterval = undefined;
        }
        // Extra safety: Clear registries to release references to Metric objects
        this.localPromRegistry?.clear();
        this.globalStatsRegistry?.clear();
    }

    // ========================================================================
    // Public API: Recording Metrics
    // ========================================================================

    public recordTaskExecution(task: string, status: 'success' | 'failed', durationMs: number): void {
        if (!this.enabled || !this.metricDuration) return;
        this.metricDuration.observe({ task_name: task, status }, durationMs / 1000);
    }

    public recordRetry(task: string): void {
        if (!this.enabled || !this.metricRetries) return;
        this.metricRetries.inc({ task_name: task });
    }

    public recordLeaderElection(): void {
        if (!this.enabled || !this.metricLeaderElections) return;
        this.metricLeaderElections.inc();
    }

    public recordLockLost(task: string): void {
        if (!this.enabled || !this.metricLockLost) return;
        this.metricLockLost.inc({ task_name: task });
    }

    public recordStreamError(): void {
        if (!this.enabled || !this.metricStreamErrors) return;
        this.metricStreamErrors.inc();
    }

    public recordFlushFailure(): void {
        if (!this.enabled || !this.metricFlushFailures) return;
        this.metricFlushFailures.inc();
    }

    // ========================================================================
    // Public API: Scraping Metrics
    // ========================================================================

    public async getPrometheusMetrics(): Promise<Registry | null> {
        if (!this.enabled || !this.promClientModule) return null;

        return this.options.scrapeMode === 'cluster' ? this.getClusterMetrics() : this.getLocalMetrics();
    }

    // ========================================================================
    // Scrape Mode Implementations
    // ========================================================================

    /**
     * Returns aggregated metrics from ALL instances.
     * Fetches other instances' metrics from DB and merges with fresh local metrics.
     * Global stats: leader computes fresh; followers read the leader's last
     * push from the registry doc (so a scrape that hits a follower still
     * returns queue depth / lag / reconciliation / stream-lag gauges).
     */
    private async getClusterMetrics(): Promise<Registry | null> {
        const allMetrics: MetricsJson[] = [];

        // 1. Fetch other instances' local metrics AND last-pushed global stats.
        const { otherInstancesMetrics, pushedGlobalStats } = await this.fetchClusterStateFromDb();
        allMetrics.push(...otherInstancesMetrics);

        // 2. Add fresh local metrics from this instance.
        const localMetrics = await this.getLocalMetricsAsJson();
        if (localMetrics) allMetrics.push(localMetrics);

        // 3. Global stats: leader uses fresh on-the-fly values; followers
        //    fall back to what the current leader last pushed.
        if (this.leaderElector.isLeader) {
            const freshGlobalStats = await this.getGlobalStatsAsJson();
            if (freshGlobalStats) allMetrics.push(freshGlobalStats);
        } else if (pushedGlobalStats) {
            allMetrics.push(pushedGlobalStats);
        }

        // 4. Aggregate all
        if (allMetrics.length === 0) return null;

        try {
            return await this.promClientModule.AggregatorRegistry.aggregate(allMetrics);
        } catch (e) {
            this.onError(e as Error);
            return null;
        }
    }

    /**
     * Returns metrics from THIS instance only.
     * Leader also includes global stats.
     */
    private async getLocalMetrics(): Promise<Registry | null> {
        const registries: Registry[] = [];

        if (this.localPromRegistry) {
            registries.push(this.localPromRegistry);
        }

        // Leader adds global stats
        if (this.leaderElector.isLeader && this.globalStatsRegistry) {
            await this.triggerGlobalStatsCollection();
            registries.push(this.globalStatsRegistry);
        }

        if (registries.length === 0) return null;
        if (registries.length === 1) return registries[0];

        return this.promClientModule.Registry.merge(registries);
    }

    // ========================================================================
    // Metrics Data Fetching
    // ========================================================================

    private async fetchClusterStateFromDb(): Promise<{ otherInstancesMetrics: MetricsJson[]; pushedGlobalStats: MetricsJson | null }> {
        try {
            const registryDoc = (await this.globalsCollection.findOne(
                { _id: REGISTRY_DOC_ID },
                { readPreference: this.options.readPreference },
            )) as RegistryDocument | null;

            if (!registryDoc) {
                return { otherInstancesMetrics: [], pushedGlobalStats: null };
            }

            const now = Date.now();
            const staleThreshold = STALE_THRESHOLD_MULTIPLIER * this.options.pushIntervalMs;

            const otherInstancesMetrics: MetricsJson[] = Array.isArray(registryDoc.instances)
                ? registryDoc.instances
                      .filter((inst) => {
                          const age = now - new Date(inst.lastSeen).getTime();
                          const isStale = age > staleThreshold;
                          const isSelf = inst.id === this.instanceId;
                          return !isStale && !isSelf && Array.isArray(inst.metrics);
                      })
                      .map((inst) => inst.metrics as MetricsJson)
                : [];

            let pushedGlobalStats: MetricsJson | null = null;
            if (registryDoc.globalStats && Array.isArray(registryDoc.globalStats.metrics)) {
                const age = now - new Date(registryDoc.globalStats.updatedAt).getTime();
                if (age <= GLOBAL_STATS_STALE_MULTIPLIER * this.options.pushIntervalMs) {
                    pushedGlobalStats = registryDoc.globalStats.metrics as MetricsJson;
                }
            }

            return { otherInstancesMetrics, pushedGlobalStats };
        } catch (e) {
            this.onError(e as Error);
            return { otherInstancesMetrics: [], pushedGlobalStats: null };
        }
    }

    private async getLocalMetricsAsJson(): Promise<MetricsJson | null> {
        if (!this.localPromRegistry) return null;

        try {
            return await this.localPromRegistry.getMetricsAsJSON();
        } catch (e) {
            this.onError(e as Error);
            return null;
        }
    }

    private async getGlobalStatsAsJson(): Promise<MetricsJson | null> {
        if (!this.leaderElector.isLeader || !this.globalStatsRegistry) return null;

        try {
            return await this.globalStatsRegistry.getMetricsAsJSON();
        } catch (e) {
            this.onError(e as Error);
            return null;
        }
    }

    private async triggerGlobalStatsCollection(): Promise<void> {
        if (!this.globalStatsRegistry) return;

        try {
            await this.globalStatsRegistry.getMetricsAsJSON();
        } catch (e) {
            this.onError(e as Error);
        }
    }

    // ========================================================================
    // Push to Global Registry (Cluster Mode)
    // ========================================================================

    private async pushLocalMetrics(): Promise<void> {
        if (!this.localPromRegistry) return;

        try {
            const localMetrics = await this.localPromRegistry.getMetricsAsJSON();
            // Leader bundles the freshly computed global stats into the
            // registry document so follower-served scrapes in cluster
            // mode return a complete metrics view. Non-leaders write
            // only their local metrics.
            const globalStatsToPush = this.leaderElector.isLeader ? await this.getGlobalStatsAsJson() : null;
            await this.publishMetricsToGlobalRegistry(localMetrics, globalStatsToPush);
        } catch (e) {
            this.onError(e as Error);
        }
    }

    private async publishMetricsToGlobalRegistry(localMetrics: MetricsJson, globalStats: MetricsJson | null): Promise<void> {
        try {
            const threshold = STALE_THRESHOLD_MULTIPLIER * this.options.pushIntervalMs;

            // Re-check leadership immediately before emitting the pipeline
            // so a transition that happened during `getGlobalStatsAsJson()`
            // doesn't let a former leader overwrite the shared globalStats
            // blob after stepping down.
            const stillLeader = this.leaderElector.isLeader;

            // Leader cleans up stale instances; followers only update self
            const keepCondition = stillLeader
                ? { $and: [{ $ne: ['$$inst.id', this.instanceId] }, { $lt: [{ $subtract: ['$$NOW', '$$inst.lastSeen'] }, threshold] }] }
                : { $ne: ['$$inst.id', this.instanceId] };

            const pipeline: Document[] = [
                {
                    $set: {
                        instances: {
                            $concatArrays: [
                                { $filter: { input: { $ifNull: ['$instances', []] }, as: 'inst', cond: keepCondition } },
                                [{ id: this.instanceId, lastSeen: '$$NOW', metrics: localMetrics }],
                            ],
                        },
                    },
                },
            ];
            if (globalStats && stillLeader) {
                pipeline.push({
                    $set: {
                        globalStats: { updatedAt: '$$NOW', leaderId: this.instanceId, metrics: globalStats },
                    },
                });
            }

            await this.globalsCollection.updateOne({ _id: REGISTRY_DOC_ID }, pipeline, { upsert: true });
        } catch (e) {
            this.onError(e as Error);
        }
    }

    // ========================================================================
    // Global Stats Collection (Leader Only)
    // ========================================================================

    private async collectIfLeader(collectFn: () => Promise<void>): Promise<void> {
        if (!this.leaderElector.isLeader) return;

        try {
            await collectFn();
        } catch (e) {
            this.onError(e as Error);
        }
    }

    /**
     * Triggers queue metrics collection with deduplication.
     * Both QUEUE_DEPTH and GLOBAL_LAG share the same aggregation query.
     */
    private async triggerQueueMetricsCollection(): Promise<void> {
        if (!this.globalStatsRegistry) return;

        if (!this.queueMetricsPromise) {
            this.queueMetricsPromise = this.collectQueueMetrics((name, labels, val) => {
                const gauge = this.globalStatsRegistry!.getSingleMetric(name) as Gauge;
                if (gauge) gauge.set(labels, val);
            }).finally(() => {
                this.queueMetricsPromise = null;
            });
        }

        await this.queueMetricsPromise;
    }

    private async collectQueueMetrics(setGauge: (name: string, labels: Record<string, string | number>, val: number) => void): Promise<void> {
        const entries = this.registry.getAllEntries();

        await Promise.all(
            entries.map(async ({ repository }) => {
                try {
                    const stats = await repository.getStatistics(
                        {},
                        {
                            readPreference: this.options.readPreference,
                            includeStatusCounts: true,
                            includeGlobalLag: true,
                            groupByTask: true,
                        },
                    );

                    for (const d of stats.statuses) {
                        // When groupByTask is true, _id is { task, status }
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const id = d._id as any;
                        setGauge(METRIC_NAMES.QUEUE_DEPTH, { task_name: id.task, status: id.status }, d.count);
                    }

                    const now = Date.now();
                    const globalLag = stats.globalLag || [];
                    for (const o of globalLag) {
                        const lagSeconds = o.minScheduledAt ? Math.max(0, (now - new Date(o.minScheduledAt).getTime()) / 1000) : 0;
                        setGauge(METRIC_NAMES.GLOBAL_LAG, { task_name: o._id }, lagSeconds);
                    }
                } catch (e) {
                    this.onError(e as Error);
                }
            }),
        );
    }

    private async collectReconciliationMetrics(setValue: (val: number) => void): Promise<void> {
        try {
            const metaDoc = (await this.globalsCollection.findOne(
                { _id: REACTIVE_TASK_META_DOC_ID },
                { readPreference: this.options.readPreference },
            )) as MetaDocument | null;

            if (metaDoc?.lastReconciledAt) {
                setValue(new Date(metaDoc.lastReconciledAt).getTime() / 1000);
            }
        } catch (e) {
            this.onError(e as Error);
        }
    }

    private async collectChangeStreamLag(setValue: (val: number) => void): Promise<void> {
        try {
            const metaDoc = (await this.globalsCollection.findOne(
                { _id: REACTIVE_TASK_META_DOC_ID },
                { readPreference: this.options.readPreference },
            )) as MetaDocument | null;

            if (metaDoc?.streamState?.lastClusterTime) {
                const lagSeconds = Math.max(0, (Date.now() - new Date(metaDoc.streamState.lastClusterTime).getTime()) / 1000);
                setValue(lagSeconds);
            }
        } catch (e) {
            this.onError(e as Error);
        }
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private getOrCreateMetric<M extends Counter | Histogram | Gauge>(
        name: string,
        MetricClass: { new (opt: Record<string, unknown>): M },
        config: Record<string, unknown>,
        registry: Registry,
    ): M {
        const existing = registry.getSingleMetric(name);
        if (existing) return existing as M;
        return new MetricClass({ name, ...config, registers: [registry] });
    }
}
