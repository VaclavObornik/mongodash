import { Document } from 'mongodb';

const projectionCache = new WeakMap<object, Document | string>();

/**
 * Compiles a user-friendly watchProjection into a strict Aggregation Expression.
 * This handles:
 * 1. Unflattening dotted keys (e.g. {'a.b': 1} -> {a: {b: '$a.b'}})
 * 2. Converting shorthand inclusion (1/true) to field paths ('$key')
 * 3. Validating that no unsupported features (like exclusion) are used.
 *
 * @param projection The user-provided projection.
 * @returns An aggregation expression or string '$$ROOT'.
 */
export function compileWatchProjection(projection?: Document): Document | string {
    if (!projection) {
        return '$$ROOT';
    }

    if (projectionCache.has(projection)) {
        return projectionCache.get(projection)!;
    }

    if (Object.keys(projection).length === 0) {
        const result = '$$ROOT';
        projectionCache.set(projection, result);
        return result;
    }

    const expression: Document = {};
    for (const [key, value] of Object.entries(projection)) {
        let targetValue: unknown;
        if (value === 1 || value === true) {
            targetValue = `$${key}`;
        } else if (value === 0 || value === false) {
            throw new Error('Exclusion style projection (0) is not supported in watchProjection yet. Use explicit inclusion or computed fields.');
        } else {
            targetValue = value;
        }

        // Handle dotted keys by unflattening them
        const parts = key.split('.');
        let current = expression;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (i === parts.length - 1) {
                current[part] = targetValue;
            } else {
                if (!current[part]) {
                    current[part] = {};
                }
                current = current[part];
            }
        }
    }

    projectionCache.set(projection, expression);
    return expression;
}
