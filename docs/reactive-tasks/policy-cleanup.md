# Cleanup Policy

The Cleanup Policy controls automatic deletion of orphaned task records — tasks whose source documents have been deleted or no longer match the configured filter.

## Configuration

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

### Deletion Strategies (`deleteWhen`)

| Strategy | Behavior |
|----------|----------|
| `sourceDocumentDeleted` | **Default.** Task deleted only when its source document is deleted from the database. Filter mismatches are ignored. |
| `sourceDocumentDeletedOrNoLongerMatching` | Task deleted when source document is deleted **OR** when it no longer matches the task's `filter`. Useful for cases the change of document is permament and it is not expected the document could match in the future again and retrigger because of that. Also useful for  `$$NOW`-based or dynamic filters. |
| `never` | Tasks are never automatically deleted. Use for audit trails or manual cleanup scenarios. |

### Grace Period Calculation

The `keepFor` grace period is measured from `MAX(updatedAt, lastFinalizedAt)`:

- **`updatedAt`**: When the source document's watched fields (`watchProjection`) last changed
- **`lastFinalizedAt`**: When a worker last completed or failed the task

This ensures tasks are protected if either:
1. The source data changed recently, OR
2. A worker processed the task recently

### Example: Dynamic Filter Cleanup

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

### Scheduler-Level Configuration

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
