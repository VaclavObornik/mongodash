# Cron tasks

## Usable even in scalable (multi-instance) applications

Usable even in scalable (multi-instance) applications thanks to task registration in MongoDB.
Mongodash will ensure each task is processed by only one instance at a time.

You can see a short history of recent task runs here or even [manually trigger a task](#manual-task-run) if you need to!

Also, check out the **[Dashboard](./dashboard.md)** for a visual interface to manage your tasks.
```
cronTasks
```

## cronTask(taskId, interval, taskFunction) => Promise

```typescript
cronTask(taskId, interval, taskFunction) => Promise
```

Register a cron task.

```typescript
import { cronTask } from 'mongodash';

cronTask('my-task-id', '5m 20s', async () => {
    console.log('Hurray the task is running!');
});
```

That's it! Now the task will run every 5 minutes and 20 seconds!

## First task registration also starts the internal loop

First task registration also starts the internal loop watching for a task to run.
This can be prevented by calling [`stopCronTasks()`](#stopcrontasks--void) or passing `runCronTasks: false` option to [mongodash init](#initialization-options-optional).

## Valid values for interval argument

The interval can be specified in several formats:

*   **Duration string**: supported by [parse-duration](https://www.npmjs.com/package/parse-duration)
    ```typescript
    "5m 20s"
    ```
*   **Number**: milliseconds
    ```typescript
    5 * 60 * 1000
    ```
*   **CRON expression**: supported by [cron-parser](https://www.npmjs.com/package/cron-parser). **Must start with the `CRON ` prefix**.
    ```typescript
    "CRON */5 * * * *"
    ```

It also supports functions returning dynamic next run times:

```typescript
() => new Date() // next run at specific date
```

```typescript
() => "5m 20s" // dynamic interval
```

```typescript
() => "CRON */5 * * * *"
```

```typescript
() => 5 * 60 * 1000
```

## scheduleCronTaskImmediately(taskId) => Promise

```typescript
scheduleCronTaskImmediately(taskId) => Promise
```

Schedule the task to run as soon as possible. Handy for cases when you need to hurry up a task based on another task or an API call.

```typescript
import { scheduleCronTaskImmediately } from 'mongodash';
scheduleCronTaskImmediately('my-task-id');
```

## runCronTask(taskId) => Promise

```typescript
runCronTask(taskId) => Promise
```

Run a task and return a promise. The promise is resolved as soon as the task is done. The main purpose of the function is to easily test the tasks in automated tests.

```typescript
import { runCronTask } from 'mongodash';
runCronTask('my-task-id');
```

## Do not use the runCronTask method inside a cron task

**Do not use the runCronTask method inside a cron task.**
It will not work. Use non-blocking [`scheduleCronTaskImmediately`](#schedulecrontaskimmediatelytaskid--promise) instead.

## stopCronTasks() => void

```typescript
stopCronTasks() => void
```

Stop triggering registered tasks. Useful for automated tests, where is usually not desired to run tasks in the background. Calling stopCronTasks function before the first cronTask registration will prevent running any task.

```typescript
import { stopCronTasks } from 'mongodash'; 
stopCronTasks();
```

## startCronTasks() => void

```typescript
startCronTasks() => void
```

Start triggering registered tasks. Usually not needed to call, since the registered tasks run automatically after the registration unless stopCronTasks is called or the mongodash is initialized with `runCronTasks: false`.

```typescript
import { startCronTasks } from 'mongodash';
startCronTasks();
```

## Initialization options (optional)

```typescript
import mongodash from 'mongodash';

mongodash.init({
    // database connection
    uri: 'mongodb://mongodb0.example.com:27017',

    // true by default
    runCronTasks: false,

    // Maximum number of cron tasks this instance executes in parallel.
    // Default 1 (serial). See the "Parallel execution within one instance"
    // section earlier on this page.
    cronTaskConcurrency: 5,

    // valid only if CRON expressions used
    // see https://www.npmjs.com/package/cron-parser for valid options
    cronExpressionParserOptions: {
        tz: 'Europe/Athens',
    },
});
```

## Manual task run

Need to manually trigger a task outside the application? Mongodash Cron tasks allow you to speed up task processing by setting `runImmediately` flag to true. Just find and update the task document in `cronTasks` collection. This is helpful in a deployment environment to speed up a process.

```typescript
// In cronTasks collection
{
    _id: "my-task-id",
    runImmediately: true
}
```

## Performance & Scalability

### Distributed Locking
The system handles concurrency by locking tasks in MongoDB.
- **Default Lock Duration**: 5 minutes.
- **Auto-Renewal**: For long-running tasks, the lock is automatically refreshed every 15 seconds to prevent other instances from picking up the task while it's still running.

### Execution History
The system maintains a brief execution history in the database:
- **Limit**: Only the **last 5 runs** are stored in the `runLog` of the task document.
- Use this to monitor recent successes or failures.

### Parallel execution within one instance

By default each instance runs one cron task at a time. When you have many
independent cron tasks and a single long-running one would block the
others, opt in to parallel execution:

```typescript
await mongodash.init({
    // ...
    cronTaskConcurrency: 5, // up to 5 cron tasks in flight on this instance
});
```

- A single task can **never** run twice in parallel, regardless of the
  value. The per-task `lockedTill` lock guarantees that even within one
  instance — and across instances — only one execution of a given
  `taskId` is in flight at a time.
- `cronTaskConcurrency: 1` (the default) keeps the historical single-loop
  behaviour.
- Raising the value only affects *different* tasks running at the same
  time. Use it when you see head-of-line blocking on the cron collection.

## Monitoring

Cron tasks emit structured events through the `onInfo` callback. Each event
has a stable `code` that you can route to your logging stack without
parsing strings.

| Code constant | When it fires | Payload |
| :--- | :--- | :--- |
| `CODE_CRON_TASK_STARTED` | Handler is about to be invoked. Also fired once during `init` to announce that cron processing has begun. | `{ taskId, code }` |
| `CODE_CRON_TASK_FINISHED` | Handler returned without throwing. | `{ taskId, code, duration }` |
| `CODE_CRON_TASK_FAILED` | Handler threw. The same error is also passed to `onError`. | `{ taskId, code, reason, duration }` |
| `CODE_CRON_TASK_SCHEDULED` | The task has been scheduled for its next run. | `{ taskId, code, nextRunDate }` |

```typescript
import { CODE_CRON_TASK_FAILED } from 'mongodash';

await mongodash.init({
    onInfo: (event) => {
        if (event.code === CODE_CRON_TASK_FAILED) {
            metrics.increment('cron.failed', { task: event.taskId });
        }
    },
});
```

See also [**Error Handling**](./error-handling.md) for how `onError` and
`onInfo` compose.

## Task Management

### getCronTasksList(query?) => Promise<CronPagedResult\<CronTaskRecord\>>

Inspect the state of registered tasks - useful for admin UIs, health
checks, or integration tests.

```typescript
import { getCronTasksList } from 'mongodash';

const page = await getCronTasksList({
    filter: 'daily', // regex match against taskId (case-insensitive)
    limit: 20,
    skip: 0,
    sort: { field: 'nextRunAt', direction: 1 },
});

for (const task of page.items) {
    console.log(task._id, task.status, task.lastRun?.error);
}
```

`status` can be `'idle'`, `'running'` (lock held), `'scheduled'`
(manual trigger pending), or `'failed'` (last run errored).

### getRegisteredCronTaskIds() => string[]

Returns the IDs of tasks registered *on this instance* (useful when
`runCronTasks: false` on some instances).

## Testing

Cron tasks expose three helpers that are primarily useful in tests. They
live on the main `mongodash` module alongside the rest of the cron API.

### Run a task synchronously

```typescript
import { runCronTask } from 'mongodash';

it('processes pending invoices', async () => {
    await runCronTask('invoice-sweep');
    const processed = await invoices.countDocuments({ status: 'processed' });
    expect(processed).toBeGreaterThan(0);
});
```

`runCronTask(taskId)` enqueues the task and awaits its completion. It
throws if called from inside another running cron task — use
`scheduleCronTaskImmediately` / `triggerCronTask` for the "fire and
forget" case.

### Disable the scheduler in tests

Running cron jobs in the background of unit tests causes non-determinism.
Two options:

```typescript
// Option A: never auto-start. Tests trigger everything explicitly.
await mongodash.init({ ..., runCronTasks: false });

// Option B: stop after init. Useful for tests that register tasks and
// then inspect state without running them.
import { stopCronTasks, startCronTasks } from 'mongodash';
stopCronTasks();
// ...
startCronTasks(); // if a test needs it back
```

Called before the first `cronTask()` registration, `stopCronTasks()`
also prevents any task from starting later in the process.

See [**Testing overview**](./testing.md) for cross-subsystem test helpers.
