# Error handling

Mongodash routes all runtime errors and informational events through two
pluggable callbacks you supply at `init` time: `onError` and `onInfo`. Both
default to `console.error` / `console.log` respectively, so you can adopt
the library without any observability plumbing and tighten it later.

## `onError`

Called with an `Error` whenever something went wrong **but the library was
able to continue running** — a failed cron task, a change-stream hiccup,
a planner flush that needed to be retried, etc. Unrecoverable errors
throw from the calling code directly (e.g. `init()` on a bad URI); they
are never routed through `onError`.

```typescript
import mongodash, { OnError } from 'mongodash';

const onError: OnError = (err) => {
    sentry.captureException(err);
    logger.error({ err }, 'mongodash runtime error');
};

await mongodash.init({ uri: '...', onError });
```

### Signature

```typescript
type OnError = (error: Error) => void;
```

The callback is wrapped in a secure handler internally — if your
`onError` itself throws, the wrapper catches and logs it so a faulty
observability layer cannot crash the library. Prefer to keep the
callback fast and synchronous; offload heavy work (HTTP to an APM, disk
IO) to a queue you drain elsewhere.

## `onInfo`

Called with a structured event object whenever the library wants to
announce something interesting that is **not an error**: task lifecycle
transitions, reconciliation progress, leader elections, metric pushes.

Each event carries a stable `code` that you can match on without
parsing the human-readable `message`:

```typescript
import mongodash, {
    OnInfo,
    CODE_CRON_TASK_FAILED,
    CODE_REACTIVE_TASK_FAILED,
    CODE_REACTIVE_TASK_LOCK_LOST,
} from 'mongodash';

const onInfo: OnInfo = (event) => {
    switch (event.code) {
        case CODE_CRON_TASK_FAILED:
        case CODE_REACTIVE_TASK_FAILED:
            metrics.increment('tasks.failed', { task: event.taskId });
            break;
        case CODE_REACTIVE_TASK_LOCK_LOST:
            metrics.increment('tasks.lock_lost', { task: event.taskId });
            break;
    }
    logger.info(event);
};

await mongodash.init({ uri: '...', onInfo });
```

### Signature

```typescript
type OnInfo = (event: { message: string; code: string; [key: string]: unknown }) => void;
```

### Event catalog

| Code constant | Subsystem | When it fires |
| :--- | :--- | :--- |
| `CODE_CRON_TASK_STARTED` | cron | Handler about to be invoked (also on `init` to announce cron processing). |
| `CODE_CRON_TASK_FINISHED` | cron | Handler returned successfully. |
| `CODE_CRON_TASK_FAILED` | cron | Handler threw. The same error is also passed to `onError`. |
| `CODE_CRON_TASK_SCHEDULED` | cron | Task scheduled for next run. |
| `CODE_REACTIVE_TASK_STARTED` | reactive | Handler about to be invoked. |
| `CODE_REACTIVE_TASK_FINISHED` | reactive | Handler succeeded (or skipped via `TaskConditionFailedError`). |
| `CODE_REACTIVE_TASK_FAILED` | reactive | Handler threw. |
| `CODE_REACTIVE_TASK_LOCK_LOST` | reactive | A long-running worker's lock was stolen by another; the worker is backing off. |
| `CODE_REACTIVE_TASK_CLEANUP` | reactive | Orphaned task records were deleted by the cleanup policy. |
| `CODE_REACTIVE_TASK_INITIALIZED` | reactive | A reactive task was registered (also fires on startup for existing registrations). |
| `CODE_REACTIVE_TASK_PLANNER_STARTED` | reactive | Planner started (leader elected or restarted after an error). |
| `CODE_REACTIVE_TASK_PLANNER_STOPPED` | reactive | Planner stopped (leader lost or shutdown). |
| `CODE_REACTIVE_TASK_PLANNER_STREAM_ERROR` | reactive | Raw change-stream error observed. |
| `CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_STARTED` | reactive | Full-scan reconciliation began. |
| `CODE_REACTIVE_TASK_PLANNER_RECONCILIATION_FINISHED` | reactive | Full-scan reconciliation finished. |
| `CODE_REACTIVE_TASK_LEADER_LOCK_LOST` | reactive | This instance was the leader and the lock expired on it. |

See [**Reactive tasks - Monitoring**](./reactive-tasks/monitoring.md) for
the matching Prometheus metrics and
[**Cron tasks - Monitoring**](./cron-tasks.md#monitoring) for the cron
side.

## Typed errors

A handful of errors can be recognised by reference (they are exported
classes) and deserve special handling:

### `TaskConditionFailedError`

Thrown from `context.getDocument()` inside a **reactive-task handler**
when the source document no longer matches the task filter (typically
because the user deleted or updated it between planning and execution).
The library treats it as a soft skip — the task record is marked
finished without raising an error. Operators generally do not need to
react.

```typescript
import { reactiveTask, TaskConditionFailedError } from 'mongodash';

await reactiveTask({
    // ...
    handler: async (ctx) => {
        try {
            const doc = await ctx.getDocument();
            // ...
        } catch (err) {
            if (err instanceof TaskConditionFailedError) {
                // Expected - the upstream filter no longer matches. Skip silently.
                return;
            }
            throw err;
        }
    },
});
```

### `LockAlreadyAcquiredError` / `isLockAlreadyAcquiredError`

Thrown from `withLock` when another caller already holds the lock and
`maxWaitForLock` elapses. Use `isLockAlreadyAcquiredError(err)` when you
do not want to take a static import dependency on the class.

```typescript
import { withLock, LockAlreadyAcquiredError, isLockAlreadyAcquiredError } from 'mongodash';

try {
    await withLock('nightly-rollup', async () => { /* ... */ });
} catch (err) {
    if (isLockAlreadyAcquiredError(err)) {
        // Another instance is already running the rollup - that's fine.
        return;
    }
    throw err;
}
```
