# Core Concepts

## Architecture

The system uses a **Leader-Worker** architecture to balance efficiency and scalability.

### The Leader (Planner)
-   **Role**: A single instance is elected as the **Leader**.
-   **Responsibility**: It listens to the MongoDB Change Stream, calculates the necessary tasks (based on `watchProjection`), and persists them into the `_tasks` collection. To minimize memory usage, it only fetches the document `_id` from the Change Stream event.
    > [!NOTE]
    > **Database Resolution**: The Change Stream is established on the database of the **first registered reactive task**.
-   **Resilience**: Leadership is maintained via a distributed lock with a heartbeat. If the leader crashes, another instance automatically takes over (Failover).

### The Workers (Executors)
-   **Role**: *Every* instance (including the leader) runs a set of **Worker** threads (managed by the event loop).
-   **Responsibility**: Workers poll the `_tasks` collection for `pending` jobs, lock them, and execute the `handler`.
-   **Adaptive Polling**: Workers use an **adaptive polling** mechanism.
    -   **Idle**: If no tasks are found, the polling frequency automatically lowers (saves CPU/IO).
    -   **Busy**: If tasks are found (or the **local** Leader signals new work), the frequency speeds up immediately to process the queue as fast as possible. Workers on other instances will speed up once they independently find a task during their regular polling.



## Change Detection and Storage Optimization

To ensure reliability and efficiency, the system needs to determine *when* to trigger a task.

**How it works:**
1.  **State Persistence**: For every source document, a corresponding "task document" is stored in the `[collection]_tasks` collection.
2.  **Snapshotting**: This task document holds a snapshot of the source document's fields (specifically, the result of `watchProjection`).
3.  **Diffing**: When an event occurs (or during [reconciliation](./reconciliation.md)), the system compares the current state of the document against the stored snapshot (`lastObservedValues`).
4.  **No-Op**: If the watched fields haven't changed, **no task is triggered**. This guarantees reliability and prevents redundant processing.

**Storage Implications:**
-   **Task Persistence**: The task document remains in the `_tasks` collection as long as the source document exists. It is only removed when the source document is deleted.
-   **Optimization**: If `watchProjection` is **not defined**, the system copies the **entire source document** into the task document.
-   **Recommendation**: For collections with **large documents** or **large datasets**, always define `watchProjection`. This significantly reduces storage usage and improves performance by copying only the necessary data subset.
-   **Tip**: If you want to trigger the task on *any* change but avoid storing the full document, watch a versioning field like `updatedAt`, `lastModifiedAt`, or `_version`.
    ```typescript
    // Triggers on any update (assuming your app updates 'updatedAt'), 
    // but stores ONLY the 'updatedAt' date in the tasks collection.
    watchProjection: { updatedAt: 1 } 
    ```



## Task Lifecycle (States)

Every task record in the `_tasks` collection follows a specific lifecycle:

| Status | Description |
| :--- | :--- |
| `pending` | Task is waiting to be processed by a worker. This is the initial state after scheduling or a re-trigger. |
| `processing` | Task is currently locked and being worked on by an active worker instance. |
| `processing_dirty` | **Concurrency Guard.** New data was detected while the worker was already processing the previous state. The task will be reset to `pending` immediately after the current run finishes to ensure no updates are missed. |
| `completed` | Task was processed successfully or it was not matching the filter during the last attempt. |
| `failed` | Task permanently failed after exceeding all [retries](./policy-retry.md) or the `maxDuration` window. |





## Task Schema

Each reactive task is stored as a document in the `[collection]_tasks` collection. Key fields include:

-   `task`: The task name.
-   `sourceDocId`: The `_id` of the source document.
-   `status`: Current state (`pending`, `processing`, `completed`, `failed`).
-   `nextRunAt`: **Core Scheduling Field**.
    -   For `pending` tasks: The time when the task is eligible to run (includes delays/backoff).
    -   For `processing` tasks: The time when the processing lock expires (visibility timeout).
    -   For `completed`/`failed` tasks: `null` (removed from the polling index).
-   `dueAt` (formerly `initialScheduledAt`): The **Original Scheduled Time**.
    -   This value is static and represents when the task *should* have run primarily.
    -   It is used for calculating **Lag** metrics (SLA monitoring) and does not change during retries or backoffs.
-   `attempts`: Number of execution attempts (including the first one).
-   `lastError`: The error message from the last failure (if any).
