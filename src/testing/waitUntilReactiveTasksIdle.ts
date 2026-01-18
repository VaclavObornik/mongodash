import * as _debug from 'debug';
import { ReactiveTaskStatus, _scheduler } from '../reactiveTasks';
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
 */
export async function waitUntilReactiveTasksIdle(customOptions: Partial<WaitUntilOptions> = {}): Promise<void> {
    const options: WaitUntilOptions = {
        timeoutMs: 10000,
        pollIntervalMs: 50,
        stabilityDurationMs: 200, // Wait for silence to catch "in-flight" events
        ...customOptions,
    };

    await waitUntil(async () => {
        // 1. Check Internal Buffers (Planner)
        // Accessing private planner via exposed getter for testing
        const planner = _scheduler.taskPlannerInstance;
        if (planner && !planner.isEmpty) {
            debug('Planner not empty');
            return false;
        }

        // 2. Check Active Workers (Runner)
        const runner = _scheduler.concurrentRunnerInstance;
        if (runner && runner.activeWorkers > 0) {
            debug(`Active workers: ${runner.activeWorkers}`);
            return false;
        }

        // 3. Check Database
        const registry = _scheduler.getRegistry();
        const entries = registry.getAllEntries();

        // Optimized check: If any collection has pending work, we are not idle.
        for (const entry of entries) {
            // We count documents that are "active"
            // status IN [pending, processing, processing_dirty]
            // AND dueAt <= Now (approx) - actually, for "settled" we might want to wait for EVERYTHING?
            // Usually we want to wait for anything that is currently actionable.
            // If a task is scheduled for tomorrow, we shouldn't wait for it.

            // However, the user requirement is "guarantees that all reactive tasks that are currently planned... have been completed".
            // "Currently planned" usually implies "executable now".
            // But if we ignore future tasks, we are safe.

            const horizon = Date.now() + (options.timeoutMs || 0) + (options.stabilityDurationMs || 0) + 100;

            // We count documents that are "active"
            // ONE OF:
            // 1. status IN [processing, processing_dirty] (always active)
            // 2. status = pending AND (nextRunAt <= horizon OR nextRunAt IS NULL)
            //    (NULL nextRunAt usually means "now" or "asap" in some contexts, or "never",
            //     but for pending it usually means "ready").

            const count = await entry.tasksCollection.countDocuments({
                $or: [
                    { status: { $in: ['processing', 'processing_dirty'] as ReactiveTaskStatus[] } },
                    {
                        status: 'pending',
                        $or: [{ nextRunAt: { $lte: new Date(horizon) } }, { nextRunAt: null }],
                    },
                ],
            });

            if (count > 0) {
                debug(`Collection ${entry.tasksCollection.collectionName} has ${count} active tasks`);
                return false;
            }
        }

        return true;
    }, options);
}
