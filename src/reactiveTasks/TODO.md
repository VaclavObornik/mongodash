# Reactive Tasks TODOs

- [x] **Instance-level Task Filtering**: Implement a mechanism to filter which tasks run on a specific instance, similar to how cron jobs can be restricted to specific environments or instances.
- [x] **Customizable Retry Policy**: Enhance the retry logic to allow for customizable timing (backoff strategies) and policies (e.g., max attempts, conditional retries) per task.
- [x] **Task execution history**
- [x] **Monitoring metrics export**
- [x] **Filtering of documents based on simple conditions too**
- [x] add a test simulating no repeat of the same document - i.e. by watching the _id field
- [x] what about the watchFields to represent just as the projection?
- [x] dead letter queue management (get, retry (filter))
The retry should be possible to be triggered for separate tasks, by targeting original documentId, any original document filter (still matching the task filter), targeting any (even processed) states to retrigger
- [x] REJECTED IDEA! dynamic filters - the filter can be a function, that might be changed during runtime - note this might be problematic in case of reconciliation!!! :/ // 
- [x] flow control - defer / throttle from inside the task. Defer just delay the task execution - another field in DB, so we count the delay against the original scheduledAt. Throttle should in-memory postpose all the task execution till a time
- [x] defer all - should be there a different default behaviour for the current task?
- [x] should the resetTask null the initialScheduledAt?
- [x] fix the typing of reactive tasks - inside the lib we don't need to know the type of the document, we just need to know the types works for outside
- [x] current deletion of tasks when document is deleted should be preserved
- [x] store progress of reconciliation
- [x] clearing of tasks that no longer match the filter??? this can be dangerous! would need to be explicitly enabled by a "clearingStrategy" option (possibly with a delay, bcs. of stats?)
- [x] simple endpoint and UI for operational task management
Properly document the reasons and proper usage - user should want to delet it only if he is sure that the filter change is permanent and the tasks are not needed anymore
- [x] add into the documentation that the reconciliation and cleaning is being done in batches
- [x] also add into the documentation that the library does not load all documents into the memory during the scheduling, only _id's
- [ ] **support "withLock" key getter**: Allow an (optional, possibly async) function to determine the lock key based on the document's `_id` and `watchedFields`. When provided, the withLock used for reading document. 
- [ ] Also consider the withTransaction option - probably no need for the loading of dovument but it should allow to persis the finalized task in the transaction...
Or just support custom "consumer" function caller to support all of this?
- [ ] ??? Priority Queuing: Support for task priority (e.g. `priority: 10`) to process urgent tasks first.
- [ ] ??? Rate Limiting: Implement Token Bucket or Leaky Bucket algorithm for strict rate limiting (e.g. "Max 50 tasks/sec") beyond simple concurrency.
- [ ] ??? Sharded Listener: Support for multiple/sharded change stream listeners to overcome the single-leader ingestion bottleneck for massive scale.
