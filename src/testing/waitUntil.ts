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
    let stableSince = Date.now();
    let lastTick = Date.now();

    while (true) {
        const now = Date.now();

        // --- Time Jump Detection (Debug Support) ---
        const elapsedSinceLastTick = now - lastTick;
        // If elapsed time is significantly larger than poll interval (e.g. > 1s),
        // we assume the process was paused (e.g. at a breakpoint).
        if (elapsedSinceLastTick > 1000) {
            const jump = elapsedSinceLastTick - pollIntervalMs; // Approximate jump
            if (jump > 0) {
                deadline += jump;
            }
        }
        lastTick = now;
        // -------------------------------------------

        if (now > deadline) {
            throw new Error(`waitUntil timeout after ${timeoutMs}ms (adjusted for pauses)`);
        }

        let result: boolean;
        try {
            result = await condition();
        } catch {
            // error is ignored
            result = false; // Condition failing throws implies not met? Or should we propagate?
            // Usually waitUntil swallows errors unless critical. Let's assume false.
            // But if it's a logic error in condition, maybe we should throw.
            // For now, let's treat throw as false for robustness in shaky tests.
        }

        if (result) {
            if (stabilityDurationMs === 0) {
                return;
            }
            if (now - stableSince >= stabilityDurationMs) {
                return;
            }
            // Condition is true but haven't been stable long enough
            // Continue loop
        } else {
            // Condition failed, reset stability timer
            stableSince = now;
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
}
