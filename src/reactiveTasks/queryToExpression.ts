import { Document, ObjectId } from 'mongodb';

/**
 * Converts a standard MongoDB query object into an Aggregation Expression.
 * strict support for:
 * - Implicit Equality: { a: 1 }
 * - Comparisons: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin
 * - Logical: $and, $or, $nor, $not
 * - Regex: /pattern/, $regex
 * - Existence: $exists
 *
 * THROWS error on unsupported operators (like $elemMatch, $all, $xyz) to avoid silent failures.
 */
export interface UnsupportedFieldOperatorError extends Error {
    isUnsupportedFieldOperator?: boolean;
}

export function queryToExpression(query: Document): Document {
    if (!query || Object.keys(query).length === 0) {
        return {};
    }

    const conditions: Document[] = [];

    for (const key of Object.keys(query)) {
        const value = query[key];

        if (key.startsWith('$')) {
            // Logical Operators
            if (key === '$or' || key === '$and' || key === '$nor') {
                if (!Array.isArray(value)) {
                    throw new Error(`ReactiveTasks: Value for '${key}' must be an array.`);
                }
                const mapped = value.map((item) => queryToExpression(item));
                conditions.push({ [key]: mapped });
            } else if (key === '$not') {
                conditions.push({ $not: [queryToExpression(value)] });
            } else if (key === '$expr') {
                // If the user mixes $expr into a query, trust it (it's already an expression)
                conditions.push(value);
            } else {
                throw new Error(`ReactiveTasks: Top-level operator '${key}' is not supported in simple filter conversion. Use Aggregation syntax.`);
            }
        } else {
            // Field condition
            const fieldCondition = parseFieldCondition(key, value);
            if (fieldCondition) {
                conditions.push(fieldCondition);
            }
        }
    }

    if (conditions.length === 0) {
        return {};
    }
    if (conditions.length === 1) {
        return conditions[0];
    }
    return { $and: conditions };
}

/**
 * $regexMatch errors when its `input` is not a string. Guard so a document
 * whose field is missing or non-string degrades to "no match" rather than
 * throwing server-side and killing the reconciliation / change-stream
 * pipeline for every scanned document.
 */
function regexMatchGuarded(rawFieldPath: string, regex: string, options: string): Document {
    return {
        $cond: [{ $eq: [{ $type: rawFieldPath }, 'string'] }, { $regexMatch: { input: rawFieldPath, regex, options } }, false],
    };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseFieldCondition(field: string, value: any): Document | null {
    const rawFieldPath = `$${field}`;
    const ifNullFieldPath = { $ifNull: [rawFieldPath, null] };

    // 1. Equality / Direct Value
    if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        value instanceof Date ||
        value instanceof RegExp ||
        value instanceof ObjectId ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (value as any)._bsontype === 'ObjectId' // Handling different ObjectId implementations
    ) {
        if (value instanceof RegExp) {
            return regexMatchGuarded(rawFieldPath, value.source, value.flags);
        }
        return { $eq: [ifNullFieldPath, value] };
    }

    const valueKeys = Object.keys(value);

    // Check if it's an object with operators: { age: { $gt: 18 } }
    const isOperatorObject = valueKeys.length > 0 && valueKeys.every((k) => k.startsWith('$'));

    if (isOperatorObject) {
        const fieldConditions: Document[] = [];
        for (const op of valueKeys) {
            const opVal = value[op];

            switch (op) {
                case '$eq':
                    fieldConditions.push({ $eq: [ifNullFieldPath, opVal] });
                    break;
                case '$ne':
                    fieldConditions.push({ $ne: [ifNullFieldPath, opVal] });
                    break;
                case '$gt':
                    fieldConditions.push({ $gt: [ifNullFieldPath, opVal] });
                    break;
                case '$gte':
                    fieldConditions.push({ $gte: [ifNullFieldPath, opVal] });
                    break;
                case '$lt':
                    fieldConditions.push({ $lt: [ifNullFieldPath, opVal] });
                    break;
                case '$lte':
                    fieldConditions.push({ $lte: [ifNullFieldPath, opVal] });
                    break;
                case '$in':
                    fieldConditions.push({ $in: [ifNullFieldPath, opVal] });
                    break;
                case '$nin':
                    fieldConditions.push({ $not: [{ $in: [ifNullFieldPath, opVal] }] });
                    break;
                case '$exists':
                    // { field: { $exists: true } } -> { $ne: [{ $type: "$field" }, "missing"] }
                    if (opVal) {
                        fieldConditions.push({ $ne: [{ $type: rawFieldPath }, 'missing'] });
                    } else {
                        fieldConditions.push({ $eq: [{ $type: rawFieldPath }, 'missing'] });
                    }
                    break;
                case '$regex':
                    // { name: { $regex: 'val', $options: 'i' } }

                    const options = value['$options'] || '';
                    fieldConditions.push(regexMatchGuarded(rawFieldPath, opVal, options));
                    break;
                case '$options':
                    // Handled in $regex
                    break;
                case '$type':
                    fieldConditions.push({ $eq: [{ $type: rawFieldPath }, opVal] });
                    break;
                case '$size':
                    // $size errors on a non-array value in the aggregation
                    // framework. Guard so a document whose field is missing or
                    // not an array degrades to "no match" instead of aborting
                    // the whole reconciliation / change-stream pipeline.
                    fieldConditions.push({ $cond: [{ $isArray: rawFieldPath }, { $eq: [{ $size: rawFieldPath }, opVal] }, false] });
                    break;

                default: {
                    // Tag field-level failures so normalizeTaskFilter can tell a
                    // genuine query misuse (must fail fast) apart from an
                    // aggregation expression it merely could not convert.
                    const err = new Error(
                        `ReactiveTasks: Operator '${op}' on field '${field}' is not supported in simple filter conversion. Use Aggregation syntax.`,
                    ) as UnsupportedFieldOperatorError;
                    err.isUnsupportedFieldOperator = true;
                    throw err;
                }
            }
        }

        if (fieldConditions.length === 0) {
            return null;
        }
        if (fieldConditions.length === 1) {
            return fieldConditions[0];
        }
        return { $and: fieldConditions };
    } else {
        return { $eq: [ifNullFieldPath, value] };
    }
}
