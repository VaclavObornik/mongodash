import { resolveWhitelistFilter, WhitelistRule } from '../../src/testing/resolveWhitelistFilter';

type FindReturn = { toArray: () => Promise<Array<{ _id: unknown }>> };

function makeCollection(name: string, findResults: Array<{ _id: unknown }> = []) {
    const findCalls: Array<{ filter: unknown; options: unknown }> = [];
    const col = {
        collectionName: name,
        find: (filter: unknown, options: unknown): FindReturn => {
            findCalls.push({ filter, options });
            return { toArray: async () => findResults };
        },
    } as unknown as Parameters<typeof resolveWhitelistFilter>[1];
    return { col, findCalls };
}

describe('resolveWhitelistFilter', () => {
    it("returns 'skip' when no rule targets this collection", async () => {
        const { col } = makeCollection('orders');
        const rules: WhitelistRule[] = [{ collection: 'invoices' }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toBe('skip');
    });

    it("returns 'matchAll' when a rule has no filter and no task", async () => {
        const { col, findCalls } = makeCollection('orders');
        const rules: WhitelistRule[] = [{ collection: 'orders' }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toBe('matchAll');
        expect(findCalls).toHaveLength(0); // no source-collection scan needed
    });

    it('returns a task-only filter when rule specifies task but no filter', async () => {
        const { col } = makeCollection('orders');
        const rules: WhitelistRule[] = [{ collection: 'orders', task: 'process-order' }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toEqual({ $or: [{ task: 'process-order' }] });
    });

    it('returns a sourceDocId filter after scanning the source collection', async () => {
        const { col, findCalls } = makeCollection('orders', [{ _id: 'A' }, { _id: 'B' }]);
        const rules: WhitelistRule[] = [{ collection: 'orders', filter: { status: 'new' } }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toEqual({ $or: [{ sourceDocId: { $in: ['A', 'B'] } }] });
        expect(findCalls[0].filter).toEqual({ status: 'new' });
        expect(findCalls[0].options).toEqual({ projection: { _id: 1 } });
    });

    it('combines task + sourceDocId in the same rule', async () => {
        const { col } = makeCollection('orders', [{ _id: 'A' }]);
        const rules: WhitelistRule[] = [{ collection: 'orders', task: 't', filter: { x: 1 } }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toEqual({ $or: [{ task: 't', sourceDocId: { $in: ['A'] } }] });
    });

    it("returns 'skip' when a filter-only rule matches zero documents", async () => {
        const { col } = makeCollection('orders', []);
        const rules: WhitelistRule[] = [{ collection: 'orders', filter: { status: 'new' } }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toBe('skip');
    });

    it("'matchAll' wins over other rules on the same collection", async () => {
        const { col } = makeCollection('orders', []);
        const rules: WhitelistRule[] = [{ collection: 'orders', task: 't1' }, { collection: 'orders' }];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toBe('matchAll');
    });

    it('OR-merges multiple non-matchAll rules for the same collection', async () => {
        const { col } = makeCollection('orders', [{ _id: 'A' }]);
        const rules: WhitelistRule[] = [
            { collection: 'orders', task: 't1' },
            { collection: 'orders', filter: { status: 'new' } },
        ];

        const result = await resolveWhitelistFilter(rules, col);
        expect(result).toEqual({ $or: [{ task: 't1' }, { sourceDocId: { $in: ['A'] } }] });
    });
});
