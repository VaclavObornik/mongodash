import * as cronParserPkg from 'cron-parser';
import { RetryPolicy } from './ReactiveTaskTypes';

const { Duration } = require('@sapphire/duration');

// Handle CommonJS/ESM interop
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CronExpressionParser = (cronParserPkg as any).default || (cronParserPkg as any).CronExpressionParser;

export class ReactiveTaskRetryStrategy {
    constructor(public readonly policy: RetryPolicy) {
        // Validate policy at construction time
        this.validatePolicy();
    }

    private validatePolicy(): void {
        const policy = this.policy;
        const validTypes = ['fixed', 'linear', 'exponential', 'series', 'cron'];
        if (!validTypes.includes(policy.type)) {
            throw new Error(`Invalid retry policy type: '${policy.type}'. Valid types: ${validTypes.join(', ')}`);
        }

        // Validate duration strings based on policy type
        if (policy.type === 'fixed' || policy.type === 'linear') {
            this.validateDuration('interval', policy.interval);
        }

        if (policy.type === 'exponential') {
            const minVal = policy.min !== undefined && policy.min !== null ? String(policy.min) : undefined;
            this.validateDuration('min', minVal);
            if (policy.max !== undefined && policy.max !== null) {
                this.validateDuration('max', String(policy.max));
            }
        }

        if (policy.type === 'series') {
            if (!policy.intervals || policy.intervals.length === 0) {
                throw new Error("Series retry policy requires non-empty 'intervals' array.");
            }
            policy.intervals.forEach((interval, index) => {
                this.validateDuration(`intervals[${index}]`, interval);
            });
        }

        if (policy.type === 'cron') {
            try {
                CronExpressionParser.parse(policy.expression, { currentDate: new Date() });
            } catch (err) {
                throw new Error(`Invalid cron expression '${policy.expression}': ${(err as Error).message}`);
            }
        }

        // Validate optional maxDuration if provided
        if (policy.maxDuration) {
            this.validateDuration('maxDuration', policy.maxDuration);
        }
    }

    private validateDuration(fieldName: string, value: string | undefined): void {
        if (!value) {
            throw new Error(`Retry policy requires '${fieldName}' to be specified.`);
        }
        const parsed = new Duration(value).offset;
        if (parsed === null || parsed === undefined || Number.isNaN(parsed)) {
            throw new Error(`Invalid duration format for '${fieldName}': '${value}'. Use formats like '100ms', '1s', '5m', '1h'.`);
        }
        if (parsed < 0) {
            throw new Error(`Duration '${fieldName}' must be non-negative, got '${value}'.`);
        }
    }

    /**
     * Calculates the timestamp for the next retry attempt.
     * @param attempts Current number of attempts (will be incremented for next check) called AFTER failure
     * @param lastError Timestamp of the last error or last attempt? No, policies are usually "after X time".
     *                  For linear/exp/fixed, we add delay to NOW.
     *                  For Cron, we find next date after NOW.
     */
    public calculateNextRetry(attempts: number): Date {
        const now = new Date();

        if (this.policy.type === 'fixed') {
            const delay = new Duration(this.policy.interval).offset || 0;
            return new Date(now.getTime() + delay);
        } else if (this.policy.type === 'linear') {
            const interval = new Duration(this.policy.interval).offset || 0;
            return new Date(now.getTime() + interval * attempts);
        } else if (this.policy.type === 'exponential') {
            const min = new Duration(String(this.policy.min)).offset || 0;
            const max = new Duration(String(this.policy.max)).offset || Infinity;
            const factor = this.policy.factor ?? 2;
            // min * (factor ^ (attempts - 1))?
            // Standard exp backoff:
            // attempt 1: min
            // attempt 2: min * factor
            const delay = Math.min(max, min * Math.pow(factor, attempts - 1));
            return new Date(now.getTime() + delay);
        } else if (this.policy.type === 'series') {
            const intervals = this.policy.intervals;
            // If attempts > intervals, use the last one (or maybe fail? usually last one)
            // attempts is 1-based index of the *next* attempt?
            // if we just failed attempt #1, we are scheduling attempt #2?
            // Let's assume 'attempts' passed here is how many attempts have FAILED so far.
            // So we are scheduling for attempt = attempts + 1.
            // Series index should be attempts (0-based) ?
            // If attempts=1 (1 failure), we want the 1st interval (index 0)?
            // Wait.
            // Policy: [1m, 5m]
            // Fail attempt 1 -> wait 1m (index 0)
            // Fail attempt 2 -> wait 5m (index 1)
            // Fail attempt 3 -> wait 5m (index 1 - clamp)
            const index = Math.min(Math.max(0, attempts - 1), intervals.length - 1);
            const delay = new Duration(intervals[index]).offset || 0;
            return new Date(now.getTime() + delay);
        } else if (this.policy.type === 'cron') {
            // Cron expression was validated in constructor, so this should not fail
            const interval = CronExpressionParser.parse(this.policy.expression, {
                currentDate: now,
            });
            return interval.next().toDate();
        } else {
            // This should never happen since we validate in constructor
            throw new Error(`Unknown retry policy type: ${(this.policy as unknown as { type: string }).type}`);
        }
    }

    /**
     * Determines if the task should be marked as permanently failed.
     * @param attempts Number of attempts consumed so far (including the one that just failed)
     * @param firstErrorAt When the first error in this sequence occurred
     */
    public shouldFail(attempts: number, firstErrorAt?: Date | null): boolean {
        // Check Max Attempts
        if (this.policy.maxAttempts !== undefined && this.policy.maxAttempts !== -1 && attempts >= this.policy.maxAttempts) {
            return true;
        }

        // Check Max Duration
        if (this.policy.maxDuration && firstErrorAt) {
            const maxDurationMs = new Duration(this.policy.maxDuration).offset || 0;
            const elapsed = Date.now() - firstErrorAt.getTime();
            if (elapsed > maxDurationMs) {
                return true;
            }
        }

        return false;
    }
}
