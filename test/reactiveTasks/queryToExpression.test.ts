import { ObjectId } from 'mongodb';
import { queryToExpression } from '../../src/reactiveTasks/queryToExpression';

describe('queryToExpression', () => {
    it('should return empty object for empty query', () => {
        expect(queryToExpression({})).toEqual({});
        expect(queryToExpression(null as any)).toEqual({});
    });

    it('should handle implicit equality', () => {
        expect(queryToExpression({ a: 1 })).toEqual({ $eq: ['$a', 1] });
        expect(queryToExpression({ a: 's' })).toEqual({ $eq: ['$a', 's'] });
        expect(queryToExpression({ a: true })).toEqual({ $eq: ['$a', true] });
    });

    it('should handle null equality', () => {
        expect(queryToExpression({ a: null })).toEqual({ $eq: ['$a', null] });
    });

    it('should handle ObjectId equality', () => {
        const id = new ObjectId();
        expect(queryToExpression({ _id: id })).toEqual({ $eq: ['$_id', id] });
    });

    it('should handle Regex equality', () => {
        const regex = /test/i;
        expect(queryToExpression({ name: regex })).toEqual({
            $regexMatch: { input: '$name', regex: 'test', options: 'i' },
        });
    });

    it('should handle explicit equality ($eq)', () => {
        expect(queryToExpression({ a: { $eq: 5 } })).toEqual({ $eq: ['$a', 5] });
    });

    it('should handle comparison operators ($gt, $gte, $lt, $lte, $ne)', () => {
        expect(queryToExpression({ a: { $gt: 5 } })).toEqual({ $gt: ['$a', 5] });
        expect(queryToExpression({ a: { $gte: 5 } })).toEqual({ $gte: ['$a', 5] });
        expect(queryToExpression({ a: { $lt: 5 } })).toEqual({ $lt: ['$a', 5] });
        expect(queryToExpression({ a: { $lte: 5 } })).toEqual({ $lte: ['$a', 5] });
        expect(queryToExpression({ a: { $ne: 5 } })).toEqual({ $ne: ['$a', 5] });
    });

    it('should handle $in and $nin', () => {
        expect(queryToExpression({ a: { $in: [1, 2] } })).toEqual({ $in: ['$a', [1, 2]] });

        // $nin is converted to $not($in)
        expect(queryToExpression({ a: { $nin: [1, 2] } })).toEqual({
            $not: [{ $in: ['$a', [1, 2]] }],
        });
    });

    it('should handle $exists', () => {
        // Exists: true -> Type != missing
        expect(queryToExpression({ a: { $exists: true } })).toEqual({
            $ne: [{ $type: '$a' }, 'missing'],
        });

        // Exists: false -> Type == missing
        expect(queryToExpression({ a: { $exists: false } })).toEqual({
            $eq: [{ $type: '$a' }, 'missing'],
        });
    });

    it('should handle $regex operator', () => {
        expect(queryToExpression({ name: { $regex: 'pat' } })).toEqual({
            $regexMatch: { input: '$name', regex: 'pat', options: '' },
        });

        expect(queryToExpression({ name: { $regex: 'pat', $options: 'i' } })).toEqual({
            $regexMatch: { input: '$name', regex: 'pat', options: 'i' },
        });
    });

    it('should handle $type', () => {
        expect(queryToExpression({ a: { $type: 'string' } })).toEqual({
            $eq: [{ $type: '$a' }, 'string'],
        });
    });

    it('should handle $size', () => {
        expect(queryToExpression({ arr: { $size: 3 } })).toEqual({
            $eq: [{ $size: '$arr' }, 3],
        });
    });

    it('should handle multiple conditions on same field (Implicit AND)', () => {
        // { a: { $gt: 5, $lt: 10 } }
        const expr = queryToExpression({ a: { $gt: 5, $lt: 10 } });
        expect(expr).toEqual({
            $and: [{ $gt: ['$a', 5] }, { $lt: ['$a', 10] }],
        });
    });

    it('should handle multiple fields (Implicit AND)', () => {
        // { a: 1, b: 2 }
        const expr = queryToExpression({ a: 1, b: 2 });
        expect(expr).toEqual({
            $and: [{ $eq: ['$a', 1] }, { $eq: ['$b', 2] }],
        });
    });

    it('should handle top-level Logical Operators ($or, $and, $nor)', () => {
        // $or
        expect(queryToExpression({ $or: [{ a: 1 }, { b: 2 }] })).toEqual({
            $or: [{ $eq: ['$a', 1] }, { $eq: ['$b', 2] }],
        });

        // $and
        expect(queryToExpression({ $and: [{ a: 1 }, { b: 2 }] })).toEqual({
            $and: [{ $eq: ['$a', 1] }, { $eq: ['$b', 2] }],
        });

        // $nor
        expect(queryToExpression({ $nor: [{ a: 1 }, { b: 2 }] })).toEqual({
            $nor: [{ $eq: ['$a', 1] }, { $eq: ['$b', 2] }],
        });
    });

    it('should handle top-level $not', () => {
        // $not: { a: 1 } -> { $not: [ { $eq: ['$a', 1] } ] }
        expect(queryToExpression({ $not: { a: 1 } })).toEqual({
            $not: [{ $eq: ['$a', 1] }],
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

    it('should handle object equality', () => {
        // { meta: { type: 'foo' } } -> { $eq: ['$meta', { type: 'foo' }] }
        // This is exact match
        expect(queryToExpression({ meta: { type: 'foo' } })).toEqual({
            $eq: ['$meta', { type: 'foo' }],
        });
    });
});
