## [2.9.2](https://github.com/VaclavObornik/mongodash/compare/v2.9.1...v2.9.2) (2026-08-20)

Security patch ([#486](https://github.com/VaclavObornik/mongodash/pull/486)).

- **Prototype pollution in `watchProjection` compilation.** A reactive-task
  `watchProjection` key containing a `__proto__`, `constructor` or `prototype`
  path segment (e.g. `{'constructor.prototype.x': 1}`) polluted
  `Object.prototype` while dotted keys were unflattened. Such keys are now
  rejected at task registration with a clear error, and the unflattening walk
  only traverses own properties. Projections are developer-supplied task
  configuration, so the practical risk is limited to apps that build projection
  keys from untrusted input — upgrading is still recommended for everyone.
  Reported by Madiba Security Lab, Concordia University (Ridwan Islam).
- Dev toolchain refresh consolidating the open dependabot bumps: sinon 22,
  @types/node 26, @commitlint/cli 21, js-yaml 4.3.1, jest 30.4.2, globals
  17.11, fast-uri 3.1.5. Runtime dependencies and peer ranges are unchanged.

## [2.9.1](https://github.com/VaclavObornik/mongodash/compare/v2.9.0...v2.9.1) (2026-07-29)

Maintenance release — no library code changes ([#477](https://github.com/VaclavObornik/mongodash/pull/477)).

- Dev toolchain refresh consolidating all open dependabot bumps: TypeScript 6,
  ESLint 10, vite 8 for the dashboard build, and transitive security updates
  (undici, shell-quote, fast-uri, tar, npm, js-yaml).
- The compiled library output is byte-identical to 2.9.0 (verified by diff).
  Only the bundled dashboard HTML is rebuilt (vite 8 / rolldown); it was
  verified end-to-end at runtime.
- Runtime dependencies and peer ranges (`mongodb >=4`, `prom-client >=14`)
  are unchanged, so there is nothing to migrate.

## [2.9.0](https://github.com/VaclavObornik/mongodash/compare/v2.8.0...v2.9.0) (2026-07-28)


Production-readiness hardening across cron tasks, reactive tasks, locks and the
dashboard. Full changes are in the PR; highlights:

### ⚠️ Upgrade notes — read before deploying

Each of these replaces a silent misbehaviour with a loud one, so an app that
appeared to work on 2.8.0 can now fail fast:

1. **Invalid intervals now throw at registration.** A non-positive `cronTask`
   interval (`0`, `'0s'`, `'-1h'`) used to busy-loop a worker; it is now
   rejected. A dynamic interval (a function) that resolves to a past date is
   *not* rejected — it is nudged to run ~200ms in the future instead of
   spinning (a legitimately near occurrence is left alone, so a per-second CRON
   does not drift). A dynamic interval that throws, or returns an Invalid Date,
   is rejected at registration the same as a bad static interval. If it throws
   or returns an Invalid Date later — while rescheduling the next run after the
   task finishes — it now reports the error via `onError` and backs off ~5s,
   instead of leaving a stale `runSince` that re-runs the just-finished handler
   on every lock expiry.
   **This also covers `reactiveTaskCleanupInterval`** — a zero or negative
   value there now throws from `init()`.
2. **Invalid reactive-task filters now throw at registration.** An unsupported
   operator nested under `$and`/`$or`/`$nor` (e.g. `$elemMatch`) used to be
   accepted and then crash-loop the shared change stream at runtime.
3. **`reactiveTaskConcurrency` misconfigurations are clamped to at least 1
   worker.** `NaN`, negative, and fractional values previously started zero
   workers and processed nothing, silently; they now clamp up to 1. An
   explicit `0` is unchanged: it still starts zero workers on that instance,
   and is the supported way to run a planner-only instance (the planner and
   leader election keep running). Cron has no such escape hatch —
   `cronTaskConcurrency` always clamps to at least 1, including an explicit
   `0`.
4. **Tasks filtering on `$regex` or `$size` reconcile once on first start.**
   Those operators now compile to type-guarded expressions (so a missing or
   mistyped field no longer aborts the whole pipeline). The compiled filter is
   what the evolution check fingerprints, so the change reads as a trigger-config
   change and queues one full source-collection reconciliation per affected
   task. It is idempotent and correctness-safe, but on very large collections
   it is a real scan — and it stacks with the leader-lock note below. To skip
   it, register those tasks with `evolution: { reconcileOnTriggerChange: false }`
   for the first 2.9.0 deploy.
5. **Dashboard/operational-API pagination is capped at 500 items per page.**
   `OperationalTaskController`'s list endpoints (used by the bundled dashboard)
   now clamp `limit` to the range 1–500, and `limit=0` no longer means
   "unlimited" — it falls back to the default page size (50) instead. The
   public `getReactiveTasks()` / `getCronTasksList()` functions are unchanged.

**Pre-2.3.1 upgraders:** task records written before 2.3.1 (`scheduledAt` /
`initialScheduledAt`) are migrated once, by the leader, to `nextRunAt` / `dueAt`
— without this they are invisible to the poller and never run again. Terminal
(completed/failed) records are explicitly parked with `nextRunAt: null` so they
are **not** replayed. The migration is tracked per task collection, so a
collection whose tasks are only registered on some instances is still migrated
once one of those instances becomes leader.

Prefer stopping pre-2.3.1 instances before starting 2.9.0 ones: during a mixed
rolling window an old instance can rewrite the legacy fields on an
already-migrated record, which the migration will not revisit. If that happens,
re-run it for a collection by removing its marker —
`db.<globals>.updateOne({ _id: '_mongodash_planner_meta' }, { $pull: { legacyMigratedCollections: '<collection>_tasks' } })`
— and restart the leader.

**Downgrading:** 2.9.0 → 2.8.x is safe (2.8.x already reads `nextRunAt`/`dueAt`).
Downgrading below 2.3.0 after the migration has run is **not** — those versions
read `scheduledAt`, which the migration removed, so every task record would be
stranded.

### Bug Fixes

* **reactive-tasks:** preserve Date/ObjectId/BSON values in the change-stream watch pipeline (new documents with such filter values were silently never planned)
* **reactive-tasks:** guard type-strict filter operators ($size/$regex) and fail fast on unsupported operators nested under $and/$or/$nor instead of crash-looping the change stream
* **reactive-tasks:** key the change-stream batch by collection+_id (cross-collection _id collisions no longer drop a task); serialize flushes so a heartbeat cannot advance the resume token past un-planned events
* **reactive-tasks:** CAS guards on finalize/defer prevent a completed task being reverted and re-run; a status-aware, leader-run migration heals pre-2.3.1 records (`scheduledAt`→`nextRunAt`) that would otherwise never run, while parking terminal records so they are never replayed
* **reactive-tasks:** `hasError:false` now matches completed tasks; queue-depth/lag gauges reset so drained queues stop firing false alerts
* **reactive-tasks:** workers never claim a task record that is already in a terminal status (`completed`/`failed`), closing a mixed-version race
* **reactive-tasks:** reconciliation self-heals a legacy (pre-2.3.1) record even after the one-time migration has already run for that collection
* **reactive-tasks:** the one-time legacy migration now reports its own `CODE_REACTIVE_TASK_LEGACY_MIGRATION` event code instead of reusing `CODE_REACTIVE_TASK_PLANNER_STARTED`
* **reactive-tasks:** a transactional `markCompleted()` followed by `deferCurrent()` no longer drops the pending success metric sample
* **leader-elector:** release the lock when leader startup fails (no cluster-wide planning halt) and synchronize stop with an in-flight election
* **cron:** a transient index-creation failure no longer permanently wedges the scheduler; reject non-positive intervals that would hot-loop a worker
* **concurrent-runner:** clamp misconfigured concurrency (NaN/negative/fractional) to at least one worker; an explicit `0` still runs no workers, unchanged
* **api:** retryable `init()`, self-healing `withLock` index setup, crash-safe async error handlers, single-fire post-commit hooks on transaction retry
* **api:** dashboard hardened against path traversal, unbounded request bodies, and file-read crashes
* **api:** `init()` failing after the point of no retry now rejects pending `cronTask`/`reactiveTask` registrations with the real error, instead of leaving them awaiting `initPromise` forever

## [1.7.1](https://github.com/VaclavObornik/mongodash/compare/v1.7.0...v1.7.1) (2025-12-27)


### Bug Fixes

* update user update handler to use docId instead of doc ([527307f](https://github.com/VaclavObornik/mongodash/commit/527307f344844f13fdd3ad2d8209193bd7e79f98))

# [1.7.0](https://github.com/VaclavObornik/mongodash/compare/v1.6.1...v1.7.0) (2025-12-27)


### Bug Fixes

* update README for improved task handler documentation ([1a3da53](https://github.com/VaclavObornik/mongodash/commit/1a3da53a973fccccdae2a556df23317d5187c9a1))


### Features

* add logo to header and update image references ([8ff1442](https://github.com/VaclavObornik/mongodash/commit/8ff144236f5742a1edf04d31ef7eb61a31995388))

## [1.6.1](https://github.com/VaclavObornik/mongodash/compare/v1.6.0...v1.6.1) (2025-12-27)


### Bug Fixes

* update docs for github ([20f7cfb](https://github.com/VaclavObornik/mongodash/commit/20f7cfb7bab22235259d12e302f698bad44eaa82))

# [1.6.0](https://github.com/VaclavObornik/mongodash/compare/v1.5.0...v1.6.0) (2025-12-27)


### Bug Fixes

* ensure post-commit hooks can only be registered within active transactions ([97dbd29](https://github.com/VaclavObornik/mongodash/commit/97dbd29763f1d8f97b1b0f85be99886840183a48))


### Features

* reactive  tasks ([601d3d3](https://github.com/VaclavObornik/mongodash/commit/601d3d3dfcc3f977451ccbe02714051b08c65067))

## [1.4.2](https://github.com/VaclavObornik/mongodash/compare/v1.4.1...v1.4.2) (2022-06-16)


### Bug Fixes

* bump minimist from 1.2.5 to 1.2.6 ([6d01a40](https://github.com/VaclavObornik/mongodash/commit/6d01a40cf96d6170e77d3461835c4ffd852fe466))

## [1.4.1](https://github.com/VaclavObornik/mongodash/compare/v1.4.0...v1.4.1) (2022-02-25)


### Bug Fixes

* **cronTask:** lower chance to stuck infinite task ([2ad6a1d](https://github.com/VaclavObornik/mongodash/commit/2ad6a1d774d76a225e68f0475d924059fa60c122))

# [1.4.0](https://github.com/VaclavObornik/mongodash/compare/v1.3.1...v1.4.0) (2022-01-29)


### Features

* **cronTask:** support of cronTaskCaller option to allow usage like correlationId ([a67226c](https://github.com/VaclavObornik/mongodash/commit/a67226cd20edb778baf5c3cf0b19f22110a8f811))

## [1.3.1](https://github.com/VaclavObornik/mongodash/compare/v1.3.0...v1.3.1) (2022-01-16)


### Bug Fixes

* bump debug from 4.3.2 to 4.3.3 ([beef1c2](https://github.com/VaclavObornik/mongodash/commit/beef1c201de003f8e2a399ba98a82fa40cfa6c3b))

# [1.3.0](https://github.com/VaclavObornik/mongodash/compare/v1.2.0...v1.3.0) (2021-12-15)


### Features

* added duration to CRON info ([5d5ff8e](https://github.com/VaclavObornik/mongodash/commit/5d5ff8e4a625002eaf3d6ba55b63051999d12381))

# [1.2.0](https://github.com/VaclavObornik/mongodash/compare/v1.1.1...v1.2.0) (2021-12-15)


### Features

* added onInfo option for convenient logging ([5f8c45a](https://github.com/VaclavObornik/mongodash/commit/5f8c45afcfbabb824310573d99231d42480a4ff5))
* typescript update ([37b466d](https://github.com/VaclavObornik/mongodash/commit/37b466db1f90d88d9f6f5aa40a616a26fb51a2ee))

## [1.1.1](https://github.com/VaclavObornik/mongodash/compare/v1.1.0...v1.1.1) (2021-12-14)


### Bug Fixes

* bump cron-parser from 3.5.0 to 4.2.0 ([0bb7e37](https://github.com/VaclavObornik/mongodash/commit/0bb7e37042d61c39e2d1287b9c4d6543b3f3827b))

# [1.1.0](https://github.com/VaclavObornik/mongodash/compare/v1.0.2...v1.1.0) (2021-12-13)


### Features

* cron task registration can be called before monogdash.init ([181747d](https://github.com/VaclavObornik/mongodash/commit/181747ddd7a1dbba7671561bc3e49ae0eddb3ee0))
* isLockAlreadyAcquiredError function introduced ([2741bff](https://github.com/VaclavObornik/mongodash/commit/2741bffbfcc7858175fbff8ea62ffb0f42af4a86))
* WithLockOptions exported ([7a6443a](https://github.com/VaclavObornik/mongodash/commit/7a6443a568bffa60fff852bf1c072938bdf20481))

## [1.0.2](https://github.com/VaclavObornik/mongodash/compare/v1.0.1...v1.0.2) (2021-12-06)


### Bug Fixes

* type update update ([c56f973](https://github.com/VaclavObornik/mongodash/commit/c56f97325131b011aa7d0e7f1b95bf5ce3dbf527))

## [1.0.1](https://github.com/VaclavObornik/mongodash/compare/v1.0.0...v1.0.1) (2021-08-27)


### Bug Fixes

* added ES Module Entrypoint ([9899de6](https://github.com/VaclavObornik/mongodash/commit/9899de6d3a93b2de915a33f9fc05ec1c2f68b1a6))

## [0.10.8](https://github.com/VaclavObornik/mongodash/compare/v0.10.7...v0.10.8) (2021-08-27)


### Bug Fixes

* typescript problems after tsc upgrade ([21262b2](https://github.com/VaclavObornik/mongodash/commit/21262b2ec1160914e8796d595c461beea828b58e))

## [0.10.7](https://github.com/VaclavObornik/mongodash/compare/v0.10.6...v0.10.7) (2021-07-31)


### Bug Fixes

* withLock can calculate last possible attempt in more accurate way ([f4dffbe](https://github.com/VaclavObornik/mongodash/commit/f4dffbe5521b0b834ddc2a4af975caa31f2ae127))

## [0.10.6](https://github.com/VaclavObornik/mongodash/compare/v0.10.5...v0.10.6) (2021-07-30)


### Bug Fixes

* run test in band to increase stability ([4c8c24a](https://github.com/VaclavObornik/mongodash/commit/4c8c24a0ab33fcc19e5c9e08ce5892dff3630980))

## [0.10.5](https://github.com/VaclavObornik/mongodash/compare/v0.10.4...v0.10.5) (2021-07-30)


### Bug Fixes

* stabilized tests and max wait time for withLock ([86c6e2d](https://github.com/VaclavObornik/mongodash/commit/86c6e2d27d153c609586731776cc5a0a8ae37d81))

## [0.10.4](https://github.com/VaclavObornik/mongodash/compare/v0.10.3...v0.10.4) (2021-07-26)


### Bug Fixes

* added tests for withLock function ([dae54b2](https://github.com/VaclavObornik/mongodash/commit/dae54b23e9a2d4ad5277b8fb43ede1c586526b40))

## [0.10.3](https://github.com/VaclavObornik/mongodash/compare/v0.10.2...v0.10.3) (2021-07-26)


### Bug Fixes

* unified readme styles ([7f153e6](https://github.com/VaclavObornik/mongodash/commit/7f153e6f09d791296793991dcfdbfab0a7d10277))
* updated Readme badges ([e0a4071](https://github.com/VaclavObornik/mongodash/commit/e0a4071cfb1f5a358bfd710bd82dc348b2ee72fa))

## [0.10.2](https://github.com/VaclavObornik/mongodash/compare/v0.10.1...v0.10.2) (2021-07-26)


### Bug Fixes

* updated Readme ([77f42e0](https://github.com/VaclavObornik/mongodash/commit/77f42e04af577225394f6223a6efec1308d45997))

## [0.10.1](https://github.com/VaclavObornik/mongodash/compare/v0.10.0...v0.10.1) (2021-07-26)


### Bug Fixes

* added package.json keywords ([c6ac7d1](https://github.com/VaclavObornik/mongodash/commit/c6ac7d11a19b72dbb58d13135be058f4430522c7))

# [0.10.0](https://github.com/VaclavObornik/mongodash/compare/v0.9.7...v0.10.0) (2021-07-24)


### Features

* **mongodb driver version:** peer dependency updated to mongodb@4 ([c4ce719](https://github.com/VaclavObornik/mongodash/commit/c4ce7193b81b80f44eb2d1033c5ed8ad07004b36))

## [0.9.7](https://github.com/VaclavObornik/mongodash/compare/v0.9.6...v0.9.7) (2021-07-14)


### Bug Fixes

* updated mongodb compatible version ([a21d549](https://github.com/VaclavObornik/mongodash/commit/a21d549d24d69f9d93f8df4fc83c13ddf6d575d3))

## [0.9.1](https://github.com/VaclavObornik/mongodash/compare/v0.9.0...v0.9.1) (2021-07-08)


### Bug Fixes

* substitute missing dependency for range-random by oneliner ([81d8e86](https://github.com/VaclavObornik/mongodash/commit/81d8e861318fbdbcc5342ad23b11700baba11e7c))
