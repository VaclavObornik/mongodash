import { Filter } from 'mongodb';
import { ReactiveTaskRecord, ReactiveTaskScheduler, _scheduler } from '../reactiveTasks';
import { resolveWhitelistFilter, WhitelistRule } from './resolveWhitelistFilter';

export interface AssertNoReactiveTaskErrorsOptions {
    /**
     * Check for errors occurring after this time.
     * Essential to isolate the current test run.
     */
    since: Date;

    /**
     * Optional: Check only tasks related to specific entities.
     * If provided, errors in collections/tasks not matching the whitelist are ignored.
     */
    whitelist?: WhitelistRule[];

    /**
     * Optional: Whitelist specific errors.
     * If a string is provided, exact match is required.
     * If a RegExp is provided, it must test true against the error message.
     */
    excludeErrors?: (string | RegExp)[];

    /**
     * Optional: ReactiveTaskScheduler instance to use.
     * Essential for isolated testing where multiple schedulers might exist.
     */
    scheduler?: ReactiveTaskScheduler;
}

/**
 * Asserts that no reactive tasks have failed during the test run.
 * Checks the 'executionHistory' and 'lastError' of tasks in all registered collections.
 */
export async function assertNoReactiveTaskErrors(options: AssertNoReactiveTaskErrorsOptions): Promise<void> {
    let registry;

    // Fallback or override logic
    const schedulerToUse = options.scheduler || _scheduler;
    registry = schedulerToUse.getRegistry();

    const entries = registry.getAllEntries();

    const errorsFound: Array<{
        task: string;
        sourceDocId: unknown;
        error: string;
        at: Date;
    }> = [];

    const hasWhitelist = options.whitelist && options.whitelist.length > 0;

    for (const entry of entries) {
        // If whitelist is active, check if this collection is relevant
        let whitelistFilter: Filter<ReactiveTaskRecord> | null = null;
        if (hasWhitelist) {
            const resolution = await resolveWhitelistFilter(options.whitelist!, entry.sourceCollection);
            if (resolution === 'skip') continue;
            if (resolution !== 'matchAll') {
                whitelistFilter = resolution;
            }
        }

        // Build independent query for each collection
        const baseQuery: Filter<ReactiveTaskRecord> = {
            $or: [{ 'executionHistory.status': 'failed', 'executionHistory.at': { $gte: options.since } }],
        };

        const query = whitelistFilter ? { $and: [baseQuery, whitelistFilter] } : baseQuery;

        const tasksWithHistory = await entry.tasksCollection.find(query).toArray();

        for (const taskRecord of tasksWithHistory) {
            if (!taskRecord.executionHistory) continue;

            for (const item of taskRecord.executionHistory) {
                // 1. Check Date
                if (item.at < options.since) continue;
                // 2. Check Status
                if (item.status !== 'failed') continue;

                const errorMessage = item.error || 'Unknown error';

                // 3. Check Whitelist (excludeErrors)
                let isExcluded = false;
                if (options.excludeErrors) {
                    for (const pattern of options.excludeErrors) {
                        if (typeof pattern === 'string') {
                            if (pattern === errorMessage) {
                                isExcluded = true;
                                break;
                            }
                        } else if (pattern instanceof RegExp) {
                            if (pattern.test(errorMessage)) {
                                isExcluded = true;
                                break;
                            }
                        }
                    }
                }

                if (!isExcluded) {
                    errorsFound.push({
                        task: taskRecord.task,
                        sourceDocId: taskRecord.sourceDocId,
                        error: errorMessage,
                        at: item.at,
                    });
                }
            }
        }
    }

    if (errorsFound.length > 0) {
        const errorDetails = errorsFound
            .sort((a, b) => a.at.getTime() - b.at.getTime())
            .map((e) => `[${e.at.toISOString()}] Task '${e.task}' (Doc: ${e.sourceDocId}): ${e.error}`)
            .join('\n');

        throw new Error(`Found ${errorsFound.length} unexpected reactive task errors:\n${errorDetails}`);
    }
}
