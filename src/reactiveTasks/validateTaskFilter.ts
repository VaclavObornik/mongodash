import { Document } from 'mongodb';
import { queryToExpression } from './queryToExpression';

/**
 * Normalizes the task filter into a valid Aggregation Expression.
 * If the filter is a standard query (keys not starting with $), it is converted.
 * If the filter is already an expression (keys starting with $), it is kept.
 *
 * @param filter The filter object to normalize.
 * @param taskName The name of the task (for error context).
 */
export function normalizeTaskFilter(filter: Document | undefined, taskName: string): Document | undefined {
    if (!filter) {
        return undefined;
    }

    if (typeof filter !== 'object' || Array.isArray(filter)) {
        throw new Error(`Task '${taskName}': Invalid filter. Expected an object.`);
    }

    const keys = Object.keys(filter);
    if (keys.length === 0) {
        return {};
    }

    // Check if it's already an expression (simple heuristic: empty or $expr)
    // Or if it DOESN'T look like a query.
    // However, { $and: [...] } is valid query AND valid expression (mostly).
    // The main difference is { field: val } vs { $eq: ['$field', val] }.

    // We assume if ANY key does NOT start with $, it is definitely a Query.
    const hasFieldKeys = keys.some((k) => !k.startsWith('$'));

    if (hasFieldKeys) {
        try {
            return queryToExpression(filter);
        } catch (e) {
            throw new Error(`Task '${taskName}': Failed to convert simple filter to expression: ${(e as Error).message}`);
        }
    }

    // If all keys start with $, it's EITHER a logical query OR an expression.
    // queryToExpression handles $and/$or/$not recursively via queryToExpression.
    // But if the user intended { $eq: ['$a', 1] }, queryToExpression would trip on '$eq' as top level key?
    // queryToExpression throws on unsupported top level keys.
    // So if the user provided a valid expression like { $eq: ... }, queryToExpression would throw.

    // Heuristic: If it looks like an expression (keys are aggregation operators), return as is.
    // IF the user provided { $or: [ { a: 1 } ] }, this is a query using logical op.
    // If they provided { $or: [ { $eq: ... } ] }, this is an expression.

    // The safest bet is: if we see field keys (not starting with $), CONVERT.
    // If all keys start with $, we assume it is ALREADY an expression, UNLESS it is $or/$and/$nor/$not which are ambiguous.
    // But wait, { $or: [{ a: 1 }] } -> queryToExpression handles this recursively.
    // { $or: [{ $eq: [..] }] } -> queryToExpression -> $or -> map -> queryToExpression({ $eq: .. }) -> Throw 'Unsupported top level operator $eq'?

    // So queryToExpression is strict about what it accepts.
    // If the top level is $or, it descends.
    // If we want to support both, we need to know intent.

    // Let's rely on the previous logic: If the user provides a "Simple Filter", they imply Query Syntax.
    // If they strictly use Expression Syntax, they usually wrap in { $expr: ... } or use operators that queryToExpression doesn't support.

    // If validation fails (queryToExpression throws), we could assume it's an Expression and return it?
    // But queryToExpression might partially convert deep inside?

    // Let's assume: If it works as Query, convert it. If it throws, assume it is Expression?
    // That is risky.

    // Better strategy:
    // If ANY key does NOT start with $, it MUST be a Query -> Convert.
    // If ALL keys start with $ AND it includes $expr, it is Expression -> Return.
    // If ALL keys start with $ AND are logical ($or/$and), checks children?

    // Compromise:
    // If the user uses the feature 'Simple Filtering', they should probably NOT mix Expression syntax at root unless wrapped in $expr.
    // If they pass { $eq: ['$a', 1] }, queryToExpression throws. We catch and return original?

    try {
        const expr = queryToExpression(filter);
        if (expr && Object.keys(expr).length === 1 && expr.$expr) {
            return expr.$expr;
        }
        return expr;
    } catch {
        // If conversion failed, it might be because it was already an expression.
        if (keys.length === 1 && keys[0] === '$expr') {
            return filter.$expr;
        }
        return filter;
    }
}
