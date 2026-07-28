import { compileWatchProjection } from '../../src/reactiveTasks/compileWatchProjection';

describe('compileWatchProjection', () => {
    it('returns $$ROOT for a missing projection', () => {
        expect(compileWatchProjection(undefined)).toBe('$$ROOT');
    });

    it('returns $$ROOT for an empty projection object', () => {
        expect(compileWatchProjection({})).toBe('$$ROOT');
    });

    it('converts shorthand inclusion (1/true) to field paths', () => {
        expect(compileWatchProjection({ a: 1, b: true })).toEqual({ a: '$a', b: '$b' });
    });

    it('keeps computed (non-1) values as-is', () => {
        expect(compileWatchProjection({ total: { $add: ['$a', '$b'] }, label: 'fixed' })).toEqual({
            total: { $add: ['$a', '$b'] },
            label: 'fixed',
        });
    });

    it('unflattens dotted keys', () => {
        expect(compileWatchProjection({ 'a.b': 1 })).toEqual({ a: { b: '$a.b' } });
    });

    it('merges dotted keys sharing a prefix into one nested object', () => {
        // Second key must reuse the already-created intermediate object.
        expect(compileWatchProjection({ 'a.b': 1, 'a.c': 1, 'a.d.e': true })).toEqual({
            a: { b: '$a.b', c: '$a.c', d: { e: '$a.d.e' } },
        });
    });

    it('throws on exclusion style projection (0 and false)', () => {
        expect(() => compileWatchProjection({ a: 0 })).toThrow(/Exclusion style projection/);
        expect(() => compileWatchProjection({ a: false })).toThrow(/Exclusion style projection/);
    });

    it('returns the cached result for the same projection object instance', () => {
        const projection = { 'x.y': 1 };
        const first = compileWatchProjection(projection);
        const second = compileWatchProjection(projection);
        expect(second).toBe(first);
    });

    it('caches the $$ROOT result for the same empty object instance', () => {
        const projection = {};
        expect(compileWatchProjection(projection)).toBe('$$ROOT');
        expect(compileWatchProjection(projection)).toBe('$$ROOT');
    });
});
