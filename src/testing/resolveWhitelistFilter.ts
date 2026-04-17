import { Collection, Document, Filter } from 'mongodb';
import { ReactiveTaskRecord } from '../reactiveTasks';

/**
 * A single rule used by the testing utilities to scope checks to a set of
 * source documents.
 */
export interface WhitelistRule {
    collection: string;
    /**
     * Filter to find relevant source documents. When omitted every document
     * in the collection is considered.
     */
    filter?: Filter<Document>;
    /**
     * Optional: restrict to a specific reactive task name.
     */
    task?: string;
}

/**
 * Resolution outcome for a whitelist against one registry entry.
 *
 * - `'skip'`: the whitelist has rules, but none apply to this collection or
 *   the source filters matched zero documents. Callers should skip this
 *   entry entirely.
 * - `'matchAll'`: at least one rule for this collection wants the full
 *   collection. Callers should apply no extra filter.
 * - An object: the caller should AND this filter with its base query.
 */
export type WhitelistResolution = 'skip' | 'matchAll' | Filter<ReactiveTaskRecord>;

/**
 * Build the `Filter<ReactiveTaskRecord>` for a single registry entry based on
 * the provided whitelist rules. Extracted from `waitUntilReactiveTasksIdle` /
 * `assertNoReactiveTaskErrors` so the two utilities cannot drift.
 */
export async function resolveWhitelistFilter(
    whitelist: WhitelistRule[],
    sourceCollection: Pick<Collection<Document>, 'collectionName' | 'find'>,
): Promise<WhitelistResolution> {
    const rules = whitelist.filter((rule) => rule.collection === sourceCollection.collectionName);
    if (rules.length === 0) {
        return 'skip';
    }

    const criteria: Array<Filter<ReactiveTaskRecord>> = [];

    for (const rule of rules) {
        let ruleIds: unknown[] | null = null;

        if (rule.filter) {
            const matchingDocs = (await sourceCollection.find(rule.filter, { projection: { _id: 1 } }).toArray()) as Document[];
            ruleIds = matchingDocs.map((d) => d._id);
        }

        if (ruleIds === null && !rule.task) {
            // Rule covers every document in this collection and every task.
            return 'matchAll';
        }

        const ruleCriteria: Filter<ReactiveTaskRecord> = {};
        if (rule.task) {
            ruleCriteria.task = rule.task;
        }
        if (ruleIds !== null) {
            ruleCriteria.sourceDocId = { $in: ruleIds as ReactiveTaskRecord['sourceDocId'][] };
        }
        criteria.push(ruleCriteria);
    }

    if (criteria.length === 0) {
        // Rules matched this collection but every rule resolved to an empty
        // document set - nothing to wait for / check.
        return 'skip';
    }

    return { $or: criteria };
}
