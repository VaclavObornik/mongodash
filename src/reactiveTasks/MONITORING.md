# Reactive Task Monitoring Strategy

This document consolidates the metrics definitions and the implementation plan for the Reactive Task system monitoring, adapted for distributed environments (e.g., Heroku).

## 1. Metrics Definitions (Proposal)

These metrics are designed to be exported to Prometheus and follow standard naming conventions (OpenMetrics).

### Configuration

The monitoring behavior can be customized via the `monitoring` options object passed to `ReactiveTaskScheduler`.

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `true` | Enable/disable metrics collection. |
| `pushIntervalMs` | number | `60000` (1m) | How often workers push local metrics to the global registry. |
| `registry` | `prom-client.Registry` | `undefined` | Optional custom Prometheus registry instance. |
| `scrapeMode` | `'cluster' \| 'local'` | `'cluster'` | Controls which instances return metrics when scraped. <br> **'cluster'**: All instances return full aggregated metrics incl. global stats. Use when scraping via Load Balancer (Heroku). <br> **'local'**: Returns local metrics for THIS instance. Leader also includes Global Stats. |
| `readPreference` | `ReadPreference` | `'secondaryPreferred'` | Read preference for DB queries that compute global stats and fetch the registry doc. |

### Task Execution Metrics
Track the core work being done by workers.
**Source:** Aggregated from `reactive_tasks_metrics_registry` during scrape.

| Metric Name | Type | Labels | Description | Typical Question |
| :--- | :--- | :--- | :--- | :--- |
| `reactive_tasks_duration_seconds` | Histogram | `task_name`, `status` | Distribution of task execution durations. | "How fast are we processing tasks?" |
| `reactive_tasks_retries_total` | Counter | `task_name` | Total number of retries attempted. | "Is a specific task failing frequently?" |

### Queue & Scheduler Metrics
**Source:** Computed by the Leader (on-scrape, fresh). In `cluster`
mode the Leader also bundles these values into the registry document
on each push so a scrape that lands on a Follower still returns them
(bounded staleness: up to `2 x pushIntervalMs`; one missed push is
tolerated, two in a row stop serving the gauge).

| Metric Name | Type | Labels | Description | Typical Question |
| :--- | :--- | :--- | :--- | :--- |
| `reactive_tasks_queue_depth` | Gauge | `task_name`, `status` | Count of tasks in each state (Covered Index Aggregation). | "How big is the backlog?" |
| `reactive_tasks_global_lag_seconds` | Gauge | `task_name` | Age of oldest pending task (`Now - ScheduledAt`). | "Is the system stalling?" |

### System & Infrastructure Metrics
**Source:** Same as Queue & Scheduler Metrics - fresh on the Leader,
bounded-stale on Followers via the registry doc push.

| Metric Name | Type | Labels | Description | Typical Question |
| :--- | :--- | :--- | :--- | :--- |
| `reactive_tasks_change_stream_lag_seconds` | Gauge | - | `Now - ResumeToken.ClusterTime`. | "Is the change stream reader keeping up?" |
| `reactive_tasks_last_reconciliation_timestamp_seconds` | Gauge | - | Timestamp of the last successful reconciliation. | "When did the last full reconciliation run?" |

---

## 2. Implementation Plan (Distributed)

We use a **Hybrid Metrics Pattern**:
1.  **Worker Stats**: Pushed by every instance to a central Registry Document, aggregated on read.
2.  **Global Stats**:
    - On the Leader: queried directly from DB on read (fresh values).
    - Also periodically pushed to a dedicated `globalStats` field on the
      same Registry Document, so a Follower served scrape in `cluster`
      mode can return a complete metrics view without doing the DB work
      itself. The field is a singleton (one writer at a time - the
      current Leader), preventing double-counting across leader
      transitions.

> [!NOTE]
> `prom-client` will be an **optional peerDependency**.

### Architecture: On-Demand Scrape

We expose a method `getPrometheusMetrics()` that decides whether to return metrics based on `scrapeMode`.

#### `scrapeMode` Logic
- **`'cluster'` (default)**:
    - Useful for Heroku / Load Balanced setups.
    - **Any instance** that receives the request returns the full set:
      per-instance stats merged from the Registry Document + global
      stats (fresh on the Leader, last-pushed on Followers).
- **`'local'`**:
    - Useful for K8s / Service Discovery where Prometheus scrapes *everyone*.
    - Each instance returns only its own per-instance stats. The Leader
      additionally includes the fresh Global Stats, so those are
      reported exactly once in the cluster.
    - No double-counting - followers only ever emit their own locals.

#### `MetricsCollector`
- **Push Loop** (every `pushIntervalMs`):
    - Every instance pushes its own local registry metrics into the
      `instances[]` array of `reactive_tasks_metrics_registry`.
    - The Leader additionally pushes fresh global stats into the
      `globalStats` field of the same document.
- **Scrape Handler** (cluster mode):
    1. Read `reactive_tasks_metrics_registry` once; prune stale
       instances in-memory (sum up worker stats).
    2. Include this instance's own fresh local metrics.
    3. Include global stats: the Leader runs the DB queries on the
       spot for freshest values; Followers fall back to the
       `globalStats` field from step 1 (pruned if stale).
    4. Aggregate everything via `AggregatorRegistry.aggregate`.

### Pruning Strategy
- Stale instances in `reactive_tasks_metrics_registry` are filtered out **during the scrape aggregation** (`lastSeen < Now - threshold`).
- Leader periodically performs a physical cleanup (`$pull`) on the registry document to keep it small.

### Protocol details

**Heartbeat Update (Pipeline):**
```javascript
db.globals.updateOne(
  { _id: "reactive_tasks_metrics_registry" },
  [ { $set: { [`instances.${myId}`]: { lastSeen: "$$NOW", metrics: myMetrics } } } ],
  { upsert: true }
)
```

### Integration Points

#### `ReactiveTaskWorker`
- Reports execution stats to `MetricsCollector` (in-memory).

#### `ReactiveTaskPlanner` (Leader)
- No longer responsible for pushing metrics.
- Focuses on scheduling.

#### `LeaderElector`
- Used by `MetricsCollector` to check `isLeader` in both scrape modes:
  in `local` the leader adds fresh global stats to its own scrape; in
  `cluster` only the leader's push writes the `globalStats` field, and
  on scrape only the leader uses the fresh on-the-fly values
  (followers read what the current leader pushed).

### Proposed Changes

1.  **`package.json`**: Add `prom-client` (peerDependency).
2.  **`src/reactiveTasks/MetricsCollector.ts`**: Implement the service.
3.  **`src/reactiveTasks/ReactiveTaskWorker.ts`**: Instrument execution.
