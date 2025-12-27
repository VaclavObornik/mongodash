# Configuration & API

## Task Options

When defining a task via `reactiveTask`,

```typescript
await reactiveTask({
    task: 'process-order',
    collection: 'orders',
    // ...
});
```

you can use the following options:

| Option | Type | Description |
| :--- | :--- | :--- |
| `task` | `string` | **Required**. Primary Unique Identifier. <br/> **⚠️ Do NOT change** after deployment, otherwise all existing tasks will be re-executed as new tasks (Double Execution risk). |
| `collection` | `string` | **Required**. Name of the MongoDB collection to watch. |
| `handler` | `(context) => Promise<void>` | **Required**. Async function to process the task. Use `context.getDocument()` to get the document. |
| `filter` | `Document` | Standard Query (e.g., `{ status: 'pending' }`) OR Aggregation Expression (e.g., `{ $eq: ['$status', 'pending'] }`). Aggregation syntax unlocks powerful features like using `$$NOW` for time-based filtering. |
| `watchProjection` | `Document` | MongoDB Projection. Task only re-triggers if the projected result changes. Supports inclusion `{ a: 1 }` and computed fields. |
| `debounce` | `number \| string` | Debounce window (ms or duration string). Default: `1000`. Useful to group rapid updates. |
| `retryPolicy` | `RetryPolicy` | Configuration for retries on failure. See [Retry Policy](./policy-retry.md). |
| `cleanupPolicy` | `CleanupPolicy` | Configuration for automatic cleanup of orphaned task records. See [Cleanup Policy](./policy-cleanup.md). |
| `executionHistoryLimit` | `number` | Number of past execution entries to keep in `_tasks` doc. Default: `5`. |
| `evolution` | `EvolutionConfig` | Configuration for handling task logic updates (versioning, reconciliation policies). See [Task Evolution](./evolution.md). |

## Advanced Initialization

You can customize the scheduler behavior via `mongodash.init`:

```typescript
await mongodash.init({
    uri: '...',
    
    // Instance ID: Unique identifier for this scheduler instance.
    // Used for leader election, metrics aggregation, and debugging.
    // If not provided, a random ObjectId hex string will be generated.
    instanceId: 'my-app-worker-1',
    
    // Concurrency: Number of parallel workers on the *current instance* (default: 5)
    // Total system concurrency = (reactiveTaskConcurrency * number of instances)
    reactiveTaskConcurrency: 10,
    
    // Globals Collection: Used for coordination and leadership (default: '_mongodash_globals')
    globalsCollection: 'my_custom_globals',
    
    // Filter: Run ONLY specific tasks on this instance (e.g. for scaling or time-based windows).
    // This function is called regularly (every poll cycle) for every pending task.
    // Example: Time-Based Filtering (e.g. only run 'nightly-job' during night hours)
    reactiveTaskFilter: ({ task }) => {
        if (task === 'nightly-job') {
             const hour = new Date().getHours();
             return hour >= 0 && hour < 6; // Only process between 00:00 - 06:00
        }
        return true; // Process all other tasks normally
    },
    
    // Caller: Wrap execution to add context, logging, or error handling.
    // Example: Generating a Correlation ID for distributed tracing
    reactiveTaskCaller: async (taskFn) => {
        const correlationId = crypto.randomUUID();
        return AsyncContext.run({ correlationId }, async () => {
             console.log(`[${correlationId}] Starting task...`);
             try {
                 await taskFn();
                 console.log(`[${correlationId}] Task finished.`);
             } catch (e) {
                 console.error(`[${correlationId}] Task failed:`, e);
                 throw e;
             }
        });
    },
    
    monitoring: {
        enabled: true,
        pushIntervalMs: 60000
    },
    
    // Cleanup Interval: How often to run periodic cleanup of orphaned tasks.
    // Accepts duration strings ('24h'), milliseconds, or cron expressions.
    // Default: '24h'
    reactiveTaskCleanupInterval: '24h'
});
```


