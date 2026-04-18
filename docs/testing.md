# Testing

Mongodash's asynchronous subsystems (reactive tasks, cron, change streams)
need more than a fixed `setTimeout` in tests. This page lists the testing
utilities the library provides, grouped by scope.

## Generic

### `waitUntil`

A general-purpose polling helper that resolves once a condition function
returns `true`. Useful when the built-in waits are too broad (e.g. waiting
for an HTTP side effect or an external queue) or as a building block for
your own utilities.

It includes a **time-jump detector**: if a breakpoint or a suspended laptop
pauses the event loop for more than a second, the deadline is extended by
the observed pause so the wait does not falsely time out.

```typescript
import { waitUntil } from 'mongodash/testing';

await waitUntil(
    async () => (await getBalance(userId)) === 100,
    { timeoutMs: 5000, pollIntervalMs: 50, stabilityDurationMs: 100 },
);
```

| Option | Default | Description |
| :--- | :--- | :--- |
| `timeoutMs` | `10000` | Maximum time before throwing. |
| `pollIntervalMs` | `50` | How often the condition is evaluated. |
| `stabilityDurationMs` | `0` | How long the condition must _remain_ true before resolving. Prevents flakiness when a state briefly flips true then false. |

## Reactive tasks

See [**Testing Reactive Tasks**](./reactive-tasks/testing.md) for:

-   `waitUntilReactiveTasksIdle` — wait for the reactive-task subsystem to
    fully settle (planner empty, workers idle, DB drained).
-   `assertNoReactiveTaskErrors` — catch silent failures a handler logged
    but never threw up the stack.
-   `configureForTesting` — replace production debounce / polling intervals
    with testing-friendly values.
-   `WhitelistRule` — scope the above helpers to specific
    collections / documents / tasks for parallel tests.

## Cron tasks

Cron tasks expose a few helpers from the main entry point that are primarily
useful in tests. They live on the main `mongodash` module alongside the
cron API rather than under `mongodash/testing`:

### Run a task synchronously

```typescript
import { runCronTask } from 'mongodash';

it('processes pending invoices', async () => {
    await runCronTask('invoice-sweep');
    const processed = await invoices.countDocuments({ status: 'processed' });
    expect(processed).toBeGreaterThan(0);
});
```

`runCronTask(taskId)` enqueues the task and awaits its completion. It throws
if called from inside another running cron task (use
`scheduleCronTaskImmediately` / `triggerCronTask` there instead).

### Disable the scheduler

Running background cron jobs in unit tests causes non-determinism. Two
options:

```typescript
// Option A: never auto-start.
await mongodash.init({ ..., runCronTasks: false });

// Option B: stop after init.
import { stopCronTasks, startCronTasks } from 'mongodash';
stopCronTasks();
// ...
startCronTasks(); // if a test needs it back
```

Called before the first `cronTask()` registration, `stopCronTasks()` also
prevents any task from starting later in the process.

See [**Cron Tasks**](./cron-tasks.md) for the full cron reference.
