# Reactive Tasks TODOs

- [ ] Also consider the withTransaction option - probably no need for the loading of dovument but it should allow to persis the finalized task in the transaction...
Or just support custom "consumer" function caller to support all of this?
- [ ] ??? Priority Queuing: Support for task priority (e.g. `priority: 10`) to process urgent tasks first.
- [ ] ??? Rate Limiting: Implement Token Bucket or Leaky Bucket algorithm for strict rate limiting (e.g. "Max 50 tasks/sec") beyond simple concurrency.
- [ ] ??? Sharded Listener: Support for multiple/sharded change stream listeners to overcome the single-leader ingestion bottleneck for massive scale.
