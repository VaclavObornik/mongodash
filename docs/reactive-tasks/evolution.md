# Task Evolution

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

## 1. Trigger Evolution (Filter / Projection)

When the scheduler starts, it compares the current `filter` and `watchProjection` with the stored configuration from the previous deployment.

*   **Narrowing the Filter** (e.g., `amount > 50` → `amount > 100`):
    *   **Pending Tasks**: Workers will pick up pending tasks. Before execution, they perform a "Late-Binding Check". If the document no longer matches the new filter (e.g. amount is 75), the task is **skipped** (completed) without running the handler.
    *   **Existing Tasks**: Tasks for documents that no longer match are **not deleted** immediately; they remain as history but won't satisfy the filter for future updates. See the cleanup policies for more details.

*   **Widening the Filter** (e.g., `amount > 100` → `amount > 50`):
    *   **Reconciliation**: The system detects the filter change and automatically triggers a **Reconciliation** scan for this specific task.
    *   **Backfilling**: It scans the collection for documents that *now* match the new filter (e.g. amount 75) but don't have a task yet. It schedules new tasks for them immediately.
    *   *Note*: This ensures specific newly-matched documents get processed without needing a manual migration script.

    > [!WARNING]
    > **Dynamic Filters (e.g., `$$NOW`)**: If your filter uses time-based expressions to "widen" the range automatically over time (e.g. `{ $expr: { $lte: ['$releaseDate', '$$NOW'] } }`), this does **NOT** trigger reconciliation. The scheduler only detects changes to the *filter definition object*. Documents that match purely because time has passed (without a data change) will **not** be picked up. For time-based triggers, use a [Cron Task](../cron-tasks.md).

## 2. Logic Evolution (Handler Versioning)

Sometimes you fix a bug in your handler and want to retry failed tasks, or you implement a new feature (e.g. generic data migration) and want to re-run the task for *every* document.

*   **Versioning**: Increment `evolution.handlerVersion` (integer, default 1).
*   **Policies (`onHandlerVersionChange`)**:
    *   `'none'`: The system acknowledges the new version but doesn't touch existing task states. New executions will use the new code.
    *   `'reprocess_failed'`: Finds all tasks currently in `failed` status and resets them to `pending` (resetting attempts count). Useful for bug fixes.
    *   `'reprocess_all'`: Resets **ALL** tasks (failed, completed) to `pending`. Useful for migrations or re-calculating data for the entire dataset.

> [!TIP]
> Use `reprocess_failed` for bug fixes and `reprocess_all` sparingly for data migrations. The system automatically handles the "reset" operation efficiently using database-side updates.


