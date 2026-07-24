# Reconciliation & Reliability

The system includes a self-healing mechanism called **Reconciliation**.

## What is it?

It is a "full scan" process that ensures the state of your tasks matches the actual data in your collections. It iterates through your source collections (efficiently, fetching only `_id`) and ensures every document has the correct corresponding tasks planned.

## When does it run?

1.  **On Startup (Partial)**: When `startReactiveTasks()` is called, the leader performs a reconciliation only for tasks that have **never been reconciled before**. This ensures that newly added tasks catch up with existing data.
2.  **On History Loss**: If the MongoDB Change Stream buffer (Oplog) is full and events are lost (Error code 280), the system automatically triggers full reconciliation to ensure consistency is restored.
3.  **On Trigger Evolution**: The system detects any change to your `filter` or `watchProjection` (via JSON comparison). By default, this triggers a reconciliation scan to backfill tasks for existing, newly matching documents. This is controlled by the **[Evolution Strategy](./configuration.md#evolution-configuration)** (default: `true`).

## Resilience

Reconciliation is **persistent and resilient**.
-   **Checkpoints**: The system saves its progress (`lastId`) periodically to the database (`_mongodash_planner_meta`).
-   **Resumable**: If the process is interrupted (e.g., deployment, crash), it effectively **resumes** from the last checkpoint upon restart, preventing re-processing of already reconciled documents.
-   **Invalidation**: If the set of tasks being reconciled changes (e.g., you deploy a version with a NEW task definition for the same collection), the system detects this change, invalidates the checkpoint, and restarts reconciliation from the beginning to ensure the new task is applied to the entire collection.

## Expectations

-   **No Data Loss**: Even if your specific localized Oplog history is lost, the system will eventually process every document.
-   **Performance**: The scan is optimized (uses batching and projection of `_id` only), but it performs a **full collection scan**. On huge collections (millions of docs), this causes increased database load during startup or recovery.
-   **Batch Processing**: Both reconciliation and periodic cleanup process documents in batches to avoid overwhelming the database and the application memory.

> [!CAUTION]
> **Limitations of `$$NOW` in filters**  
> MongoDB Change Streams only trigger when a document is physically updated. If your `filter` depends on time passing (e.g., `dueAt: { $lte: '$$NOW' }`), the task **will not** trigger automatically just because time passed. It will only be picked up during:
> 1.  A physical update to the source document.
> 2.  The next system restart, if the reconciliation is run.
> 3.  Manual re-triggers via `retryReactiveTasks()`.

## Configuration Matters

Reconciliation respects your `filter` and `watchProjection`.
-   If a document doesn't match the `filter`, no task is planned.
-   If the `watchProjection` hasn't changed since the last run (comparing `lastObservedValues`), the task is **not** re-triggered.
-   **Recommendation**: Carefully configure `filter` and `watchProjection` to minimize unnecessary processing during reconciliation.

## Operational notes for very large collections

The initial reconciliation runs inside the leader's work. Two things follow from
that on collections with many millions of documents:

-   **Leader lock TTL vs. scan time.** The leader renews its lock only between
    heartbeats. If the very first reconciliation on a fresh deploy takes longer
    than `lockTtlMs` (default 30s), the lock can expire and a second instance may
    briefly also become leader and start its own scan, multiplying database load
    until the scans finish. It is self-correcting (each scan is idempotent and
    resumable), but to avoid it on large first-time reconciles, raise `lockTtlMs`
    so it comfortably exceeds the expected scan time.
-   **Cursor lifetime.** A single reconciliation batch that takes longer than the
    server's cursor idle timeout (default ~10 min) can end the scan cursor early;
    the collection is then finished on the next reconciliation (startup/restart).
    Keep per-batch work well under that window (the default batch size is tuned
    for this).
