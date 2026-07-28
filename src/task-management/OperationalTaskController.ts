import { ReactiveTaskScheduler } from '../reactiveTasks/index';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Document, ObjectId } from 'mongodb';
import { CronTaskQuery, getCronTasksList, scheduleCronTaskImmediately } from '../cronTasks';
import { getMongoClient } from '../getMongoClient';
import { onInfo } from '../OnInfo';
import { CODE_MANUAL_TRIGGER, ReactiveTaskQuery, ReactiveTaskStatus } from '../reactiveTasks/ReactiveTaskTypes';

const DEFAULT_PAGE_LIMIT = 50;
/** Upper bound for a dashboard page; the endpoint is unauthenticated by design. */
const MAX_PAGE_LIMIT = 500;

/** Floors and rejects non-finite input: `?skip=Infinity` would otherwise reach the driver. */
const toFiniteInt = (value: unknown): number => {
    const n = Math.floor(Number(value));
    return Number.isFinite(n) ? n : 0;
};
/** Note `toFiniteInt(x) || DEFAULT` also maps 0, '' and NaN to the default - and MongoDB reads `limit: 0` as unlimited. */
const clampLimit = (value: unknown): number => Math.min(Math.max(toFiniteInt(value) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
const clampSkip = (value: unknown): number => Math.max(toFiniteInt(value), 0);

export class OperationalTaskController {
    constructor(private scheduler: ReactiveTaskScheduler) {}

    public async getReactiveTasks(params: {
        limit?: number;
        skip?: number;
        task?: string;
        collection?: string;
        status?: string;
        errorMessage?: string;
        hasError?: string;
        sourceDocId?: string;
    }) {
        const query: ReactiveTaskQuery<Document> = {};

        // Resolved once so the empty short-circuit below and the real query
        // cannot drift apart. Clamped, because this endpoint has no built-in
        // auth and MongoDB treats `limit: 0` as UNLIMITED - `?limit=0` (or an
        // empty `?limit=`) would otherwise buffer the whole tasks collection.
        const limit = clampLimit(params.limit);
        const skip = clampSkip(params.skip);

        if (params.task) {
            query.task = params.task;
        } else if (params.collection) {
            // Map collection to task names that belong to it
            const allTasks = this.scheduler.getRegistry().getAllTasks();
            const taskNamesInCollection = allTasks.filter((t) => t.sourceCollection.collectionName === params.collection).map((t) => t.task);
            if (taskNamesInCollection.length === 0) {
                // No reactive tasks registered for this collection. Short-circuit
                // to an empty page: injecting a sentinel task name would fail
                // registry validation and surface as an HTTP 500.
                return {
                    items: [],
                    total: 0,
                    limit,
                    offset: skip,
                    stats: { statuses: [], errorCount: 0 },
                };
            }
            query.task = taskNamesInCollection;
        }

        if (params.status) {
            query.status = params.status.split(',').map((s) => s.trim()) as ReactiveTaskStatus[];
        }

        if (params.errorMessage) {
            query.errorMessage = params.errorMessage;
        }

        if (params.hasError !== undefined) {
            query.hasError = params.hasError === 'true';
        }

        if (params.sourceDocId) {
            query.sourceDocFilter = this.createSmartIdFilter(params.sourceDocId);
        }

        const statsQuery: ReactiveTaskQuery<Document> = { ...query };
        delete statsQuery.status;
        delete statsQuery.errorMessage;
        delete statsQuery.hasError;

        const [result, stats] = await Promise.all([
            this.scheduler.getTaskManager().getTasks(query, {
                limit,
                skip,
                sort: { field: 'nextRunAt', direction: 1 },
            }),
            this.scheduler.getTaskManager().getTaskStats(statsQuery),
        ]);

        // Hide sensitive internal data
        result.items.forEach((item) => {
            delete item.lastObservedValues;
        });

        return { ...result, stats };
    }

    public async retryReactiveTasks(body: { task?: string; status?: string; errorMessage?: string; _id?: string; sourceDocId?: string }) {
        const query: ReactiveTaskQuery<Document> = {};
        if (body.task) {
            query.task = body.task;
        }
        if (body.status) {
            query.status = body.status as ReactiveTaskStatus;
        }
        if (body.errorMessage) {
            query.errorMessage = body.errorMessage;
        }
        if (body._id) {
            query._id = body._id;
        }
        if (body.sourceDocId) {
            query.sourceDocFilter = this.createSmartIdFilter(body.sourceDocId);
        }
        const result = await this.scheduler.getTaskManager().retryTasks(query);
        onInfo({
            message: `Manual intervention via Dashboard: Retry tasks matching ${JSON.stringify(body)}`,
            code: CODE_MANUAL_TRIGGER,
            action: 'retry',
            params: body,
            modifiedCount: result.modifiedCount,
        });
        return result;
    }

    private createSmartIdFilter(sourceDocId: string) {
        const input = sourceDocId.trim();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidates: any[] = [input];

        // Smart ID Matching:
        // 1. Exact String (already added)
        // 2. ObjectId (if valid hex)
        if (/^[0-9a-fA-F]{24}$/.test(input)) {
            candidates.push(new ObjectId(input));
        }
        // 3. Number (if valid number)
        if (!isNaN(Number(input)) && input !== '') {
            candidates.push(Number(input));
        }

        return { _id: { $in: candidates } };
    }

    public async getCronTasks(params: CronTaskQuery) {
        return getCronTasksList({
            filter: params.filter,
            limit: clampLimit(params.limit),
            skip: clampSkip(params.skip),
            sort: params.sort,
        });
    }

    public async triggerCronTask(body: { taskId: string }) {
        if (!body.taskId) throw new Error('taskId is required');
        await scheduleCronTaskImmediately(body.taskId);
        onInfo({
            message: `Manual intervention via Dashboard: Triggered Cron Task '${body.taskId}'`,
            code: CODE_MANUAL_TRIGGER,
            action: 'triggerCron',
            taskId: body.taskId,
        });
        return { success: true };
    }

    public async getInfo() {
        const [allStats, cronPaged] = await Promise.all([this.scheduler.getTaskManager().getAllTaskStats(), getCronTasksList({ limit: 1000 })]);

        const allTasks = this.scheduler.getRegistry().getAllTasks();
        const reactiveTasks = allTasks
            .map((t) => {
                const stats = allStats[t.task] || { statuses: [], errorCount: 0 };
                const counts = {
                    success: 0,
                    failed: 0,
                    processing: 0,
                    pending: 0,
                    error: stats.errorCount || 0,
                };
                for (const s of stats.statuses) {
                    const status = s._id as string;
                    if (status === 'completed' || status === 'success') counts.success += s.count;
                    if (status === 'failed') counts.failed += s.count;
                    if (status === 'processing' || status === 'processing_dirty') counts.processing += s.count;
                    if (status === 'pending') counts.pending += s.count;
                }
                return {
                    name: t.task,
                    collection: t.sourceCollection.collectionName,
                    stats: counts,
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));

        const cronTasks = cronPaged.items.map((t) => ({
            id: t._id,
            status: t.status,
            lastRunError: t.lastRun?.error,
            nextRunAt: t.nextRunAt,
        }));

        return {
            databaseName: getMongoClient().db().databaseName,
            reactiveTasks,
            cronTasks,
        };
    }
}
