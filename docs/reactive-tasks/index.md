# Reactive Tasks

A powerful, distributed task execution system built on top of [MongoDB Change Streams](https://www.mongodb.com/docs/manual/changeStreams/).

Reactive Tasks allow you to define background jobs that trigger automatically when your data changes. This enables **Model Data-Driven Flows**, where business logic is triggered by state changes (e.g., `status: 'paid'`) rather than explicit calls. The system handles **concurrency**, **retries**, **deduplication**, and **monitoring** out of the box.

## Features

-   **Model-Driven**: Logic follows data state, not API calls.
-   **Distributed & scalable**: Leader-follower architecture allows horizontal scaling.
-   **[Reliable Retries](./policy-retry.md)**: Configurable backoff strategies (exponential, fixed, linear) for transient failures.
-   **[Concurrency Control](./configuration.md)**: Limit parallel execution to protect downstream resources.

-   **[Deduplication](./guides.md#idempotency--re-execution)**: Automatic debouncing and task merging.
-   **[Observability](./monitoring.md)**: Built-in Prometheus metrics and Grafana dashboard.
-   **Developer Friendly**: Zero-config local development, fully typed with TypeScript.

## Reactive vs Scheduled Tasks

It is important to distinguish between Reactive Tasks and standard schedulers (like Agenda or BullMQ).

-   **Reactive Tasks (Reactors)**: Triggered by **state changes** (data). "When Order is Paid, send email". This guarantees consistency with data.
-   **Schedulers**: Triggered by **time**. "Send email at 2:00 PM".

Reactive Tasks support time-based operations via `debounce` (e.g., "Wait 1m after data change to settle") and `deferCurrent` (e.g., "Retry in 5m"), but they are fundamentally event-driven. If you need purely time-based jobs (e.g., "Daily Report" without any data change trigger), you can trigger them via a [Cron job](../cron-tasks.md), although you can model them as "Run on insert to 'daily_reports' collection".

## Advantages over Standard Messaging

Using Reactive Tasks instead of a traditional message broker (RabbitMQ, Kafka) provides distinct architectural benefits:

1.  **Lean Stack & Simplified DevOps**:
    -   Eliminates the need to manage, scale, and secure external message brokers.
    -   **Zero-Config Development**: Local testing requires only the database connection—no extra Docker containers or infrastructure to spin up.

2.  **Transactional Consistency (Solving the "Dual Write" Problem)**:
    -   *The Problem*: In standard architectures, writing to the database and publishing an event are two separate operations. If the database write succeeds but the message flush fails (network error, crash), your system enters an inconsistent state.
    -   *The Solution*: With Reactive Tasks, the "event" **is** the database write. The task is triggered electronically by the MongoDB Oplog. This guarantees that **if and only if** data is persisted, the corresponding task will be scheduled—ensuring 100% data consistency without distributed transactions.

3.  **Inspectable State**:
    -   The task queue is stored in a standard MongoDB collection (`[collection]_tasks`), not in a hidden broker queue.
    -   You can use standard tools (MongoDB Compass, Atlas Data Explorer, simple queries) to inspect pending jobs, debug failures, and analyze queue distribution without needing specialized queue management interfaces.
