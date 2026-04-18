# Testing Reactive Tasks

Testing asynchronous, event-driven workflows is notoriously hard: the "done"
state is not a return value from the code you called but a quiescent state of
a background system. Mongodash ships with helpers that address this directly.

> [!TIP]
> For the generic polling helper (not tied to reactive tasks), see
> [**`waitUntil`**](../testing.md).

## `waitUntilReactiveTasksIdle`

Blocks until the reactive-task subsystem is completely quiesced. This is
essential for end-to-end tests where you want to assert the final state after
a chain of cascading tasks has settled.

### What it waits for

It resolves only when **all** of the following validation checks pass
simultaneously (and remain true for `stabilityDurationMs`):

1.  **Planner empty** — the internal `ReactiveTaskPlanner` has no buffered
    change-stream events waiting to be flushed.
2.  **Workers idle** — no `ReactiveTaskWorker` is currently processing a task
    (active count is 0).
3.  **Database settled** — no tasks in any registered task collection are in
    `pending`, `processing`, or `processing_dirty` state.
    -   **Exception**: pending tasks scheduled for the _distant future_
        (beyond the current `timeoutMs + stabilityDurationMs + 100ms`) are
        ignored, so long retries (e.g. "retry in 1 hour") do not block your
        test forever.

### Usage

```typescript
import { waitUntilReactiveTasksIdle } from 'mongodash/testing';

it('should process user registration workflow', async () => {
    // 1. Trigger the workflow
    await users.insertOne({ email: 'test@example.com', status: 'new' });

    // 2. Wait for the reactive task to process the insert AND any cascading
    //    tasks it may have triggered (welcome email, provisioning, etc.)
    await waitUntilReactiveTasksIdle();

    // 3. Assert the final state
    const emailTask = await emailTasks.findOne({ email: 'test@example.com' });
    expect(emailTask).toBeDefined();
    expect(emailTask.status).toBe('sent');
});
```

### Configuration

Defaults are tuned for general use; override as needed:

```typescript
await waitUntilReactiveTasksIdle({
    timeoutMs: 30000,
    stabilityDurationMs: 200, // 200ms of "silence" to catch in-flight cascading tasks
});
```

### Isolation with `whitelist`

When running tests in parallel against a shared database, use `whitelist` to
wait only for tasks that belong to this test. In whitelist mode the **active
workers** check is skipped so another test's worker pool does not block you;
the planner buffer check is still applied (otherwise we could return idle
before a change event we care about has even been turned into a task row).

```typescript
await waitUntilReactiveTasksIdle({
    whitelist: [
        { collection: 'users', filter: { _id: userId } }, // specific user
        { collection: 'orders', task: 'processOrder' },   // specific task on collection
    ],
});
```

> [!NOTE]
> The idle check queries task records by `sourceDocId`. If your trigger is
> very fast (e.g. a write immediately followed by `waitUntilReactiveTasksIdle`)
> and the default `stabilityDurationMs` is low, you may need to raise
> `stabilityDurationMs` to ensure the planner has had a chance to flush the
> event into a task record. Alternatively, poll with `waitUntil` for the
> task record to exist first, then call `waitUntilReactiveTasksIdle`.

## `assertNoReactiveTaskErrors`

Catches "silent failures" — tasks that threw and were logged but never
propagated to the test as an assertion error.

### Features

-   **Time filtering** — only checks for errors that occurred after a given
    `since` timestamp (typically test start).
-   **Scope** — check globally or limit to specific source documents / task
    names via `whitelist`.
-   **Exclusions** — allow known errors (string or regex) without failing the
    test.

### Usage

```typescript
import { assertNoReactiveTaskErrors } from 'mongodash/testing';

it('should process successfully', async () => {
    const startTime = new Date();

    // ... run test steps ...
    await waitUntilReactiveTasksIdle();

    await assertNoReactiveTaskErrors({ since: startTime });
});
```

### Options

```typescript
await assertNoReactiveTaskErrors({
    since: startTime, // required
    whitelist: [{
        collection: 'users',
        filter: { _id: userId },
    }],
    excludeErrors: [
        'Expected Failure',
        /Authorization Error/,
    ],
});
```

## `configureForTesting`

Production defaults (`debounce: 1000ms`, `minPollMs: 200ms`, etc.) are tuned
for real workloads but make tests unnecessarily slow. `configureForTesting`
overrides these globally with minimal values (typically `10ms`).

Call it **once** in your test setup (`jest.setup.js`, `beforeAll`, etc.). It
works whether called before or after task registration.

```typescript
import { configureForTesting } from 'mongodash/testing';

beforeAll(() => {
    configureForTesting();
});
```

### Options

```typescript
configureForTesting({
    debounce: 0,        // 0ms debounce (immediate planning)
    minPollMs: 50,      // polling interval
    minBatchIntervalMs: 50,
});
```

## Whitelist rules

`waitUntilReactiveTasksIdle` and `assertNoReactiveTaskErrors` share a
`whitelist` option of type `WhitelistRule[]`. The type is exported so test
suites can share scope definitions:

```typescript
import type { WhitelistRule } from 'mongodash/testing';

const scopeToUser = (userId: string): WhitelistRule[] => [
    { collection: 'users', filter: { _id: userId } },
    { collection: 'notifications', filter: { userId } },
];

await waitUntilReactiveTasksIdle({ whitelist: scopeToUser(id) });
await assertNoReactiveTaskErrors({ since, whitelist: scopeToUser(id) });
```

Rule semantics:

-   **No `filter` and no `task`** — matches every document and every task in
    that collection ("match-all").
-   **`filter` that matches zero documents** — the rule is treated as
    "skip this collection", useful when the rule is built from a variable
    that may be empty.
-   **Multiple rules for the same collection** — OR-merged into a single
    filter. A `match-all` rule wins over others.
