# Task Management & DLQ

You can programmatically manage tasks, investigate failures, and handle Dead Letter Queues (DLQ) using the exported management API.

These functions allow you to build custom admin UIs or automated recovery workflows.

> [!TIP]
> **Dashboard Available**
> While this page describes the programmatic API, Mongodash also provides a **[Visual Dashboard](../dashboard.md)** (GUI) which wraps these methods in a user-friendly interface. The dashboard allows you to view task lists, filter by status/error, retry failed tasks, and trigger cron jobs without writing any code.

## Listing Tasks

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

## Counting Tasks

Use `countReactiveTasks` for metrics or UI badges.

```typescript
import { countReactiveTasks } from 'mongodash';

const dlqSize = await countReactiveTasks({ 
    task: 'send-welcome-email', 
    status: 'failed' 
});
```

## Retrying Tasks

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
