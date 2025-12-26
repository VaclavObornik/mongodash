import { Document, Filter } from 'mongodb';

/**
 * Recursively prefixes all keys in a MongoDB filter object.
 * This is used to apply a filter meant for a document to a field
 * within a larger document, such as 'fullDocument' in a change stream event.
 *
 * @param filter The filter object to process.
 * @param prefix The prefix to add to each key (e.g., 'fullDocument').
 * @returns A new filter object with all keys prefixed.
 */
export function prefixFilterKeys<T extends Document>(filter: Filter<T>, prefix: string): Filter<T> {
    const newFilter: Filter<T> = {};

    for (const key in filter) {
        if (Object.prototype.hasOwnProperty.call(filter, key)) {
            const value = filter[key as keyof Filter<T>];

            if (key === '$expr') {
                // Handle $expr specially: we need to prefix field paths inside it
                newFilter[key as keyof Filter<T>] = prefixExpr(value, prefix);
            } else if (key.startsWith('$')) {
                // Handle logical operators like $or, $and, $nor
                if (Array.isArray(value) && (key === '$or' || key === '$and' || key === '$nor')) {
                    newFilter[key as keyof Filter<T>] = value.map((item) =>
                        typeof item === 'object' && item !== null && !Array.isArray(item) ? prefixFilterKeys(item as Filter<T>, prefix) : item,
                    ) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
                } else {
                    // For other operators ($in, $eq, etc.), keep them as they are.
                    newFilter[key as keyof Filter<T>] = value;
                }
            } else {
                // For regular field names, add the prefix.
                const newKey = `${prefix}.${key}`;
                newFilter[newKey as keyof Filter<T>] = value;
            }
        }
    }

    return newFilter;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function prefixExpr(expr: any, prefix: string): any {
    if (Array.isArray(expr)) {
        return expr.map((item) => prefixExpr(item, prefix));
    } else if (typeof expr === 'object' && expr !== null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newExpr: any = {};
        for (const key in expr) {
            newExpr[key] = prefixExpr(expr[key], prefix);
        }
        return newExpr;
    } else if (typeof expr === 'string') {
        // Prefix field paths (starting with $) but not system variables (starting with $$)
        if (expr.startsWith('$') && !expr.startsWith('$$')) {
            return `$${prefix}.${expr.substring(1)}`;
        }
    }
    return expr;
}
