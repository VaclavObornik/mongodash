import { Document, Filter, ObjectId } from 'mongodb';
import { processInBatches } from '../processInBatches';
import { ReactiveTaskRegistry } from './ReactiveTaskRegistry';
import { PagedResult, PaginationOptions, ReactiveTaskQuery, ReactiveTaskRecord, ReactiveTaskStatsResult, ReactiveTaskStatus } from './ReactiveTaskTypes';

export class ReactiveTaskManager {
    constructor(private registry: ReactiveTaskRegistry) {}

    public async getTasks(query: ReactiveTaskQuery<Document>, pagination: PaginationOptions = {}): Promise<PagedResult<ReactiveTaskRecord<Document>>> {
        const groups = await this.resolveCollectionsAndQueries(query, 'getTasks');

        const limit = pagination.limit ?? 50;
        const offset = pagination.skip ?? 0;
        const sortField = pagination.sort?.field ?? 'nextRunAt';
        const sortDirection = pagination.sort?.direction ?? 1;
        const sort = { [sortField]: sortDirection } as Record<string, 1 | -1>;

        // Optimization: If only 1 group, use direct DB query (efficient)
        if (groups.length === 1) {
            const { collection, mongoQuery } = groups[0];
            const [items, total] = await Promise.all([
                collection.repository.findTasks(mongoQuery, { limit, skip: offset, sort }),
                collection.repository.countTasks(mongoQuery),
            ]);
            return { items, total, limit, offset };
        }

        // Scatter-Gather for multiple collections
        // 1. Fetch (limit + offset) from ALL collections (sorted)
        // 2. Merge, Sort in Memory, Apply Limit/Offset
        // NOTE: This is expensive for deep pagination (offset > 1000).
        // For admin dashboard, this is acceptable.

        const fetchLimit = limit + offset;

        const results = await Promise.all(
            groups.map(async ({ collection, mongoQuery }) => {
                const [items, total] = await Promise.all([
                    collection.repository.findTasks(mongoQuery, { limit: fetchLimit, sort }),
                    collection.repository.countTasks(mongoQuery),
                ]);
                return { items, total };
            }),
        );

        const allItems = results.flatMap((r) => r.items);
        const total = results.reduce((sum, r) => sum + r.total, 0);

        // Sort in memory
        allItems.sort((a, b) => {
            const fieldA = a[sortField];
            const fieldB = b[sortField];

            // Normalize for comparison
            const valA = fieldA instanceof Date ? fieldA.getTime() : fieldA;
            const valB = fieldB instanceof Date ? fieldB.getTime() : fieldB;

            if (valA === valB) return 0;
            if (valA === undefined || valA === null) return 1;
            if (valB === undefined || valB === null) return -1;

            // Use 'any' cast for comparison to handle potentially mixed but logically comparable types (e.g. string vs string, number vs number)
            // without TypeScript complaining about disjoint union types.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((valA as any) < (valB as any)) return sortDirection === 1 ? -1 : 1;
            return sortDirection === 1 ? 1 : -1;
        });

        // Slice
        const slicedItems = allItems.slice(offset, offset + limit);

        return {
            items: slicedItems,
            total,
            limit,
            offset,
        };
    }

    public async countTasks(query: ReactiveTaskQuery<Document>): Promise<number> {
        const groups = await this.resolveCollectionsAndQueries(query, 'countTasks');
        const counts = await Promise.all(groups.map((g) => g.collection.repository.countTasks(g.mongoQuery)));
        return counts.reduce((sum, c) => sum + c, 0);
    }

