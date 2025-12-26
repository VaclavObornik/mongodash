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
| `scrapeMode` | `'cluster' \| 'local'` | `'cluster'` | Controls which instances return metrics when scraped. <br> **'cluster'**: All instances return full aggregated metrics. Use when scraping via Load Balancer (Heroku). <br> **'local'**: Returns local metrics for THIS instance. Leader also includes Global Stats. |

### Task Execution Metrics
Track the core work being done by workers.
**Source:** Aggregated from `reactive_tasks_metrics_registry` during scrape.

| Metric Name | Type | Labels | Description | Typical Question |
| :--- | :--- | :--- | :--- | :--- |
| `reactive_tasks_duration_seconds` | Histogram | `task_name`, `status` | Distribution of task execution durations. | "How fast are we processing tasks?" |
| `reactive_tasks_retries_total` | Counter | `task_name` | Total number of retries attempted. | "Is a specific task failing frequently?" |

### Queue & Scheduler Metrics
**Source:** Computed on-demand via DB Query during scrape.

| Metric Name | Type | Labels | Description | Typical Question |
| :--- | :--- | :--- | :--- | :--- |
| `reactive_tasks_queue_depth` | Gauge | `task_name`, `status` | Count of tasks in each state (Covered Index Aggregation). | "How big is the backlog?" |
| `reactive_tasks_global_lag_seconds` | Gauge | `task_name` | Age of oldest pending task (`Now - ScheduledAt`). | "Is the system stalling?" |

### System & Infrastructure Metrics
**Source:** Computed on-demand via DB Query during scrape.

| Metric Name | Type | Labels | Description | Typical Question |
| :--- | :--- | :--- | :--- | :--- |
| `reactive_tasks_change_stream_lag_seconds` | Gauge | - | `Now - ResumeToken.ClusterTime`. | "Is the change stream reader keeping up?" |
| `reactive_tasks_last_reconciliation_timestamp_seconds` | Gauge | - | Timestamp of the last successful reconciliation. | "When did the last full reconciliation run?" |

---

## 2. Implementation Plan (Distributed)

We use a **Hybrid Metrics Pattern**:
1.  **Worker Stats**: Pushed by workers to a central Registry Document, aggregated on read.
2.  **Global Stats**: Queried directly from DB on read.

> [!NOTE]
> `prom-client` will be an **optional peerDependency**.

### Architecture: On-Demand Scrape

We expose a method `getPrometheusMetrics()` that decides whether to return metrics based on `scrapeMode`.

#### `scrapeMode` Logic
- **`'any'` (Single Instance Reporting)**:
    - Useful for Heroku / Load Balanced setups.
    - **Any instance** that receives the request will fetch the Registry and query Global Stats, returning the full set.
- **`'leader'` (Multi Instance Reporting)**:
    - Useful for K8s / Service Discovery where Prometheus scrapes *everyone*.
    - **Only the Leader** performs the aggregation and DB queries. Non-leaders return empty/null (or just app-level node metrics if configured elsewhere).
    - Prevents double-counting of the aggregated Registry data.

#### `MetricsCollector`
- **Push Loop**: Periodically pushes *local* worker stats (`duration`, `retries`) to `reactive_tasks_metrics_registry`.
- **Scrape Handler**:
    1. Check `scrapeMode` & Leadership.
    2. **Fetch Registry**: Read `reactive_tasks_metrics_registry`, prune stale instances in-memory, sum up worker stats.
    3. **Query DB**: Run `queue_depth` aggregation and `lag` queries.
    4. **Combine**: Update the Prometheus Registry and return string.

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
- Used by `MetricsCollector` to check `amILeader()` for `scrapeMode: 'leader'`.

### Proposed Changes

1.  **`package.json`**: Add `prom-client` (peerDependency).
2.  **`src/reactiveTasks/MetricsCollector.ts`**: Implement the service.
3.  **`src/reactiveTasks/ReactiveTaskWorker.ts`**: Instrument execution.
