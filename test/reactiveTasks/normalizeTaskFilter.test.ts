import { normalizeTaskFilter } from '../../src/reactiveTasks/validateTaskFilter';

describe('normalizeTaskFilter', () => {
    it('converts a simple query filter to an aggregation expression', () => {
        expect(normalizeTaskFilter({ status: 'active' }, 'task')).toEqual({
            $eq: [{ $ifNull: ['$status', null] }, 'active'],
        });
    });

    it('keeps a genuine aggregation expression as-is', () => {
        // A logical wrapper of comparison EXPRESSIONS is valid aggregation and
        // must be preserved unchanged (queryToExpression cannot convert it).
        const expr = { $and: [{ $eq: ['$a', 1] }, { $gt: ['$b', 2] }] };
        expect(normalizeTaskFilter(expr, 'task')).toEqual(expr);
    });

    it('unwraps a single $expr', () => {
        expect(normalizeTaskFilter({ $expr: { $gt: ['$n', 5] } }, 'task')).toEqual({ $gt: ['$n', 5] });
    });

    // Regression: an unsupported field operator nested under a logical operator
    // used to be silently swallowed and the raw (invalid) filter returned, which
    // then crash-looped the shared change-stream pipeline. It must fail fast at
    // registration instead.
    it('throws for an unsupported field operator nested under $and', () => {
        expect(() => normalizeTaskFilter({ $and: [{ tags: { $elemMatch: { x: 1 } } }] }, 'task')).toThrow(/\$elemMatch/);
    });

    it('throws for an unsupported field operator nested under $or', () => {
        expect(() => normalizeTaskFilter({ $or: [{ a: 1 }, { tags: { $all: [1, 2] } }] }, 'task')).toThrow(/\$all/);
    });

    it('throws for an unsupported field operator at the top field level', () => {
        expect(() => normalizeTaskFilter({ tags: { $elemMatch: { x: 1 } } }, 'task')).toThrow(/\$elemMatch/);
    });

    it('returns undefined for a missing filter', () => {
        expect(normalizeTaskFilter(undefined, 'task')).toBeUndefined();
    });

    it('returns an empty expression for an empty filter object', () => {
        expect(normalizeTaskFilter({}, 'task')).toEqual({});
    });

    it('throws for a non-object filter', () => {
        expect(() => normalizeTaskFilter('status=active' as any, 'task')).toThrow(/Expected an object/);
    });

    it('throws for an array filter', () => {
        expect(() => normalizeTaskFilter([{ a: 1 }] as any, 'task')).toThrow(/Expected an object/);
    });

    it('unwraps when the conversion itself yields a single $expr key', () => {
        // { $expr: X } passes X through, so a double-wrapped $expr surfaces as
        // { $expr: inner } after conversion and must be unwrapped once more.
        expect(normalizeTaskFilter({ $expr: { $expr: { $gt: ['$n', 5] } } }, 'task')).toEqual({ $gt: ['$n', 5] });
    });
});