    public async getAllTaskStats(): Promise<Record<string, ReactiveTaskStatsResult>> {
        const groups = await this.resolveCollectionsAndQueries({}, 'getAllTaskStats');
        const results = await Promise.all(
            groups.map((g) =>
                g.collection.repository.getStatistics(g.mongoQuery, {
                    includeStatusCounts: true,
                    includeErrorCount: true,
                    groupByTask: true,
                }),
            ),
        );

        const taskStats: Record<string, ReactiveTaskStatsResult> = {};

        for (const res of results) {
            for (const s of res.statuses) {
                const { task, status } = s._id as { task: string; status: string };
                if (!taskStats[task]) {
                    taskStats[task] = { statuses: [], errorCount: 0 };
                }
                taskStats[task].statuses.push({ _id: status as ReactiveTaskStatus, count: s.count });
            }
            // Extract per-task error counts from errorCounts array
            if (res.errorCounts) {
                for (const ec of res.errorCounts) {
                    const task = ec._id;
                    if (!taskStats[task]) {
                        taskStats[task] = { statuses: [], errorCount: 0 };
                    }
                    taskStats[task].errorCount = (taskStats[task].errorCount || 0) + ec.count;
                }
            }
        }

        return taskStats;
    }

    public async getTaskStats(query: ReactiveTaskQuery<Document>): Promise<ReactiveTaskStatsResult> {
        const groups = await this.resolveCollectionsAndQueries(query, 'getTaskStats');
        const results = await Promise.all(
            groups.map((g) =>
                g.collection.repository.getStatistics(g.mongoQuery, {
                    includeStatusCounts: true,
                    includeErrorCount: true,
                    groupByTask: false,
                }),
            ),
        );

        const statusMap = new Map<string, number>();
        let errorCount = 0;

        for (const res of results) {
            errorCount += res.errorCount || 0;
            for (const s of res.statuses) {
                // When groupByTask is false, _id is string (status)
                const status = s._id as string;
                const current = statusMap.get(status) || 0;
                statusMap.set(status, current + s.count);
            }
        }

        const statuses = Array.from(statusMap.entries()).map(([id, count]) => ({ _id: id as ReactiveTaskStatus, count }));
        return { statuses, errorCount };
    }

    public async retryTasks(query: ReactiveTaskQuery<Document>): Promise<{ modifiedCount: number }> {
        // Validation: Task name is required for retry if sourceDocFilter is complex
        // to identify the source collection.
        // If task name is NOT provided, we can only support simple status/id filters across ALL tasks?
        // Actually, the registry stores tasks by name.
        // If 'query.task' is missing, we might need to iterate ALL registered tasks?
        // Let's support 'task' being optional:
        // 1. If 'task' is provided: target that task's collection.
        // 2. If 'task' is NOT provided: iterate all registered tasks and apply logic.

        const taskNames = this.resolveTaskNames(query.task);

        let totalModified = 0;

        for (const taskName of taskNames) {
            const entry = this.registry.getEntry(this.registry.getTask(taskName)!.sourceCollection.collectionName);
            const taskQuery = { ...query, task: taskName }; // Ensure we filter by task name in the collection

            // Handle Source Doc Filter
            // If complex filter, use batching
            if (this.isComplexSourceFilter(query.sourceDocFilter)) {
                const sourceCollection = entry.sourceCollection;
                await processInBatches(
                    sourceCollection,
                    [{ $match: query.sourceDocFilter }, { $project: { _id: 1 } }],
                    (doc) => doc._id,
                    async (batchIds) => {
                        const batchQuery = this.buildDirectQuery({ ...taskQuery, sourceDocFilter: undefined });
                        batchQuery.sourceDocId = { $in: batchIds };
                        // Safety: ensure we are targeting the right task
                        batchQuery.task = taskName;

                        const res = await entry.repository.resetTasks(batchQuery);
                        totalModified += res.modifiedCount;
                    },
                    { batchSize: 1000 },
                );
            } else {
                // Direct Update
                const mongoQuery = this.buildDirectQuery(taskQuery);
                const res = await entry.repository.resetTasks(mongoQuery);
                totalModified += res.modifiedCount;
            }
        }

        return { modifiedCount: totalModified };
    }

    private resolveTaskNames(taskInput?: string | string[]): string[] {
        if (taskInput) {
            const inputs = Array.isArray(taskInput) ? taskInput : [taskInput];
            // Validate exist
            for (const t of inputs) {
                if (!this.registry.getTask(t)) {
                    throw new Error(`Task '${t}' not found in registry.`);
                }
            }
            return inputs;
        }
        // If no task specified, target ALL tasks
        return this.registry.getAllTasks().map((t) => t.task);
    }

