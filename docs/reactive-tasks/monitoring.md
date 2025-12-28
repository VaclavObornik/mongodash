# Monitoring

Mongodash provides built-in Prometheus metrics to monitor your reactive tasks.

> [!NOTE]
> **Dependency Required**: You must install `prom-client` yourself to use this feature. It is an optional peer dependency.
> ```bash
> npm install prom-client
> ```

## Configuration

Monitoring is configured in the initialization options under the `monitoring` key:

```typescript
await mongodash.init({
    // ...
    monitoring: {
        enabled: true,           // Default: true
        scrapeMode: 'cluster',   // 'cluster' (default) or 'local'
        pushIntervalMs: 60000,   // How often instances synchronize metrics (default: 1m). Relevant only if scrapeMode is 'cluster'.
        readPreference: 'secondaryPreferred' // 'primary', 'secondaryPreferred' etc.
    }
});
```

- **scrapeMode**:
    - `'cluster'` (Default): Returns aggregated system-wide metrics. Any instance can respond to this request (by fetching state from the DB). It aggregates metrics from all other active instances. (Recommended for Load Balancers / Heroku)
    - `'local'`: Returns local metrics for THIS instance. If this instance is the Leader, it ALSO includes Global System Metrics (Queue Depth, Lag) so they are reported exactly once in the cluster. (Recommended for K8s Pod Monitors)

## Retrieving Metrics

Expose the metrics endpoint (e.g., in Express):

```typescript
import { getPrometheusMetrics } from 'mongodash';

app.get('/metrics', async (req, res) => {
    const registry = await getPrometheusMetrics();
    
    if (registry) {
        res.set('Content-Type', registry.contentType);
        return res.end(await registry.metrics());
    }
    
    res.status(503).send('Monitoring disabled');
});
```

## Available Metrics

The system exposes the following metrics with standardized labels:

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `reactive_tasks_duration_seconds` | Histogram | `task_name`, `status` | Distribution of task processing time (success/failure). |
| `reactive_tasks_retries_total` | Counter | `task_name` | Total number of retries attempted. |
| `reactive_tasks_queue_depth` | Gauge | `task_name`, `status` | Current number of tasks in the queue, grouped by status (`pending`, `processing`, `processing_dirty`, `failed`). |
| `reactive_tasks_global_lag_seconds` | Gauge | `task_name` | Age of the oldest `pending` task, measured from `dueAt`. This ensures deferred tasks still reflect their true waiting time. |
| `reactive_tasks_change_stream_lag_seconds` | Gauge | *none* | Time difference between now and the last processed Change Stream event. |
| `reactive_tasks_last_reconciliation_timestamp_seconds` | Gauge | *none* | Timestamp when the last full reconciliation (recovery) finished. |

## Grafana Dashboard

A comprehensive **Grafana Dashboard** ("Reactive Tasks - System Overview") is included with the package.

It provides real-time visibility into:
- System Health & Global Lag
- Throughput & Latency Heatmaps
- Queue Depth & Composition
- Error Rates & Retries

You can find the dashboard JSON file at:
`node_modules/mongodash/grafana/reactive_tasks.json`

Import this file directly into Grafana to get started.
