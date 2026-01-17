import { _scheduler } from '../reactiveTasks';

export interface ConfigureForTestingOptions {
    /**
     * Sets the debounce time for all tasks (new and existing).
     * Default: 10ms
     */
    debounce?: number;
    /**
     * Sets the minimum polling interval for source collections.
     * Default: 10ms
     */
    minPollMs?: number;
    /**
     * Sets the minimum batch processing interval options.
     * Default: 10ms
     */
    minBatchIntervalMs?: number;
}

/**
 * optimized configuration for testing environments.
 * Reduces all intervals to minimal values (10ms) to make tests run fast.
 *
 * Can be called before or after task registration.
 *
 * @param options Overrides for the default test configuration.
 */
export function configureForTesting(options: ConfigureForTestingOptions = {}): void {
    const config = {
        debounce: 10,
        minPollMs: 10,
        minBatchIntervalMs: 10,
        ...options,
    };

    // Update internal scheduler options (affecting polling and batching)
    _scheduler.updateInternalOptions({
        minPollMs: config.minPollMs,
        minBatchIntervalMs: config.minBatchIntervalMs,
    });

    // Override task defaults (affecting debounce)
    _scheduler.overrideDefaults({
        debounce: config.debounce,
    });
}