    private async resolveCollectionsAndQueries(
        query: ReactiveTaskQuery<Document>,
        operation: string,
    ): Promise<Array<{ collection: ReturnType<ReactiveTaskRegistry['getEntry']>; mongoQuery: Filter<ReactiveTaskRecord<Document>> }>> {
        // Listing/Counting does NOT support complex sourceDocFilter currently
        if (this.isComplexSourceFilter(query.sourceDocFilter)) {
            throw new Error(`Operation '${operation}' does not support complex 'sourceDocFilter'. Use simple ID filter or 'retryTasks'.`);
        }

        const taskNames = this.resolveTaskNames(query.task);
        if (taskNames.length === 0) {
            return [];
        }

        // Group tasks by collection
        const groups = new Map<string, string[]>(); // collectionName -> taskNames[]

        for (const tName of taskNames) {
            const t = this.registry.getTask(tName)!;
            const entry = this.registry.getEntry(t.sourceCollection.collectionName);
            const colName = entry.tasksCollection.collectionName;
            if (!groups.has(colName)) {
                groups.set(colName, []);
            }
            groups.get(colName)!.push(tName);
        }

        const result: Array<{
            collection: ReturnType<ReactiveTaskRegistry['getEntry']>;
            mongoQuery: Filter<ReactiveTaskRecord<Document>>;
        }> = [];

        for (const [, groupTaskNames] of groups) {
            // We need to find the entry associated with this collection.
            // Since we grouped by tasksCollection name, any task in the group points to the same entry (collection-wise).
            const firstTaskInGroup = groupTaskNames[0];
            const t = this.registry.getTask(firstTaskInGroup)!;
            const entry = this.registry.getEntry(t.sourceCollection.collectionName);

            // Build query for this group
            // We must filter by the tasks in this group
            const mongoQuery = this.buildDirectQuery({ ...query, task: groupTaskNames });

            result.push({ collection: entry, mongoQuery });
        }

        return result;
    }

    private buildDirectQuery(query: ReactiveTaskQuery<Document>): Filter<ReactiveTaskRecord<Document>> {
        const mongoQuery: Filter<ReactiveTaskRecord<Document>> = {};

        if (query.task) {
            if (Array.isArray(query.task)) {
                mongoQuery.task = { $in: query.task };
            } else {
                mongoQuery.task = query.task;
            }
        }

        if (query.status) {
            if (Array.isArray(query.status)) {
                mongoQuery.status = { $in: query.status };
            } else {
                mongoQuery.status = query.status;
            }
        }

        if (query.errorMessage) {
            if (query.errorMessage instanceof RegExp) {
                mongoQuery.lastError = query.errorMessage;
            } else {
                mongoQuery.lastError = { $regex: query.errorMessage, $options: 'i' };
            }
        }

        if (query.sourceDocFilter) {
            // Should be simple filter here
            if (query.sourceDocFilter._id) {
                mongoQuery.sourceDocId = query.sourceDocFilter._id;
            }
        }

        if (query._id) {
            // Convert string _id to ObjectId if it's a valid 24-char hex string
            const id = query._id;
            if (typeof id === 'string' && /^[a-fA-F0-9]{24}$/.test(id)) {
                mongoQuery._id = new ObjectId(id);
            } else if (Array.isArray(id)) {
                mongoQuery._id = {
                    $in: id.map((i) => (typeof i === 'string' && /^[a-fA-F0-9]{24}$/.test(i) ? new ObjectId(i) : i)),
                };
            } else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                mongoQuery._id = id as any;
            }
        }

        if (query.hasError !== undefined) {
            if (query.hasError) {
                mongoQuery.lastError = { $exists: true, $ne: null };
            } else {
                mongoQuery.lastError = { $exists: false };
            }
        }

        return mongoQuery;
    }

    private isComplexSourceFilter(filter?: Filter<Document>): boolean {
        if (!filter) return false;
        // Simple if ONLY _id is present
        const keys = Object.keys(filter);
        if (keys.length === 0) return false;
        if (keys.length === 1 && keys[0] === '_id') return false;
        return true;
    }
}
