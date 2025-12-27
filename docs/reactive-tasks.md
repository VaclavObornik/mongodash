# Reactive Tasks

A powerful, distributed task execution system built on top of [MongoDB Change Streams](https://www.mongodb.com/docs/manual/changeStreams/). 

Reactive Tasks allow you to define background jobs that trigger automatically when your data changes. This enables **Model Data-Driven Flows**, where business logic is triggered by state changes (e.g., `status: 'paid'`) rather than explicit calls. The system handles **concurrency**, **retries**, **deduplication**, and **monitoring** out of the box.

## Overview

### Features

-   **Reactive**: Tasks triggered instantly (near-real-time) by database changes (insert/update).
-   **Distributed**: Safe to run on multiple instances (Kubernetes/Serverless). Only one instance processes a specific task for a specific document at a time.
-   **Efficient Listener**: Regardless of the number of application instances, **only one instance (the leader)** listens to the MongoDB Change Stream. This minimizes database load significantly (O(1) connections), though it implies that the total ingestion throughput is limited by the single leader instance.
-   **Reliable**: Built-in retry mechanisms (exponential backoff) and "Dead Letter Queue" logic.
-   **Efficient**: Uses MongoDB Driver for low-latency updates and avoids polling where possible.
-   **Memory Efficiency**: The system is designed to handle large datasets. During live scheduling (Change Streams), reconciliation, and periodic cleanup, the library only loads the `_id`'s of the source documents into memory, keeping the footprint low regardless of the collection size. Note that task *storage* size depends on your `watchProjection` configuration—see [Storage Optimization](#change-detection-and-storage-optimization).
-   **Observability**: First-class Prometheus metrics support.
-   **Dashboard**: A visual [Dashboard](./dashboard.md) to monitor, retry, and debug tasks.

### Reactive vs Scheduled Tasks

It is important to distinguish between Reactive Tasks and standard schedulers (like Agenda or BullMQ).

-   **Reactive Tasks (Reactors)**: Triggered by **state changes** (data). "When Order is Paid, send email". This guarantees consistency with data.
-   **Schedulers**: Triggered by **time**. "Send email at 2:00 PM".

Reactive Tasks support time-based operations via `debounce` (e.g., "Wait 1m after data change to settle") and `deferCurrent` (e.g., "Retry in 5m"), but they are fundamentally event-driven. If you need purely time-based jobs (e.g., "Daily Report" without any data change trigger), you can trigger them via a [Cron job](./cron-tasks.md), although you can model them as "Run on insert to 'daily_reports' collection".

### Advantages over Standard Messaging

Using Reactive Tasks instead of a traditional message broker (RabbitMQ, Kafka) provides distinct architectural benefits:

1.  **Lean Stack & Simplified DevOps**:
    -   Eliminates the need to manage, scale, and secure external message brokers.
    -   **Zero-Config Development**: Local testing requires only the database connection—no extra Docker containers or infrastructure to spin up.

2.  **Transactional Consistency (Solving the "Dual Write" Problem)**:
    -   *The Problem*: In standard architectures, writing to the database and publishing an event are two separate operations. If the database write succeeds but the message flush fails (network error, crash), your system enters an inconsistent state.
    -   *The Solution*: With Reactive Tasks, the "event" **is** the database write. The task is triggered electronically by the MongoDB Oplog. This guarantees that **if and only if** data is persisted, the corresponding task will be scheduled—ensuring 100% data consistency without distributed transactions.

3.  **Inspectable State**:
    -   The task queue is stored in a standard MongoDB collection (`[collection]_tasks`), not in a hidden broker queue.
    -   You can use standard tools (MongoDB Compass, Atlas Data Explorer, simple queries) to inspect pending jobs, debug failures, and analyze queue distribution without needing specialized queue management interfaces.

## Getting Started

### 1. Initialization

Ensure `mongodash` is initialized with a global `uri` or `mongoClient`.

```typescript
import mongodash from 'mongodash';

await mongodash.init({
    uri: 'mongodb://localhost:27017/my-app'
});
```

### 2. Define a Task

Use the `reactiveTask` function to register a task. You define *what* to watch and *how* to process it.

```typescript
import { reactiveTask } from 'mongodash';

// Define a task that sends an email when a User is created or updated
// multiple tasks can listen to the same collection!
await reactiveTask({
    task: 'send-welcome-email', // Unique Job ID
    collection: 'users',        // Collection to watch
    
    // Optional: Only trigger if specific fields change
    watchProjection: { status: 1, email: 1 },
    
    // Optional: Filter documents (Standard Query or Aggregation Expression)
    filter: { status: 'active' },

    // The logic to execute
    handler: async (context) => {
        // Fetch the document (verifies filter & optimistic locking)
        const userDoc = await context.getDocument();
        
        console.log(`Processing user: ${userDoc._id}`);
        await sendEmail(userDoc.email, 'Welcome!');
    }
});
```

### 3. Start the System

After registering all tasks, start the scheduler. This will assume leadership (if possible) and start processing.

```typescript
import { startReactiveTasks } from 'mongodash';

await startReactiveTasks();
```

### 4. Advanced Configuration

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

## Writing Tasks

### Task Options

| Option | Type | Description |
| :--- | :--- | :--- |
| `task` | `string` | **Required**. Unique identifier for the task type. |
| `collection` | `string` | **Required**. Name of the MongoDB collection to watch. |
| `handler` | `(context) => Promise<void>` | **Required**. Async function to process the task. Use `context.getDocument()` to get the document. |
| `filter` | `Document` | Standard Query (e.g., `{ status: 'pending' }`) OR Aggregation Expression (e.g., `{ $eq: ['$status', 'pending'] }`). Aggregation syntax unlocks powerful features like using `$$NOW` for time-based filtering. |
| `watchProjection` | `Document` | MongoDB Projection. Task only re-triggers if the projected result changes. Supports inclusion `{ a: 1 }` and computed fields. |
| `debounce` | `number \| string` | Debounce window (ms or duration string). Default: `1000`. Useful to group rapid updates. |
| `retryPolicy` | `RetryPolicy` | Configuration for retries on failure. |
| `cleanupPolicy` | `CleanupPolicy` | Configuration for automatic cleanup of orphaned task records. See [Cleanup Policy](#cleanup-policy). |
| `executionHistoryLimit` | `number` | Number of past execution entries to keep in `_tasks` doc. Default: `5`. |
| `evolution` | `EvolutionConfig` | Configuration for handling task logic updates (versioning, reconciliation policies). See [Filter Evolution & Reconciliation](#filter-evolution-and-reconciliation). |

### Common Use Cases

Reactive Tasks are versatile. Here are a few patterns you can implement:

#### A. Webhook Delivery & Data Sync
Perfect for reliable delivery of data to external systems. If the external API is down, Mongodash will automatically retry with exponential backoff.

```typescript
await reactiveTask({
    task: 'sync-order-to-erp',
    collection: 'orders',
    filter: { status: 'paid' }, // Only sync when paid
    watchProjection: { status: 1 },  // Only check when status changes
    
    handler: async (context) => {
        const order = await context.getDocument();
        await axios.post('https://erp-system.com/api/orders', order);
    }
});
```

#### B. Async Statistics Recalculation
Offload heavy calculations from the main request path. When a raw document changes, update the aggregated view in the background.

```typescript
await reactiveTask({
    task: 'recalc-product-rating',
    collection: 'reviews',
    debounce: '5s', // Re-calc at most once every 5 seconds per product
    
    handler: async (context) => {
        // We only watched 'status', so we might need the full doc? 
        // Or if we have the ID, that's enough for aggregation:
        const { docId } = context; 

        // Calculate new average
        const stats = await calculateAverageRating(docId);
        
        // Update product document
        await db.collection('products').updateOne(
            { _id: docId },
            { $set: { rating: stats.rating, reviewCount: stats.count } }
        );
    }
});
```

#### C. Pub-Sub (Event Bus)
Use Reactive Tasks as a distributed Event Bus. By creating an events collection and watching only the `_id`, you effectively create a listener that triggers **only on new insertions**.

```typescript
await reactiveTask({
    task: 'send-welcome-sequence',
    collection: 'app_events',
    
    // TRICK: _id never changes. 
    // This config ensures the handler ONLY runs when a new document is inserted.
    watchProjection: { _id: 1 }, 
    filter: { type: 'user-registered' },
    
    handler: async (context) => {
        const event = await context.getDocument();
        await emailService.sendWelcome(event.payload.email);
    }
});
```

### The Handler Context: `getDocument` & Safety Checks

Critically, the library performs a **runtime check** when you call `await context.getDocument()` inside your handler.

1.  **Lock Task**: The worker locks the task.
2.  **Fetch & Verify**: When you call `await context.getDocument()`, it performs an atomic fetch that ensures:
    *   **Filter Match**: The document still matches your `filter` configuration.
    *   **Data Consistency**: The watched fields (`watchProjection`) have NOT changed since the task was triggered (Optimistic Locking).
    *   **Existence**: The document still exists.

    If any of these conditions fail, `getDocument` throws a `TaskConditionFailedError`. The worker catches this error effectively **skipping** the task and marking it as 'completed'.

**Why is this important?**
*   **Race Conditions**: Imagine a "Back-In-Stock" task triggered when `inventory > 0`. If the item sells out immediately (`inventory` returns to `0`) *while* the task is waiting in the queue, this check prevents sending a false notification.
*   **Optimistic Concurrency**: If the data changed significantly (e.g. `status` changed from `paid` to `refunded`) between trigger and execution, the task is skipped to effectively "cancel" the stale operation. A new task for the new state (`refunded`) will likely be in the queue anyway.

#### Advanced Usage: Options & Transactions

The `getDocument(options)` method accepts standard MongoDB `FindOptions`, allowing you to optimize performance or ensure consistency.

**1. Projections (Partial Fetch)**
If your source document is large but you only need a few fields, use `projection`.

```typescript
const user = await context.getDocument({ 
    projection: { email: 1, firstName: 1 } 
});
```

**2. Transactions (`session`)**
To ensure atomic updates across multiple collections, pass a `session` to `getDocument`. This ensures that the document fetch and your subsequent writes happen within the same transaction snapshot.

```typescript
import { withTransaction } from 'mongodash';

handler: async (context) => {
    await withTransaction(async (session) => {
        // Pass session to getDocument to participate in the transaction
        const doc = await context.getDocument({ session });

        // Perform other operations in the same transaction
        await otherCollection.updateOne({ _id: doc.refId }, { $set: { ... } }, { session });
    });
}
```

**3. Locking Resources (`withLock`)**
While the *task itself* is locked (ensuring only one worker processes this specific task instance), you might need to lock shared resources if your handler accesses data outside the source document.

You can use `context.watchedValues` to get IDs needed for locking *before* you fetch the document.

```typescript
import { withLock } from 'mongodash';

handler: async (context) => {
    // Use watchedValues to get the ID for locking
    const accountId = context.watchedValues.accountId;

    // Lock a shared resource
    await withLock(`account-update-${accountId}`, async () => {
        // Now it is safe to fetch and process
        const doc = await context.getDocument();
        // ... safe exclusive access to the account ...
    });
}
```

### Flow Control (Defer / Throttle)

Sometimes you need dynamic control over task execution speed based on external factors (e.g., rate limits of a 3rd party API) or business logic.

The `handler` receives a `context` object that exposes flow control methods.

#### 1. Deferral (`deferCurrent`)

Delays the **current** task execution. The task is put back into the queue specifically for this document and will not be picked up again until the specified time.

This is useful for:
*   **Rate Limits**: "API returned 429, try again in 30 seconds."
*   **Business Waits**: "Customer created, but wait 1 hour before sending first email."

```typescript
await reactiveTask({
    task: 'send-webhook',
    collection: 'events',
    handler: async (context) => {
        const doc = await context.getDocument();
        try {
            await sendWebhook(doc);
        } catch (err) {
            if (err.status === 429) {
                const retryAfter = err.headers['retry-after'] || 30; // seconds
                
                // Defer THIS task only. 
                // It resets status to 'pending' and schedules it for future.
                // It does NOT increment attempt count (it's not a failure).
                context.deferCurrent(retryAfter * 1000); 
                return;
            }
            throw err; // Use standard retry policy for other errors
        }
    }
});
```

#### 2. Throttling (`throttleAll`)

Pauses all FUTURE tasks of this type for a specified duration. This serves as a "Circuit Breaker" when an external system (e.g., CRM, Payment Gateway) is unresponsive or returns overload errors (503, 429).

```typescript
context.throttleAll(60 * 1000); // Pause this task type for 1 minute
```

> [!IMPORTANT]
> **Cluster Behavior (Instance-Local)**
> `throttleAll` operates only in the memory of the current instance (worker).
> In a distributed environment (e.g., Kubernetes with multiple pods), other instances will not know about the issue immediately. They will continue processing until they independently encounter the error and trigger their own `throttleAll`.
>
> **Result**: The load on the external service will not drop to zero immediately but will decrease gradually as individual instances hit the "circuit breaker".

> [!NOTE]
> **Current Task**
> `throttleAll` does not affect the currently running task. If you want to postpone the current task (so it counts as pending and retries after the pause), you must explicitly call `deferCurrent()`.

**Example (Service Down):**

```typescript
await reactiveTask({
    task: 'sync-to-crm',
    collection: 'users',
    handler: async (context) => {
        // Note: You can throttle even before fetching the doc if you know the service is down!
        try {
            const doc = await context.getDocument();
            await crmApi.update(doc);
        } catch (err) {
            // If service is unavailable (503) or circuit breaker is open
            if (err.status === 503 || err.isCircuitBreakerOpen) {
                console.warn('CRM is down, pausing tasks for 1 minute.');

                // 1. Stop processing future tasks of this type on this instance
                context.throttleAll(60 * 1000);

                // 2. Defer the CURRENT task so it retries after the pause
                context.deferCurrent(60 * 1000);
                return;
            }
            throw err; // Standard retry policy for other errors
        }
    }
});
```

### Idempotency & Re-execution

The system is designed with an **At-Least-Once** execution guarantee. This is a fundamental property of distributed systems that value reliability over "exactly-once".

While the system strives to execute your handler exactly once per event, there are specific scenarios where it might execute multiple times for the same document state. Therefore, **your `handler` must be idempotent**.

#### Common Re-execution Scenarios

1.  **Transient Failures (Retries)**: If a worker crashes or loses network connectivity during execution (before marking the task `completed`), the lock will expire. Another worker will pick up the task and retry it.
2.  **Reconciliation Recovery**: If task records are deleted (e.g. manual cleanup) but source documents remain, once a reconciliation runs, it recreates them as `pending`.
3.  **Filter Re-matching** If a document is no longer matching the task filter, the task is deleted because the **sourceDocumentDeletedOrNoLongerMatching** cleanup policy is used and then the document is changed back again to match the task filter, the task will be recreated as `pending`.
4.  **Explicit Reprocessing**: You might trigger re-execution manually (via `retryReactiveTasks`) or through schema evolution policies (`reprocess_all`).

#### Designing Idempotent Handlers

Ensure your handler allows multiple executions without adverse side effects.

**Example**:
```typescript
handler: async (context) => {
    // 1. Fetch document (with verification)
    const order = await context.getDocument();

    // 2. Check if the work is already done
    if (order.emailSent) return;
    
    // 3. Perform the side-effect
    await sendEmail(order.userId, "Order Received");
    
    // 4. Mark as done (using atomic update)
    await db.collection('orders').updateOne(
        { _id: order._id }, 
        { $set: { emailSent: true } }
    );
}
```

## Policies & Lifecycle

### Retry Policy

You can configure the retry behavior using the `retryPolicy` option.

**General Options**

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `type` | `string` | **Required** | `'fixed'`, `'linear'`, `'exponential'`, `'series'`, or `'cron'` |
| `maxAttempts` | `number` | `5`* | Maximum total attempts (use `-1` for unlimited). |
| `maxDuration` | `string \| number` | `undefined` | Stop retrying if elapsed time since the **first failure** in the current sequence exceeds this value. |
| `resetRetriesOnDataChange` | `boolean` | `true` | Reset attempt count if the source document changes. |

*\* If `maxDuration` is specified, `maxAttempts` defaults to unlimited.*

#### Policy Specific Settings

| Policy | Property | Default | Description |
| :--- | :--- | :--- | :--- |
| **`fixed`** | `interval` | - | Delay between retries (e.g., `'10s'`). |
| **`linear`** | `interval` | - | Base delay multiplied by `attempt` number. |
| **`exponential`** | `min` | `'10s'` | Initial delay for the first retry. |
| **`exponential`** | `max` | `'1d'` | Maximum delay cap for backoff. |
| **`exponential`** | `factor` | `2` | Multiplication factor per attempt. |
| **`series`** | `intervals` | - | Array of fixed delays (e.g., `['1m', '5m', '15m']`). |
| **`cron`** | `expression` | - | Standard cron string for scheduling retries. |

#### Examples

```typescript
// 1. Give up after 24 hours (infinite attempts within that window)
retryPolicy: {
    maxDuration: '24h',
    type: 'exponential',
    min: '10s',
    max: '1h'
}

// 2. Exact retry ladder (try after 1m, then 5m, then 15m, then fail)
retryPolicy: {
    maxAttempts: 4, // 1st run + 3 retries
    type: 'series',
    intervals: ['1m', '5m', '15m']
}

// 3. Series with last interval reuse
// Sequence: 1m, 5m, 5m, 5m ... (last one repeats)
retryPolicy: {
    maxAttempts: 10,
    type: 'series',
    intervals: ['1m', '5m']
}

// 4. Permanent retries every hour
retryPolicy: {
    maxAttempts: -1,
    type: 'fixed',
    interval: '1h'
}
```

### Cleanup Policy

The Cleanup Policy controls automatic deletion of orphaned task records — tasks whose source documents have been deleted or no longer match the configured filter.

#### Configuration

```typescript
cleanupPolicy?: {
    deleteWhen?: 'sourceDocumentDeleted' | 'sourceDocumentDeletedOrNoLongerMatching' | 'never';
    keepFor?: string | number;
}
```

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `deleteWhen` | `string` | `'sourceDocumentDeleted'` | When to trigger task deletion |
| `keepFor` | `string \| number` | `'24h'` | Grace period before deletion (e.g., `'1h'`, `'7d'`, or `86400000` ms) |

#### Deletion Strategies (`deleteWhen`)

| Strategy | Behavior |
|----------|----------|
| `sourceDocumentDeleted` | **Default.** Task deleted only when its source document is deleted from the database. Filter mismatches are ignored. |
| `sourceDocumentDeletedOrNoLongerMatching` | Task deleted when source document is deleted **OR** when it no longer matches the task's `filter`. Useful for cases the change of document is permament and it is not expected the document could match in the future again and retrigger because of that. Also useful for  `$$NOW`-based or dynamic filters. |
| `never` | Tasks are never automatically deleted. Use for audit trails or manual cleanup scenarios. |

#### Grace Period Calculation

The `keepFor` grace period is measured from `MAX(updatedAt, lastFinalizedAt)`:

- **`updatedAt`**: When the source document's watched fields (`watchProjection`) last changed
- **`lastFinalizedAt`**: When a worker last completed or failed the task

This ensures tasks are protected if either:
1. The source data changed recently, OR
2. A worker processed the task recently

#### Example: Dynamic Filter Cleanup

```typescript
await reactiveTask({
    task: 'remind-pending-order',
    collection: 'orders',
    // Match orders pending for more than 24 hours
    filter: { $expr: { $gt: ['$$NOW', { $add: ['$createdAt', 24 * 60 * 60 * 1000] }] } },
    
    cleanupPolicy: {
        deleteWhen: 'sourceDocumentDeletedOrNoLongerMatching',
        keepFor: '1h', // Keep it at least 1 hour after last scheduled matching or finalization
    },
    
    handler: async (order) => { /* Send reminder email */ }
});
```

#### Scheduler-Level Configuration

Control how often the cleanup runs using `reactiveTaskCleanupInterval` in scheduler options. Cleanup is performed in **batches** (default 1000 items) to ensure stability on large datasets.

```typescript
await mongodash.init({
    // ...
    reactiveTaskCleanupInterval: '12h', // Run cleanup every 12 hours (default: '24h')
});
```

Supported formats:
- Duration string: `'1h'`, `'24h'`, `'7d'`
- Milliseconds: `86400000`
- Cron expression: `'CRON 0 3 * * *'` (e.g., daily at 3 AM)

### Filter Evolution and Reconciliation

Reactive Tasks are designed to evolve with your application. As you deploy new versions of your code, you might change the `filter`, `watchProjection`, or the `handler` logic itself. The system automatically detects these changes and adapts the task state accordingly.

You can control this behavior using the optional `evolution` configuration:

```typescript
await reactiveTask({
    task: 'process-order',
    collection: 'orders',
    filter: { status: 'paid', amount: { $gt: 100 } },
    
    // Logic Versioning
    evolution: {
        // Increment this when you change the handler code and want to re-process tasks
        handlerVersion: 2, 
        
        // What to do when version increments?
        // - 'none': Do nothing (default).
        // - 'reprocess_failed': Reset all 'failed' tasks to 'pending' to retry with new code.
        // - 'reprocess_all': Reset ALL tasks (even completed ones) to 'pending'.
        onHandlerVersionChange: 'reprocess_failed',
        
        // If 'filter' or 'watchProjection' changes, should we run reconciliation?
        // Default: true
        reconcileOnTriggerChange: true
    },

    handler: async (order) => { /* ... */ }
});
```

#### 1. Trigger Evolution (Filter / Projection)

When the scheduler starts, it compares the current `filter` and `watchProjection` with the stored configuration from the previous deployment.

*   **Narrowing the Filter** (e.g., `amount > 50` → `amount > 100`):
    *   **Pending Tasks**: Workers will pick up pending tasks. Before execution, they perform a "Late-Binding Check". If the document no longer matches the new filter (e.g. amount is 75), the task is **skipped** (completed) without running the handler.
    *   **Existing Tasks**: Tasks for documents that no longer match are **not deleted** immediately; they remain as history but won't satisfy the filter for future updates. See the cleanup policies for more details.

*   **Widening the Filter** (e.g., `amount > 100` → `amount > 50`):
    *   **Reconciliation**: The system detects the filter change and automatically triggers a **Reconciliation** scan for this specific task.
    *   **Backfilling**: It scans the collection for documents that *now* match the new filter (e.g. amount 75) but don't have a task yet. It schedules new tasks for them immediately.
    *   *Note*: This ensures specific newly-matched documents get processed without needing a manual migration script.

    > [!WARNING]
    > **Dynamic Filters (e.g., `$$NOW`)**: If your filter uses time-based expressions to "widen" the range automatically over time (e.g. `{ $expr: { $lte: ['$releaseDate', '$$NOW'] } }`), this does **NOT** trigger reconciliation. The scheduler only detects changes to the *filter definition object*. Documents that match purely because time has passed (without a data change) will **not** be picked up. For time-based triggers, use a [Cron Task](./cron-tasks.md).

#### 2. Logic Evolution (Handler Versioning)

Sometimes you fix a bug in your handler and want to retry failed tasks, or you implement a new feature (e.g. generic data migration) and want to re-run the task for *every* document.

*   **Versioning**: Increment `evolution.handlerVersion` (integer, default 1).
*   **Policies (`onHandlerVersionChange`)**:
    *   `'none'`: The system acknowledges the new version but doesn't touch existing task states. New executions will use the new code.
    *   `'reprocess_failed'`: Finds all tasks currently in `failed` status and resets them to `pending` (resetting attempts count). Useful for bug fixes.
    *   `'reprocess_all'`: Resets **ALL** tasks (failed, completed) to `pending`. Useful for migrations or re-calculating data for the entire dataset.

> [!TIP]
> Use `reprocess_failed` for bug fixes and `reprocess_all` sparingly for data migrations. The system automatically handles the "reset" operation efficiently using database-side updates.

#### Reconciliation & Reliability

The system includes a self-healing mechanism called **Reconciliation**.

**What is it?**
It is a "full scan" process that ensures the state of your tasks matches the actual data in your collections. It iterates through your source collections (efficiently, fetching only `_id`) and ensures every document has the correct corresponding tasks planned.

**When does it run?**
1.  **On Startup (Partial)**: When `startReactiveTasks()` is called, the leader performs a reconciliation only for tasks that have **never been reconciled before**. This ensures that newly added tasks catch up with existing data.
2.  **On History Loss**: If the MongoDB Change Stream buffer (Oplog) is full and events are lost (Error code 280), the system automatically triggers full reconciliation to ensure consistency is restored.

Reconciliation is **persistent and resilient**.
-   **Checkpoints**: The system saves its progress (`lastId`) periodically to the database (`_mongodash_planner_meta`).
-   **Resumable**: If the process is interrupted (e.g., deployment, crash), it effectively **resumes** from the last checkpoint upon restart, preventing re-processing of already reconciled documents.
-   **Invalidation**: If the set of tasks being reconciled changes (e.g., you deploy a version with a NEW task definition for the same collection), the system detects this change, invalidates the checkpoint, and restarts reconciliation from the beginning to ensure the new task is applied to the entire collection.

**What to expect?**
-   **No Data Loss**: Even if your specific localized Oplog history is lost, the system will eventually process every document.
-   **Performance**: The scan is optimized (uses batching and projection of `_id` only), but it performs a **full collection scan**. On huge collections (millions of docs), this causes increased database load during startup or recovery.
-   **Batch Processing**: Both reconciliation and periodic cleanup process documents in batches to avoid overwhelming the database and the application memory.

> [!CAUTION]
> **Limitations of `$$NOW` in filters**  
> MongoDB Change Streams only trigger when a document is physically updated. If your `filter` depends on time passing (e.g., `dueAt: { $lte: '$$NOW' }`), the task **will not** trigger automatically just because time passed. It will only be picked up during:
> 1.  A physical update to the source document.
> 2.  The next system restart, if the reconciliation is run.
> 3.  Manual re-triggers via `retryReactiveTasks()`.
-   **Configuration Matters**: Reconciliation respects your `filter` and `watchProjection`.
    -   If a document doesn't match the `filter`, no task is planned.
    -   If the `watchProjection` hasn't changed since the last run (comparing `lastObservedValues`), the task is **not** re-triggered.
    -   **Recommendation**: Carefully configure `filter` and `watchProjection` to minimize unnecessary processing during reconciliation.

### Change Detection and Storage Optimization

To ensure reliability and efficiency, the system needs to determine *when* to trigger a task.

**How it works:**
1.  **State Persistence**: For every source document, a corresponding "task document" is stored in the `[collection]_tasks` collection.
2.  **Snapshotting**: This task document holds a snapshot of the source document's fields (specifically, the result of `watchProjection`).
3.  **Diffing**: When an event occurs (or during reconciliation), the system compares the current state of the document against the stored snapshot (`lastObservedValues`).
4.  **No-Op**: If the watched fields haven't changed, **no task is triggered**. This guarantees reliability and prevents redundant processing.

**Storage Implications:**
-   **Task Persistence**: The task document remains in the `_tasks` collection as long as the source document exists. It is only removed when the source document is deleted.
-   **Optimization**: If `watchProjection` is **not defined**, the system copies the **entire source document** into the task document.
-   **Recommendation**: For collections with **large documents** or **large datasets**, always define `watchProjection`. This significantly reduces storage usage and improves performance by copying only the necessary data subset.
-   **Tip**: If you want to trigger the task on *any* change but avoid storing the full document, watch a versioning field like `updatedAt`, `lastModifiedAt`, or `_version`.
    ```typescript
    // Triggers on any update (assuming your app updates 'updatedAt'), 
    // but stores ONLY the 'updatedAt' date in the tasks collection.
    watchProjection: { updatedAt: 1 } 
    ```

## Operations & Monitoring

### Task Management & DLQ

You can programmatically manage tasks, investigate failures, and handle Dead Letter Queues (DLQ) using the exported management API.

These functions allow you to build custom admin UIs or automated recovery workflows.

#### Listing Tasks

Use `getReactiveTasks` to inspect the queue. You can filter by task name, status, error message, or properties of the **source document**.

```typescript
import { getReactiveTasks } from 'mongodash';

// list currently failed tasks
const failedTasks = await getReactiveTasks({ 
    task: 'send-welcome-email', 
    status: 'failed' 
});

// list with pagination
const page1 = await getReactiveTasks(
    { task: 'send-welcome-email' }, 
    { limit: 50, skip: 0, sort: { scheduledAt: -1 } }
);

// Advanced: Helper to find task by properties of the SOURCE document
// This is powerful: "Find the task associated with Order #123"
const orderTasks = await getReactiveTasks({
    task: 'sync-order',
    sourceDocFilter: { _id: 'order-123' }
});

// Advanced: Find tasks where source document matches complex filter
// "Find sync tasks for all VIP users"
const vipTasks = await getReactiveTasks({
    task: 'sync-order',
    sourceDocFilter: { isVip: true } 
});
```

#### Counting Tasks

Use `countReactiveTasks` for metrics or UI badges.

```typescript
import { countReactiveTasks } from 'mongodash';

const dlqSize = await countReactiveTasks({ 
    task: 'send-welcome-email', 
    status: 'failed' 
});
```

#### Retrying Tasks

Use `retryReactiveTasks` to manually re-trigger tasks. This is useful for DLQ recovery after fixing a bug.

This operation is **concurrency-safe**. If a task is currently `processing`, it will be marked to re-run immediately after the current execution finishes (`processing_dirty`), ensuring no race conditions.

```typescript
import { retryReactiveTasks } from 'mongodash';

// Retry ALL failed tasks for a specific job
const result = await retryReactiveTasks({ 
    task: 'send-welcome-email', 
    status: 'failed' 
});
console.log(`Retried ${result.modifiedCount} tasks.`);

// Retry specific task by Source Document ID
await retryReactiveTasks({
    task: 'sync-order',
    sourceDocFilter: { _id: 'order-123' }
});

// Bulk Retry: Retry all tasks for "VIP" orders
// This efficiently finds matching tasks and schedules them for execution.
await retryReactiveTasks({
    task: 'sync-order',
    sourceDocFilter: { isVip: true }
});
```

### Monitoring

Mongodash provides built-in Prometheus metrics to monitor your reactive tasks.

> [!NOTE]
> **Dependency Required**: You must install `prom-client` yourself to use this feature. It is an optional peer dependency.
> ```bash
> npm install prom-client
> ```

#### Configuration

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

#### Retrieving Metrics

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

#### Available Metrics

The system exposes the following metrics with standardized labels:

| Metric Name | Type | Labels | Description |
| :--- | :--- | :--- | :--- |
| `reactive_tasks_duration_seconds` | Histogram | `task_name`, `status` | Distribution of task processing time (success/failure). |
| `reactive_tasks_retries_total` | Counter | `task_name` | Total number of retries attempted. |
| `reactive_tasks_queue_depth` | Gauge | `task_name`, `status` | Current number of tasks in the queue, grouped by status (`pending`, `processing`, `processing_dirty`, `failed`). |
| `reactive_tasks_global_lag_seconds` | Gauge | `task_name` | Age of the oldest `pending` task, measured from `initialScheduledAt` (or `scheduledAt` if not deferred). This ensures deferred tasks still reflect their true waiting time. |
| `reactive_tasks_change_stream_lag_seconds` | Gauge | *none* | Time difference between now and the last processed Change Stream event. |
| `reactive_tasks_last_reconciliation_timestamp_seconds` | Gauge | *none* | Timestamp when the last full reconciliation (recovery) finished. |

#### Grafana Dashboard

A comprehensive **Grafana Dashboard** ("Reactive Tasks - System Overview") is included with the package.

It provides real-time visibility into:
- System Health & Global Lag
- Throughput & Latency Heatmaps
- Queue Depth & Composition
- Error Rates & Retries

You can find the dashboard JSON file at:
`node_modules/mongodash/grafana/reactive_tasks.json`

Import this file directly into Grafana to get started.

### Graceful Shutdown

When shutting down your application, call `stopReactiveTasks()` in your termination signal handlers to ensure in-progress tasks complete and resources are released cleanly.

**Recommended Pattern:**

```typescript
import { stopReactiveTasks } from 'mongodash';

const gracefulShutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down...`);
  
  // Set timeout to force exit if shutdown hangs
  const timeout = setTimeout(() => {
    console.error('Shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000);
  
  try {
    await stopReactiveTasks();  // Stop tasks BEFORE closing DB
    await server.close();        // Close your HTTP server
    await db.disconnect();       // Close database connection
    
    clearTimeout(timeout);
    process.exit(0);
  } catch (err) {
    console.error('Shutdown error:', err);
    process.exit(1);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker, K8s
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C
```

> [!IMPORTANT]
> Always call `stopReactiveTasks()` **before** closing database connections, as the stop process needs to communicate with MongoDB.

> [!NOTE]
> **Self-Healing Design**: While graceful shutdown is recommended best practice, the system is designed to be resilient. If your application crashes or is forcefully terminated, task locks will automatically expire after a timeout (default: 1 minute), allowing other instances to pick up and process the unfinished tasks. Similarly, leadership locks expire, ensuring another instance takes over. This guarantees eventual task processing even in failure scenarios.

## Architecture & Internals

### Architecture & Scalability

The system uses a **Leader-Worker** architecture to balance efficiency and scalability.

#### 1. The Leader (Planner)
-   **Role**: A single instance is elected as the **Leader**.
-   **Responsibility**: It listens to the MongoDB Change Stream, calculates the necessary tasks (based on `watchProjection`), and persists them into the `_tasks` collection. To minimize memory usage, it only fetches the document `_id` from the Change Stream event.
    > [!NOTE]
    > **Database Resolution**: The Change Stream is established on the database of the **first registered reactive task**.
-   **Resilience**: Leadership is maintained via a distributed lock with a heartbeat. If the leader crashes, another instance automatically takes over (Failover).

#### 2. The Workers (Executors)
-   **Role**: *Every* instance (including the leader) runs a set of **Worker** threads (managed by the event loop).
-   **Responsibility**: Workers poll the `_tasks` collection for `pending` jobs, lock them, and execute the `handler`.
-   **Adaptive Polling**: Workers use an **adaptive polling** mechanism.
    -   **Idle**: If no tasks are found, the polling frequency automatically lowers (saves CPU/IO).
    -   **Busy**: If tasks are found (or the **local** Leader signals new work), the frequency speeds up immediately to process the queue as fast as possible. Workers on other instances will speed up once they independently find a task during their regular polling.

### Task States & Lifecycle

Every task record in the `_tasks` collection follows a specific lifecycle:

| Status | Description |
| :--- | :--- |
| `pending` | Task is waiting to be processed by a worker. This is the initial state after scheduling or a re-trigger. |
| `processing` | Task is currently locked and being worked on by an active worker instance. |
| `processing_dirty` | **Concurrency Guard.** New data was detected while the worker was already processing the previous state. The task will be reset to `pending` immediately after the current run finishes to ensure no updates are missed. |
| `completed` | Task was processed successfully or it was not matching the filter during the last attempt. |
| `failed` | Task permanently failed after exceeding all retries or the `maxDuration` window. |
