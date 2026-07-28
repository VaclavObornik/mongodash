# CLAUDE.md — mongodash

Working notes for future Claude sessions. Written from the 2.7.0 refactor
(PR #460).

## Quick start for a fresh session

```bash
# 1. MongoDB replica set (required: change streams + transactions).
docker run -d --name mongodash-test-mongo -p 27017:27017 \
    mongo:7 --replSet rs0 --bind_ip_all
docker exec mongodash-test-mongo mongosh --quiet --eval \
    "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"

# 2. Run any test (mind the env var).
MONGODB_URI="mongodb://127.0.0.1:27017/mongodashTesting?replicaSet=rs0" \
    npx jest --forceExit --runInBand test/<path>
```

Tests fail with `TransactionError` or stream errors without a replica set.
`npm test` runs lint + coverage + publint/attw and is slow; use `test:simple`
during iteration.

## Architecture at a glance

Two task subsystems, both share `ConcurrentRunner` as the worker pool:

- **Cron tasks** (`src/cronTasks.ts`) — scheduled jobs keyed by `taskId`.
  - Single scheduler: `ConcurrentRunner` for all concurrencies. The
    default `cronTaskConcurrency=1` spawns one worker; higher values
    spawn more. Per-task serialisation is enforced via the DB
    `lockedTill` lock, so concurrency never causes a single task to
    double-run.
  - `runnerStopPromise` prevents rapid stop+start from leaving the runner
    wedged (runnerStarted=true but no live workers). ensureStarted chains
    on a pending stop before firing a new start.
  - `ConcurrentRunner.start()` resets each source's nextRunAt +
    currentBackoff, and `setNextRunAt()` no-ops if nextRunAt is already
    <= now (preserves a concurrent speedUp). `runATask` therefore
    does not need caller-side race workarounds; see the
    "refactor(concurrent-runner): close three scheduler races" commit.

- **Reactive tasks** (`src/reactiveTasks/`) — change-stream driven.
  - `LeaderElector` → `Planner` (change stream + batching + reconciliation)
    → `Worker` (polls via `ConcurrentRunner`) → `Repository` (DB).
  - `_scheduler` module export is `@internal` (dashboard uses it) — keep it.
  - `REACTIVE_TASK_META_DOC_ID` is `@internal` too.

### Key invariants that are easy to break

1. **`stopCronTasks` return type must stay `void`** — users passed it where
   `() => void` is expected. The internal parallel-runner stop is
   fire-and-forget via `runnerStopPromise`.

2. **`ConcurrentRunner.setNextRunAt()` never pushes an already-due
   source back into the future.** If `state.nextRunAt` is already
   `<= now`, the write is skipped. A worker that finishes a poll and
   calls `setNextRunAt(now + waitMs)` based on a stale query must not
   overwrite a concurrent `speedUp()` that happened during the query.
   Combined with the `resolved`-guarded re-check at the top of
   `sleep()` and the source reset in `start()`, the runner absorbs the
   three races that previously forced caller workarounds (cron used
   two, see the "close three scheduler races" commit).

3. **`createContinuousLock` CAS mode** uses `expectedInitialValue` +
   `onLockLost`. Worker passes `taskRecord.nextRunAt`; CAS detects
   another worker stealing the visibility lock. **Without CAS the default
   behavior is unchanged** — other callers (cronTasks, withLock) pass no
   options and get the legacy unconditional-update semantics.

4. **`finalizeTask` CAS on `startedAt`** — returns `boolean` (`matchedCount > 0`).
   The worker treats `false` as a silent lock loss: bumps
   `reactive_tasks_lock_lost_total`, emits `CODE_REACTIVE_TASK_LOCK_LOST`,
   skips further writes. Metrics are still recorded eagerly **before**
   the finalize write (so scrapes between handler return and CAS are
   consistent).

5. **Planner `lastFlushFailed` flag** — cleared only in `startChangeStream`
   (when the stream restarts). A later successful flush must not advance
   the resume token past events from a still-unreplayed failed batch.

6. **Leader re-election counter inflation** — `forceLoseLeader` flips
   `_isLeader` to false + fires `onLoseLeader`, but does NOT release the
   DB lock. The next heartbeat re-acquires, fires `onBecomeLeader`, which
   bumps `reactive_tasks_leader_elections_total`. Counted as a design
   tradeoff: cross-correlate with `stream_errors` / `flush_failures`
   counters to tell "real flapping" from restart-driven transitions.

## Public API surface

Keep this list in sync when adding/removing exports:

Root `mongodash`:
- Reactive: `reactiveTask`, `startReactiveTasks`, `stopReactiveTasks`,
  `getReactiveTasks`, `countReactiveTasks`, `retryReactiveTasks`,
  `getPrometheusMetrics`, plus types: `ReactiveTask`, `ReactiveTaskHandler`,
  `ReactiveTaskRecord`, `ReactiveTaskStatus`, `ReactiveTaskQuery`,
  `PagedResult`, `PaginationOptions`, `TaskConditionFailedError`,
  `_scheduler` (@internal).
- Cron: `cronTask`, `startCronTasks`, `stopCronTasks` (**void!**),
  `runCronTask` (awaits completion, test helper),
  `scheduleCronTaskImmediately`, `triggerCronTask` (**@deprecated** alias),
  `getCronTasksList`, `getRegisteredCronTaskIds`.
- Lock: `withLock`, `LockAlreadyAcquiredError`, `isLockAlreadyAcquiredError`,
  `WithLockOptions`.
- Transaction: `withTransaction`, `PostCommitHook`, `registerPostCommitHook`.
- Utility: `processInBatches`, `getCollection`, `getMongoClient`,
  `OperationalTaskController`, `serveDashboard`.
- Event codes: `CODE_REACTIVE_TASK_*` (many), `CODE_CRON_TASK_*` (4).
  Every emitted code must be an exported constant - do not emit bare string
  literals (2.9.0 promoted `CODE_REACTIVE_TASK_THREW_AFTER_COMPLETION` and
  `CODE_REACTIVE_TASK_DEFER_IGNORED` for exactly this reason).

Subpath `mongodash/testing`:
- `waitUntil` (generic poller), `waitUntilReactiveTasksIdle`,
  `assertNoReactiveTaskErrors`, `configureForTesting`,
  `resolveWhitelistFilter`, `WhitelistRule`.

Package resolution tricks:
- `exports` map has both `.` and `./testing` with `types`/`import`/`default`.
- `typesVersions` mirrors `./testing` for node10 compat (attw would fail
  otherwise).

## Build / ESM pitfalls

### Dashboard vue-tsc will compile your src transitively

`dashboard/tsconfig.json` has:
- `include: [..., "../src/task-management/types.ts"]`
- `paths: { "@shared/*": ["../src/task-management/*"] }`
- `moduleResolution: "bundler"`, `isolatedModules: true`

`task-management/types.ts` imports `CronTaskRecord` from `../cronTasks`,
which imports `ConcurrentRunner`, which imports `debug`. vue-tsc in
strict bundler mode **rejects** `import * as _debug from 'debug'`
(namespace object is not callable).

→ **`ConcurrentRunner.ts` uses `require('debug')` by design.** Do not
"unify" the debug import style across the codebase without checking the
dashboard build (`cd dashboard && npm run build`). Other files can keep
`import * as _debug` because they are not in the dashboard's compile
graph.

### Docs subpath (`mongodash/testing`)

Needs both the `./testing` export block and the `typesVersions` fallback
for Node10. Attw runs in `npm run test:exports` and will fail CI
otherwise.

## Testing conventions

- `test/**/*.ts` is picked up by regex; `testHelpers.ts` /
  `testHelpersReactive.ts` are explicitly excluded. Some test files
  legacy-named without `.test.ts` (`LeaderElector.ts`, etc.) —
  **don't rename for "consistency"**, just churn.
- `getNewInstance()` resets modules and returns a fresh `mongodash` import
  with hooks (`setOnError`, `cleanUpInstance`, `initInstance`). Always
  `await instance.cleanUpInstance()` in `afterEach` or `afterAll`.
- `getTestingTask(handler?)` + `waitForNextRun()` is the legacy cron test
  idiom, still used by `cronTasks.races.regression.ts`.
  `createReusableWaitableStub` is the reactive-task equivalent.
- For reactive tests that need a faster debounce, pass
  `reactiveTaskConcurrency: N, minBatchIntervalMs: 10, minPollMs: 10`
  via `initInstance` (note: internal options go through `as any`).
- Replace fixed `wait(Xms)` with `waitUntil(fn, {timeoutMs})` polling.

### Cron test files (post 2.7.0 test refactor)

- `test/cronTasks.scheduling.ts` — interval / CRON / duration registration
  semantics. Pure behaviour, no fake timers.
- `test/cronTasks.behavior.ts` — public contract (registration,
  runImmediately precedence, processing, stop/start lifecycle,
  runCronTask, scheduleCronTaskImmediately, onInfo + correlationId).
  Real time, polled via `waitUntil`; no driver stubs.
- `test/cronTasks.parallel.ts` — `cronTaskConcurrency > 1` path.
  Includes a serial-baseline sanity-check and the pendingWake /
  runnerStopPromise regressions observed via public API.
- `test/cronTasks.races.regression.ts` — implementation-aware invariants
  (idle-DB, index/query-plan/projection, lock prolong + mid-prolong
  race, revert-on-cancel, DB fault tolerance). **These intentionally
  use `sandbox.useFakeTimers` + `sinon.stub(collection, …)`** — each
  `it` has a JSDoc banner describing the invariant it pins.

Before refactoring the cron scheduler, run all four files and verify
green. Behaviour files are resilient to internal timing changes;
regression file failures are a signal the change hit a known invariant
and needs analysis.

### Known flakes (as of 2.7.0)

- `test/reactiveTasks/lockRenewal.test.ts` — times out on CI in some
  Node×driver×server combos. Pre-existing on master. Not critical path.
- `test/withLock.ts` timing assertions on 500ms — slow CI tips over.
- **Docker Hub rate limits** occasionally fail `supercharge/mongodb-
  github-action` with "toomanyrequests". Not a code bug, just rerun.

## Git / commit conventions

- **commitlint rules** enforce:
  - Lowercase type (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`,
    `ci`, `perf`, `revert`, `style`, `build`, `breaking`).
  - Lowercase scope.
  - No sentence-case/pascal-case/uppercase subject.
  - No trailing period in subject.
  - 100 char header max.
- **Scopes actually used**: `reactive-tasks`, `cron`, `deps`, `testing`,
  `docs`, `api`, `concurrent-runner`, `leader-elector`. Match existing
  scopes when possible.
- Husky pre-commit runs lint-staged (organize-imports + prettier).
- Husky commit-msg runs commitlint. If it fails, rewrite the commit
  message — don't `--no-verify`.

## Release pipeline

- Merge to `master` triggers `.github/workflows/release.yml`.
- Uses `JS-DevTools/npm-publish@v1` — expects `NPM_TOKEN` secret.
- **Must be Automation token type** (not "Publish" or granular without
  bypass-2FA). Otherwise fails with `EOTP`.
- If the npmjs profile is on "strict 2FA" mode, even Automation tokens
  fail — user has to switch to "Auth only" mode in npm settings.
- `semantic-release` dependency is installed but not the actual release
  mechanism; the workflow publishes directly.

## Review / CI workflow cheatsheet

Copilot review loop (works well for PRs with non-trivial surface):

```bash
# Re-request Copilot review after push
gh api repos/OWNER/REPO/pulls/NUM/requested_reviewers \
    -f "reviewers[]=copilot-pull-request-reviewer[bot]"

# List unresolved threads
gh api graphql -f query='{ repository(owner:"O",name:"R"){ pullRequest(number:N){ reviewThreads(first:50){ nodes{ id isResolved path line comments(first:1){ nodes{ body } } } } } } }' \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]
          | select(.isResolved == false) | .id'

# Resolve a thread
gh api graphql -f query='mutation{ resolveReviewThread(input:{threadId:"ID"}){ thread{ isResolved } } }'
```

Typical pattern: push → wait ~3 min → fetch unresolved threads →
evaluate each (accept/reject with reasoning) → commit fixes → resolve
threads → rerequest. Expect 5–10 rounds on large refactors; Copilot does
converge.

Flaky CI jobs: `gh run rerun <run-id> --failed` is the friend.

## Non-obvious code locations

- **Task filter preprocessing**: `src/reactiveTasks/validateTaskFilter.ts`
  normalises user filters; `queryToExpression.ts` translates MongoDB
  query operators (`$in`, `$eq`, etc.) into aggregation expressions.
- **Watch projection compilation**: `src/reactiveTasks/compileWatchProjection.ts`
  turns `{ foo: 1, 'bar.baz': 1 }` into `$project`-friendly paths. Memoised
  via `WeakMap` keyed on the projection object — reuse the same projection
  object instance across calls to hit the cache.
- **Reconciliation**: `ReactiveTaskReconciler.ts`. Runs on planner start
  and after oplog loss (error 280). Uses `processInBatches` to scan source
  collections and plan tasks for each match.
- **Metrics**: `MetricsCollector.ts`. `cluster` vs `local` scrape modes.
  Leader pushes global stats to `reactive_tasks_metrics_registry` doc so
  followers can serve complete metrics during an LB scrape.

## Things I deliberately did NOT do

Recorded so nobody re-debates them next time:

1. **Did not reorganize `src/` into `/infra` vs `/features`.** Interior
   structure doesn't affect the public surface; high-risk diff for zero
   user benefit.
2. **Did not introduce `MongodashError` base class.** Existing
   `instanceof Error` checks work; adding a base class would imply moving
   `TaskConditionFailedError` and `LockAlreadyAcquiredError` which their
   users reference by exact class.
3. **Did not convert the flat API to namespaces (`CronTasks.trigger()`).**
   Breaking. No discovery win over autocomplete on flat exports.
4. **Did not remove `_scheduler` export.** The bundled
   `OperationalTaskController` uses it; external users may too. Marked
   `@internal` only.
5. **Did not rename legacy test files** without `.test.ts` suffix. Pure
   churn — the regex picks them up correctly.
6. **Did not add mutation testing to CI.** The `test:stryker` script
   exists for manual pre-release runs; wiring it into every PR would
   double or triple CI time.
