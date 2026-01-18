import * as _debug from 'debug';
const debug = _debug('mongodash:testing');

export interface WaitUntilOptions {
    /**
     * Maximum time to wait for the condition to become true.
     * Default: 10000ms
     */
    timeoutMs?: number;
    /**
     * Interval between checks.
     * Default: 50ms
     */
    pollIntervalMs?: number;
    /**
     * How long the condition must remain true to be considered stable.
     * Default: 0 (no stability check)
     */
    stabilityDurationMs?: number;
}

/**
 * Waits until the provided condition function returns true.
 *
 * Includes "Time Jump Detection" to handle debugging sessions:
 * If a significant time gap is detected between checks (likely due to a breakpoint),
 * the timeout deadline is extended by that gap to prevent false timeouts.
 */
export async function waitUntil(condition: () => boolean | Promise<boolean>, options: WaitUntilOptions = {}): Promise<void> {
    const { timeoutMs = 10000, pollIntervalMs = 50, stabilityDurationMs = 0 } = options;

    const start = Date.now();
    let deadline = start + timeoutMs;
    let stableSince: number | null = null;

    debug(`Started. Timeout: ${timeoutMs}ms, Poll: ${pollIntervalMs}ms, Stability: ${stabilityDurationMs}ms`);

    while (true) {
        const now = Date.now();

        if (now > deadline) {
            debug(`Timeout! Elapsed: ${now - start}ms`);
            throw new Error(`waitUntil timeout after ${timeoutMs}ms (adjusted for pauses)`);
        }

        let result: boolean;
        try {
            result = await condition();
        } catch (err) {
            debug(`Condition threw error:`, err);
            result = false;
        }

        if (result) {
            if (stabilityDurationMs === 0) {
                debug(`Condition met immediately.`);
                return;
            }
            if (stableSince === null) {
                stableSince = now;
            } else if (now - stableSince >= stabilityDurationMs) {
                debug(`Condition stable for ${now - stableSince}ms. Done.`);
                return;
            }
        } else {
            if (stableSince !== null) {
                debug(`Condition failed, resetting stability timer.`);
            }
            stableSince = null;
        }

        // --- Time Jump Detection (Debug Support) ---
        // Only measure time jump DURING the sleep, to avoid counting slow condition checks as "debugger pauses".
        const sleepStart = Date.now();
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        const sleepEnd = Date.now();
        const actualSleep = sleepEnd - sleepStart;

        // If actual sleep is significantly larger than requested (e.g. > 1s extra),
        // we assume the process was paused (e.g. at a breakpoint) or system was suspended.
        if (actualSleep > pollIntervalMs + 1000) {
            const jump = actualSleep - pollIntervalMs;
            debug(`Time jump detected: ${jump}ms. Extending deadline.`);
            deadline += jump;
        }
        // -------------------------------------------
    }
}
