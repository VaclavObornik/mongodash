import { ObjectId } from 'mongodb';
import { queryToExpression } from '../../src/reactiveTasks/queryToExpression';

describe('queryToExpression', () => {
    it('should return empty object for empty query', () => {
        expect(queryToExpression({})).toEqual({});
        expect(queryToExpression(null as any)).toEqual({});
    });

    it('should handle implicit equality with $ifNull', () => {
        expect(queryToExpression({ a: 1 })).toEqual({ $eq: [{ $ifNull: ['$a', null] }, 1] });
        expect(queryToExpression({ a: 's' })).toEqual({ $eq: [{ $ifNull: ['$a', null] }, 's'] });
        expect(queryToExpression({ a: true })).toEqual({ $eq: [{ $ifNull: ['$a', null] }, true] });
    });

    it('should handle null equality with $ifNull', () => {
        expect(queryToExpression({ a: null })).toEqual({ $eq: [{ $ifNull: ['$a', null] }, null] });
    });

    it('should handle ObjectId equality with $ifNull', () => {
        const id = new ObjectId();
        expect(queryToExpression({ _id: id })).toEqual({ $eq: [{ $ifNull: ['$_id', null] }, id] });
    });

    it('should handle Regex equality (no $ifNull on input)', () => {
        const regex = /test/i;
        expect(queryToExpression({ name: regex })).toEqual({
            $regexMatch: { input: '$name', regex: 'test', options: 'i' },
        });
    });

    it('should handle explicit equality ($eq) with $ifNull', () => {
        expect(queryToExpression({ a: { $eq: 5 } })).toEqual({ $eq: [{ $ifNull: ['$a', null] }, 5] });
    });

    it('should handle comparison operators ($gt, $gte, $lt, $lte, $ne) with $ifNull', () => {
        expect(queryToExpression({ a: { $gt: 5 } })).toEqual({ $gt: [{ $ifNull: ['$a', null] }, 5] });
        expect(queryToExpression({ a: { $gte: 5 } })).toEqual({ $gte: [{ $ifNull: ['$a', null] }, 5] });
        expect(queryToExpression({ a: { $lt: 5 } })).toEqual({ $lt: [{ $ifNull: ['$a', null] }, 5] });
        expect(queryToExpression({ a: { $lte: 5 } })).toEqual({ $lte: [{ $ifNull: ['$a', null] }, 5] });
        expect(queryToExpression({ a: { $ne: 5 } })).toEqual({ $ne: [{ $ifNull: ['$a', null] }, 5] });
    });

    it('should handle $in and $nin with $ifNull', () => {
        expect(queryToExpression({ a: { $in: [1, 2] } })).toEqual({ $in: [{ $ifNull: ['$a', null] }, [1, 2]] });

        // $nin is converted to $not($in)
        expect(queryToExpression({ a: { $nin: [1, 2] } })).toEqual({
            $not: [{ $in: [{ $ifNull: ['$a', null] }, [1, 2]] }],
        });
    });

    it('should handle $exists (no $ifNull on type check)', () => {
        // Exists: true -> Type != missing
        expect(queryToExpression({ a: { $exists: true } })).toEqual({
            $ne: [{ $type: '$a' }, 'missing'],
        });

        // Exists: false -> Type == missing
        expect(queryToExpression({ a: { $exists: false } })).toEqual({
            $eq: [{ $type: '$a' }, 'missing'],
        });
    });

    it('should handle $regex operator (no $ifNull on input)', () => {
        expect(queryToExpression({ name: { $regex: 'pat' } })).toEqual({
            $regexMatch: { input: '$name', regex: 'pat', options: '' },
        });

        expect(queryToExpression({ name: { $regex: 'pat', $options: 'i' } })).toEqual({
            $regexMatch: { input: '$name', regex: 'pat', options: 'i' },
        });
    });

    it('should handle $type (no $ifNull on type check)', () => {
        expect(queryToExpression({ a: { $type: 'string' } })).toEqual({
            $eq: [{ $type: '$a' }, 'string'],
        });
    });

    it('should handle $size (no $ifNull on size check)', () => {
        expect(queryToExpression({ arr: { $size: 3 } })).toEqual({
            $eq: [{ $size: '$arr' }, 3],
        });
    });

    it('should handle multiple conditions on same field (Implicit AND)', () => {
        // { a: { $gt: 5, $lt: 10 } }
        const expr = queryToExpression({ a: { $gt: 5, $lt: 10 } });
        expect(expr).toEqual({
            $and: [{ $gt: [{ $ifNull: ['$a', null] }, 5] }, { $lt: [{ $ifNull: ['$a', null] }, 10] }],
        });
    });

    it('should handle multiple fields (Implicit AND)', () => {
        // { a: 1, b: 2 }
        const expr = queryToExpression({ a: 1, b: 2 });
        expect(expr).toEqual({
            $and: [{ $eq: [{ $ifNull: ['$a', null] }, 1] }, { $eq: [{ $ifNull: ['$b', null] }, 2] }],
        });
    });

    it('should handle top-level Logical Operators ($or, $and, $nor)', () => {
        // $or
        expect(queryToExpression({ $or: [{ a: 1 }, { b: 2 }] })).toEqual({
            $or: [{ $eq: [{ $ifNull: ['$a', null] }, 1] }, { $eq: [{ $ifNull: ['$b', null] }, 2] }],
        });

        // $and
        expect(queryToExpression({ $and: [{ a: 1 }, { b: 2 }] })).toEqual({
            $and: [{ $eq: [{ $ifNull: ['$a', null] }, 1] }, { $eq: [{ $ifNull: ['$b', null] }, 2] }],
        });

        // $nor
        expect(queryToExpression({ $nor: [{ a: 1 }, { b: 2 }] })).toEqual({
            $nor: [{ $eq: [{ $ifNull: ['$a', null] }, 1] }, { $eq: [{ $ifNull: ['$b', null] }, 2] }],
        });
    });

    it('should handle top-level $not', () => {
        // $not: { a: 1 } -> { $not: [ { $eq: [{ $ifNull: ['$a', null] }, 1] } ] }
        expect(queryToExpression({ $not: { a: 1 } })).toEqual({
            $not: [{ $eq: [{ $ifNull: ['$a', null] }, 1] }],
        });
    });

    it('should pass-through $expr', () => {
        const rawExpr = { $gt: ['$field', 10] };
        expect(queryToExpression({ $expr: rawExpr })).toEqual(rawExpr);
    });

    it('should throw on invalid Logical Operator values', () => {
        expect(() => queryToExpression({ $or: 'not-array' } as any)).toThrow(/must be an array/);
    });

    it('should throw on unsupported top-level operators', () => {
        expect(() => queryToExpression({ $text: { $search: 'foo' } })).toThrow(/not supported/);
    });

    it('should throw on unsupported field operators', () => {
        expect(() => queryToExpression({ a: { $elemMatch: { b: 1 } } })).toThrow(/not supported/);
    });

    it('should handle object equality with $ifNull', () => {
        // { meta: { type: 'foo' } } -> { $eq: [{ $ifNull: ['$meta', null] }, { type: 'foo' }] }
        expect(queryToExpression({ meta: { type: 'foo' } })).toEqual({
            $eq: [{ $ifNull: ['$meta', null] }, { type: 'foo' }],
        });
    });

    it('should handle dot notation with $ifNull', () => {
        expect(queryToExpression({ 'demo.assigned': { $in: [null, true] } })).toEqual({
            $in: [{ $ifNull: ['$demo.assigned', null] }, [null, true]],
        });
    });
});
