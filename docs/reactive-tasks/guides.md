# Guides & Patterns

## Understanding Logic: Filter vs WatchProjection

It is important to understand the relationship between `filter` and `watchProjection`. You can think of them as **"The Gatekeeper"** and **"The Trigger"**.

### 1. `filter` (The Gatekeeper)
Decides **IF** the task should exist at all.
-   **Enters Filter**: If a document changes to match the filter (e.g., `status` changes from `'pending'` -> `'paid'`), the task is **created and runs immediately**, regardless of `watchProjection`.
-   **Leaves Filter**: If a document changes to no longer match (e.g., `'paid'` -> `'cancelled'`), the task is **removed/cleaned up** (depending on your [Cleanup Policy](./policy-cleanup.md)).

### 2. `watchProjection` (The Trigger)
Decides **WHEN** to re-run the task *if it already exists*.
-   Once the task matches the filter and is active, `watchProjection` determines which future updates matter.
-   **Example**: You have a task to sync paid orders to ERP.
    ```typescript
    {
        filter: { status: 'paid' },
        watchProjection: { status: 1 } // Only watch status
    }
    ```
    -   **Scenario**: User updates `shippingAddress` on a `paid` order.
    -   **Result**: The system sees `status` didn't change (still `'paid'`). It **IGNORES** the address update. The ERP sync **does not re-run** (potentially leaving ERP with stale address).
    -   **Fix**: If you need to re-sync on address changes, include `shippingAddress` in `watchProjection` (or omit it to watch everything).

> [!TIP]
> **Best Practice**: If you use a field in `filter` (like `status: 'paid'`), you implicitly don't need to put it in `watchProjection` unless the value can change while remaining valid (e.g., `amount > 100`). However, adding it is harmless and can improve clarity and storage efficiency.

## Execution Model & Guarantees

The system follows a **Reactive (State-Based)** execution model. It prioritizes **Eventual Consistency** over strict event logging.

### 1. State-Based Consistency (vs. Event-Based)

Unlike an Event Bus (e.g., Kafka) that processes every single state transition log, this library guarantees that the **current state** of the document will consistently match your task logic.

*   **Transient States are Skipped**: If a document changes state multiple times rapidly (e.g., `pending` -> `paid` -> `refunded` in milliseconds), the system may skip processing the intermediate `paid` state if it is no longer valid by the time the worker picks it up.
*   **Late Binding Check**: This is enforced via a runtime check (`getDocument`). If the fetched document no longer matches the task filter or the watched fields have changed since triggering, the task for the "stale" version is skipped. This is a feature (Optimistic Concurrency) to prevent processing obsolete data.

### 2. At-Least-Once Guarantee (Final State)

The system guarantees that the **final, stable state** of a document will strictly be processed **at least once**.
If a worker crashes, loses network, or restarts *before* successfully completing a task (and releasing the lock), the task remains `pending`. Another worker will pick it up and retry execution.

### 3. Idempotency Requirement

Because of the "At-Least-Once" guarantee, **your `handler` must be idempotent**.
This means it should be safe to run the same handler multiple times for the same document without producing incorrect side effects (like sending duplicate emails or charging a card twice).

#### Common Re-execution Scenarios

1.  **Transient Failures ([Retries](./policy-retry.md))**: If a worker crashes or loses network connectivity during execution (before marking the task `completed`), the lock will expire. Another worker will pick up the task and retry it.
2.  **[Reconciliation](./reconciliation.md) Recovery**: If task records are deleted (e.g. manual cleanup) but source documents remain, once a reconciliation runs, it recreates them as `pending`.
3.  **Filter Re-matching**: If a document is no longer matching the task filter, the task is deleted because the **[sourceDocumentDeletedOrNoLongerMatching](./policy-cleanup.md)** cleanup policy is used and then the document is changed back again to match the task filter, the task will be recreated as `pending`.
4.  **Explicit Reprocessing**: You might trigger re-execution manually (via `retryReactiveTasks`) or through [Task Evolution policies](./evolution.md) (`reprocess_all`).

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


## The Handler Context

### `getDocument` & Safety Checks

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

**2. Transactions (`session`) & Exactly-Once Processing**

To ensure atomic updates across multiple collections and achieve **Exactly-Once Processing**, you can use MongoDB transactions.

**a) Snapshot Isolation**
Pass a `session` to `getDocument` to ensure the document fetch is part of your transaction snapshot.

**b) Atomic Completion**
By default, the library updates the task status to `completed` *after* your handler finishes. If a crash occurs in between, the task might re-run (At-Least-Once).
To prevent this, use `markCompleted({ session })` to include the task status update within your business transaction.

```typescript
handler: async ({ docId, markCompleted, getDocument }) => {
    const session = client.startSession();
    try {
        await session.withTransaction(async () => {
             // 1. Consistent Read (Optional but recommended)
             const doc = await getDocument({ session });

             // 2. Business Logic (Updates, etc.)
             await otherCollection.updateOne(
                 { _id: docId }, 
                 { $set: { processed: true } }, 
                 { session }
             );

             // 3. Exactly-Once: Commit task status with the transaction
             await markCompleted({ session });
        });
    } finally {
        await session.endSession();
    }
}
```
When `markCompleted` is called, the library skips its automatic finalization.

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

## Graceful Shutdown

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
