const CronParser = require('cron-parser');

const { Duration } = require('@sapphire/duration');
import { CronExpressionOptions } from 'cron-parser';

/**
 * Create a function that returns the next run Date based on an interval specification.
 *
 * Supports:
 * - Number: returns Date that is `interval` milliseconds from now
 * - Duration string: '1h', '24h', '7d' - returns Date that is duration from now
 * - Cron expression: 'CRON 0 3 * * *' (must start with CRON) - returns next cron occurrence
 */
export function createIntervalFunction(
    interval: number | string | ((date?: Date) => Date | number),
    options: { cronOptions?: CronExpressionOptions } = {},
): (referenceDate?: Date) => Date {
    const { cronOptions = {} } = options;

    if (typeof interval === 'number') {
        if (!Number.isFinite(interval)) {
            throw new Error(`Error: Interval number has to be finite.`);
        }
        if (interval <= 0) {
            // A non-positive interval makes the task perpetually due; combined
            // with the post-run speedUp() this busy-loops a worker.
            throw new Error(`Error: Interval number has to be a positive number of milliseconds.`);
        }
        return (referenceDate?: Date) => new Date((referenceDate?.getTime() ?? Date.now()) + interval);
    }

    if (typeof interval !== 'string') {
        throw new Error('Error: Invalid interval.');
    }

    // Check for CRON prefix (case insensitive)
    if (/^CRON /i.test(interval)) {
        try {
            const expression = interval.slice(5); // Remove "CRON " prefix

            // Validate immediately
            CronParser.CronExpressionParser.parse(expression, cronOptions);

            // We use parse to handle the options correctly, specifically currentDate
            return (referenceDate?: Date) => {
                const opts = { ...cronOptions, currentDate: referenceDate ?? new Date() };
                const parsed = CronParser.CronExpressionParser.parse(expression, opts);
                return parsed.next().toDate();
            };
        } catch (err) {
            throw new Error(`Error: Invalid interval. ${(err as Error).message}.`);
        }
    }

    // Safety check: if it looks like a cron expression but missing prefix, throw
    if (interval.includes('*') && interval.split(' ').length >= 5) {
        throw new Error("Error: Invalid interval. Cron expressions must start with 'CRON '.");
    }

    // Parse as duration string
    const duration = new Duration(interval).offset;
    if (typeof duration !== 'number' || Number.isNaN(duration)) {
        throw new Error('Error: Invalid interval.');
    }
    if (duration <= 0) {
        // See the non-positive numeric guard above: a zero/negative duration
        // ('0s', '-1h') would make the task perpetually due and busy-loop it.
        throw new Error(`Error: Invalid interval. Duration '${interval}' must be positive.`);
    }
    return (referenceDate?: Date) => new Date((referenceDate?.getTime() ?? Date.now()) + duration);
}
