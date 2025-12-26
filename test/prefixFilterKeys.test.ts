import { prefixFilterKeys } from '../src/prefixFilterKeys';

describe('prefixFilterKeys', () => {
    describe('basic field prefixing', () => {
        it('should prefix simple field names', () => {
            const filter = { name: 'John', age: 30 };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                'fullDocument.name': 'John',
                'fullDocument.age': 30,
            });
        });

        it('should prefix nested field paths', () => {
            const filter = { 'address.city': 'NYC' };
            const result = prefixFilterKeys(filter, 'doc');
            expect(result).toEqual({
                'doc.address.city': 'NYC',
            });
        });

        it('should handle empty filter', () => {
            const result = prefixFilterKeys({}, 'prefix');
            expect(result).toEqual({});
        });
    });

    describe('logical operators', () => {
        it('should recursively prefix $and conditions', () => {
            const filter = {
                $and: [{ name: 'John' }, { age: { $gt: 25 } }],
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $and: [{ 'fullDocument.name': 'John' }, { 'fullDocument.age': { $gt: 25 } }],
            });
        });

        it('should recursively prefix $or conditions', () => {
            const filter = {
                $or: [{ status: 'active' }, { status: 'pending' }],
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $or: [{ 'fullDocument.status': 'active' }, { 'fullDocument.status': 'pending' }],
            });
        });

        it('should recursively prefix $nor conditions', () => {
            const filter = {
                $nor: [{ deleted: true }],
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $nor: [{ 'fullDocument.deleted': true }],
            });
        });

        it('should handle nested logical operators', () => {
            const filter = {
                $and: [{ $or: [{ a: 1 }, { b: 2 }] }, { c: 3 }],
            };
            const result = prefixFilterKeys(filter, 'doc');
            expect(result).toEqual({
                $and: [{ $or: [{ 'doc.a': 1 }, { 'doc.b': 2 }] }, { 'doc.c': 3 }],
            });
        });
    });

    describe('comparison operators', () => {
        it('should keep comparison operators as-is (not prefix them)', () => {
            const filter = { age: { $gt: 25, $lt: 50 } };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                'fullDocument.age': { $gt: 25, $lt: 50 },
            });
        });

        it('should preserve $in operator values', () => {
            const filter = { status: { $in: ['active', 'pending'] } };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                'fullDocument.status': { $in: ['active', 'pending'] },
            });
        });

        it('should preserve $eq operator', () => {
            const filter = { $eq: ['$field', 'value'] };
            const result = prefixFilterKeys(filter, 'fullDocument');
            // $eq at root level is passed through as-is (not a logical operator)
            expect(result).toEqual({
                $eq: ['$field', 'value'],
            });
        });
    });

    describe('$expr handling', () => {
        it('should prefix field paths in $expr', () => {
            const filter = {
                $expr: { $eq: ['$status', 'active'] },
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $expr: { $eq: ['$fullDocument.status', 'active'] },
            });
        });

        it('should not prefix system variables ($$NOW, $$ROOT, etc)', () => {
            const filter = {
                $expr: { $lt: ['$deadline', '$$NOW'] },
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $expr: { $lt: ['$fullDocument.deadline', '$$NOW'] },
            });
        });

        it('should handle nested $expr with arrays', () => {
            const filter = {
                $expr: {
                    $and: [{ $eq: ['$status', 'active'] }, { $gt: ['$count', 0] }],
                },
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $expr: {
                    $and: [{ $eq: ['$fullDocument.status', 'active'] }, { $gt: ['$fullDocument.count', 0] }],
                },
            });
        });

        it('should handle $expr with numbers and booleans', () => {
            const filter = {
                $expr: { $eq: [true, false] },
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $expr: { $eq: [true, false] },
            });
        });

        it('should handle $expr with null values', () => {
            const filter = {
                $expr: { $eq: ['$field', null] },
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $expr: { $eq: ['$fullDocument.field', null] },
            });
        });
    });

    describe('edge cases', () => {
        it('should handle non-object items in logical operator arrays', () => {
            // This is an unusual case but should be handled gracefully
            const filter = {
                $and: [{ name: 'John' }, null as any, 'string' as any],
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $and: [{ 'fullDocument.name': 'John' }, null, 'string'],
            });
        });

        it('should handle array values in non-logical operators', () => {
            const filter = {
                $someOperator: ['value1', 'value2'],
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            // Non-logical operators with arrays are kept as-is
            expect(result).toEqual({
                $someOperator: ['value1', 'value2'],
            });
        });

        it('should handle complex real-world filter', () => {
            const filter = {
                $and: [{ status: 'active' }, { $or: [{ priority: { $gte: 5 } }, { urgent: true }] }, { $expr: { $lt: ['$deadline', '$$NOW'] } }],
            };
            const result = prefixFilterKeys(filter, 'fullDocument');
            expect(result).toEqual({
                $and: [
                    { 'fullDocument.status': 'active' },
                    { $or: [{ 'fullDocument.priority': { $gte: 5 } }, { 'fullDocument.urgent': true }] },
                    { $expr: { $lt: ['$fullDocument.deadline', '$$NOW'] } },
                ],
            });
        });
    });
});
