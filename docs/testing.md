# Testing Utilities

Mongodash provides a set of utilities to help you write robust End-to-End (E2E) tests for your asynchronous applications.

## `waitUntilReactiveTasksIdle`

A specialized helper for testing **Reactive Tasks**. It blocks execution until the reactive task system is completely quiesced.

This is essential for testing "side effects" and "cascading tasks" where you want to assert the final state of the system after a chain of events has completed.

### What it waits for

It resolves only when **ALL** of the following validation checks pass simultaneously (or for the `stabilityDurationMs`):

1.  **Planner Empty**: The internal `ReactiveTaskPlanner` has no buffered Change Stream events waiting to be flushed.
2.  **Workers Idle**: No `ResponsiveTaskWorker` is currently processing a task (active count is 0).
3.  **Database Settled**: No tasks in any registered task collection are in `pending`, `processing`, or `processing_dirty` state.
    *   **Exception**: Pending tasks scheduled for the **distant future** (beyond the current timeout + stability window) are ignored. This ensures that long-term retries (e.g., "retry in 1 hour") do not cause your tests to timeout.

### Usage

```typescript
import { waitUntilReactiveTasksIdle } from 'mongodash/testing';

it('should process user registration workflow', async () => {
    // 1. Trigger the workflow
    await users.insertOne({ email: 'test@example.com', status: 'new' });

    // 2. Wait for the reactive task to process ONLY the insert
    //    AND any subsequent tasks that might be triggered (e.g. sending email)
    await waitUntilReactiveTasksIdle();

    // 3. Assert the final state
    const emailTask = await emailTasks.findOne({ email: 'test@example.com' });
    expect(emailTask).toBeDefined();
    expect(emailTask.status).toBe('sent');
});
```

### Configuration

You can override the default options if needed, though the defaults are tuned for general use.

```typescript
await waitUntilReactiveTasksIdle({
    timeoutMs: 30000,
    stabilityDurationMs: 200, // Wait for 200ms of "silence" to catch in-flight cascading tasks
});
```

### Isolation with Whitelist

When running parallel tests, you can use the `whitelist` option to wait only for specific tasks/collections:

```typescript
await waitUntilReactiveTasksIdle({
    whitelist: [
        { collection: 'users', filter: { _id: userId } },  // Wait for specific user
        { collection: 'orders', task: 'processOrder' },     // Wait for specific task
    ]
});

## `assertNoReactiveTaskErrors`

Ensures that no reactive tasks have failed during your test execution. This is critical for catching "silent failures" where a task failed but didn't crash the application or the test.

### Features

- **Time filtering**: Only checks for errors that occurred after a specific time (e.g., the start of your test).
- **Scope**: Can check globally or for specific source documents.
- **Filtering**: Allows ignoring "expected" errors (e.g., negative tests).

### Usage

```typescript
import { assertNoReactiveTaskErrors } from 'mongodash/testing';

it('should process successfully', async () => {
    const startTime = new Date();

    // ... run test steps ...
    await waitUntilReactiveTasksIdle();

    // Verify no tasks failed
    await assertNoReactiveTaskErrors({ since: startTime });
});
```

### Options

```typescript
await assertNoReactiveTaskErrors({
    since: startTime, // Required: Check for errors after this time
    // Optional: Only check specific tasks (ignore background noise)
    whitelist: [{
        collection: 'users',
        filter: { _id: userId }
    }],
    excludeErrors: [ // Optional: Allow known errors (strings or RegEx)
        'Expected Failure',
        /Authorization Error/
    ]
});
```

## `configureForTesting`

A helper to configure the library for fast, deterministic testing execution.

By default, the library is optimized for production scenarios (e.g. `debounce: 1000ms`, `minPollMs: 200ms`). In tests, these delays cause unnecessary slowness.

`configureForTesting` overrides these defaults globally to minimal values (e.g. `10ms`).

### Usage

Call this **once** in your global test setup (e.g. `jest.setup.js` or `beforeAll`).

It works regardless of whether you call it before or after registering your tasks.

```typescript
import { configureForTesting } from 'mongodash/testing';

beforeAll(() => {
    // Sets debounce, polling, and batching to 10ms
    configureForTesting();
});
```

### Options

You can customize specific values if needed:

```typescript
configureForTesting({
    debounce: 0,        // Force 0ms debounce (immediate execution)
    minPollMs: 50,      // Poll every 50ms
    minBatchIntervalMs: 50
});
```

## `waitUntil`

Generic helper that resolves once a condition function returns `true`. Useful when
`waitUntilReactiveTasksIdle` is too broad (for example when you need to wait for an
HTTP side effect or an external queue) or as a building block for your own testing
utilities.

It includes a built-in "time jump detector": if a breakpoint or a suspended laptop
pauses the event loop for more than a second, the deadline is extended by the
observed pause so the wait does not falsely time out.

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
| `stabilityDurationMs` | `0` | How long the condition must *remain* true before resolving. Prevents flakiness when a state briefly flips true then false. |

## Whitelist rules

Both `waitUntilReactiveTasksIdle` and `assertNoReactiveTaskErrors` accept a
`whitelist` option of type `WhitelistRule[]`. The type is exported so tests
can share whitelist definitions across suites:

```typescript
import type { WhitelistRule } from 'mongodash/testing';

const scopeToUser = (userId: string): WhitelistRule[] => [
    { collection: 'users', filter: { _id: userId } },
    { collection: 'notifications', filter: { userId } },
];

await waitUntilReactiveTasksIdle({ whitelist: scopeToUser(id) });
await assertNoReactiveTaskErrors({ since, whitelist: scopeToUser(id) });
```

A rule with neither `filter` nor `task` matches every document and every task in
that collection ("match-all"). A rule whose `filter` matches zero documents is
treated as "skip this collection" - useful when the rule is built dynamically from
a variable that may be empty.
