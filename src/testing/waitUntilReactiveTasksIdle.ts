import * as _debug from 'debug';
import { Document, Filter } from 'mongodb';
import { ReactiveTaskRecord, _scheduler } from '../reactiveTasks';
import { waitUntil, WaitUntilOptions } from './waitUntil';

const debug = _debug('mongodash:testing');

/**
 * Waits until the reactive task system is idle.
 * "Idle" means:
 * 1. No changes are buffered in the Planner.
 * 2. No workers are currently executing tasks (active count is 0).
 * 3. No tasks in the database are in a pending or processing state.
 *
 * This enables robust E2E testing by ensuring that all side effects and cascading tasks have finished.
 *
 * @remarks
 * Pending tasks scheduled far in the future (beyond `timeoutMs + stabilityDurationMs + 100ms`)
 * are treated as "future work" and ignored. This prevents long-running retries (e.g. exponential backoff
 * pushing `nextRunAt` hours ahead) from blocking the idle check forever.
 */
export interface WaitUntilReactiveTasksIdleOptions extends Partial<WaitUntilOptions> {
    /**
     * If provided, the function will only wait for tasks related to these specific entities.
     * Global checks (Planner buffer, Active workers) are SKIPPED in this mode to ensure isolation
     * from other running tests.
     */
    whitelist?: Array<{
        collection: string;
        /**
         * Filter to find relevant documents.
         * If not provided, ALL documents in the collection are considered (use carefully!).
         */
        filter?: Filter<Document>;
        /**
         * Optional task name filter.
         */
        task?: string;
    }>;
}

export async function waitUntilReactiveTasksIdle(customOptions: WaitUntilReactiveTasksIdleOptions = {}): Promise<void> {
    const options: WaitUntilOptions = {
        timeoutMs: 10000,
        pollIntervalMs: 50,
        stabilityDurationMs: 200, // Wait for silence to catch "in-flight" events
        ...customOptions,
    };

    const hasWhitelist = customOptions.whitelist && customOptions.whitelist.length > 0;

    await waitUntil(async () => {
        // Access scheduler internals
        const planner = _scheduler.taskPlannerInstance;
        const runner = _scheduler.concurrentRunnerInstance;
        const registry = _scheduler.getRegistry();

        // --- 1. Global Checks (Always run) ---
        // 1. Check Internal Buffers (Planner)
        if (planner && !planner.isEmpty) {
            debug('Planner not empty');
            return false;
        }

        // 2. Check Active Workers (Runner)
        if (runner && runner.activeWorkers > 0) {
            debug(`Active workers: ${runner.activeWorkers}`);
            return false;
        }

        // --- 2. Check Database ---
        const entries = registry.getAllEntries();

        // Optimized check: If any collection has pending work, we are not idle.
        for (const entry of entries) {
            // If whitelisting is active, we only check tasks that match the whitelist
            let whitelistFilter: Filter<ReactiveTaskRecord> | null = null;

            if (hasWhitelist) {
                const rules = customOptions.whitelist!.filter((rule) => rule.collection === entry.sourceCollection.collectionName);

                if (rules.length === 0) {
                    continue;
                }

                const criteria: Array<Filter<ReactiveTaskRecord>> = [];
                let matchAll = false;

                for (const rule of rules) {
                    let ruleIds: unknown[] | null = null;

                    if (rule.filter) {
                        // If we have a filter, we need to find which docs match it.
                        // We can't filter tasks directly by source properties efficiently without joining,
                        // so we find the matching source docs first.
                        const matchingDocs = (await entry.sourceCollection.find(rule.filter, { projection: { _id: 1 } }).toArray()) as Document[];
                        ruleIds = matchingDocs.map((d) => d._id);
                    }

                    if (ruleIds === null && !rule.task) {
                        // One rule validates 'all', so we wait for everything in this collection
                        matchAll = true;
                        break;
                    }

                    if (rule.task) {
                        criteria.push({ task: rule.task });
                    }
                    if (ruleIds !== null) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        criteria.push({ sourceDocId: { $in: ruleIds as any[] } });
                    }
                }

                if (!matchAll) {
                    if (criteria.length > 0) {
                        whitelistFilter = { $or: criteria };
                    } else {
                        // Whitelist is active, but we have rules that result in effectively "nothing"
                        // (e.g. filter returned no docs).
                        // If we have NO criteria and NO matchAll, it implies we wait for nothing on this collection?
                        // Or should we treat it as blocking?
                        // If filter didn't match any doc, then we effectively wait for nothing for that rule.
                        // If ALL rules resulted in nothing, we continue to next entry.
                        continue;
                    }
                }
            }

            const stableThresholdMs = (options.timeoutMs || 0) + (options.stabilityDurationMs || 0) + 100;

            const baseQuery: Filter<ReactiveTaskRecord> = {
                $or: [
                    { status: { $in: ['processing', 'processing_dirty'] } },
                    {
                        status: 'pending',
                        $or: [{ nextRunAt: { $lte: new Date(Date.now() + stableThresholdMs) } }, { nextRunAt: null }],
                    },
                ],
            };

            const query: Filter<ReactiveTaskRecord> = whitelistFilter ? { $and: [baseQuery, whitelistFilter] } : baseQuery;

            const count = await entry.tasksCollection.countDocuments(query);

            if (count > 0) {
                debug(`Collection ${entry.tasksCollection.collectionName} has ${count} active tasks`);
                return false;
            }
        }

        return true;
    }, options);
}
