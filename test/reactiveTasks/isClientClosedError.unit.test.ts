import { isClientClosedError } from '../../src/reactiveTasks/ReactiveTaskTypes';

describe('isClientClosedError', () => {
    it('matches the modern driver class name', () => {
        const err = new Error('client closed');
        err.name = 'MongoClientClosedError';
        expect(isClientClosedError(err)).toBe(true);
    });

    it('matches the legacy (driver <6.6) topology-closed message', () => {
        expect(isClientClosedError(new Error('Topology is closed'))).toBe(true);
    });

    it('rejects unrelated errors and non-errors', () => {
        expect(isClientClosedError(new Error('boom'))).toBe(false);
        expect(isClientClosedError('Topology is closed')).toBe(false);
        expect(isClientClosedError(undefined)).toBe(false);
    });
});
