import { createSecureHandler } from '../src/createSecureHandler';

describe('createSecureHandler', () => {
    it('returns the value of a successful sync handler', () => {
        const wrapped = createSecureHandler((a: number, b: number) => a + b);
        expect(wrapped(2, 3)).toBe(5);
    });

    it('suppresses a synchronous throw', () => {
        const wrapped = createSecureHandler(() => {
            throw new Error('boom');
        });
        expect(() => wrapped()).not.toThrow();
        expect(wrapped()).toBeUndefined();
    });

    it('suppresses an async rejection (no unhandled rejection)', async () => {
        const wrapped = createSecureHandler(async () => {
            throw new Error('async boom');
        });
        await expect(wrapped()).resolves.toBeUndefined();
    });

    it('resolves the value of a successful async handler', async () => {
        const wrapped = createSecureHandler(async () => 'ok');
        await expect(wrapped()).resolves.toBe('ok');
    });

    it('safely handles a thenable without a catch method', async () => {
        // A minimal thenable that rejects and has no .catch must not throw.
        const wrapped = createSecureHandler(() => ({
            then: (_resolve: (v: unknown) => void, reject: (e: unknown) => void) => reject(new Error('thenable boom')),
        }));
        await expect(wrapped()).resolves.toBeUndefined();
    });
});
