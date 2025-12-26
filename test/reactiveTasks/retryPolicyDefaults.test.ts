import { ReactiveTaskRegistry } from '../../src/reactiveTasks/ReactiveTaskRegistry';
import { ReactiveTaskRetryStrategy } from '../../src/reactiveTasks/ReactiveTaskRetryStrategy';
import * as mongodash from '../../src';

describe('Reactive Task Retry Policy Defaults', () => {
    let registry: ReactiveTaskRegistry;

    beforeAll(async () => {
        // Mock collection with required methods
        const mockCollection: any = {
            collectionName: 'mock-collection',
            createIndex: async () => {},
            findOne: async () => null,
            updateOne: async () => {},
        };

        await mongodash.init({
            // Mock client provided, so no URI needed
            mongoClient: {
                connect: async () => {},
                db: () => ({ collection: () => mockCollection }),
            } as any,

            collectionFactory: () => mockCollection,
        });
    });

    beforeEach(() => {
        registry = new ReactiveTaskRegistry();
    });

    it('should default maxAttempts to 5 if no policy provided', async () => {
        const taskDef: any = {
            task: 'no-policy',
            collection: 'test',
            handler: async () => {},
        };

        await registry.addTask(taskDef);
        const registered = registry.getTask('no-policy');

        // Registry fills a default policy if none provided
        expect(registered?.retryStrategy.policy.maxAttempts).toBe(5);
    });

    it('should default maxAttempts to 5 if policy provided without duration or attempts', async () => {
        const taskDef: any = {
            task: 'empty-policy',
            collection: 'test',
            handler: async () => {},
            retryPolicy: { type: 'fixed', interval: '1s' },
        };

        await registry.addTask(taskDef);
        const registered = registry.getTask('empty-policy');

        expect(registered?.retryStrategy.policy.maxAttempts).toBe(5);
    });

    it('should NOT set maxAttempts if maxDuration IS provided', async () => {
        const taskDef: any = {
            task: 'duration-only',
            collection: 'test',
            handler: async () => {},
            retryPolicy: { type: 'fixed', interval: '1s', maxDuration: '1h' },
        };

        await registry.addTask(taskDef);
        const registered = registry.getTask('duration-only');

        expect(registered?.retryStrategy.policy.maxAttempts).toBeUndefined();
    });

    it('should respect explicit maxAttempts even if maxDuration is provided', async () => {
        const taskDef: any = {
            task: 'duration-and-attempts',
            collection: 'test',
            handler: async () => {},
            retryPolicy: { type: 'fixed', interval: '1s', maxDuration: '1h', maxAttempts: 10 },
        };

        await registry.addTask(taskDef);
        const registered = registry.getTask('duration-and-attempts');

        expect(registered?.retryStrategy.policy.maxAttempts).toBe(10);
    });
});

describe('ReactiveTaskRetryStrategy - Infinity Support', () => {
    it('should allow infinite attempts if maxAttempts is -1', () => {
        const strategy = new ReactiveTaskRetryStrategy({
            type: 'fixed',
            interval: '1s',
            maxAttempts: -1,
        });

        // Even after 1000 attempts, shouldFail should be false
        expect(strategy.shouldFail(1)).toBe(false);
        expect(strategy.shouldFail(100)).toBe(false);
        expect(strategy.shouldFail(1000)).toBe(false);
    });

    it('should allow infinite attempts if maxAttempts is undefined', () => {
        const strategy = new ReactiveTaskRetryStrategy({
            type: 'fixed',
            interval: '1s',
            // maxAttempts undefined
        });

        expect(strategy.shouldFail(100)).toBe(false);
    });

    it('should fail if attempts >= maxAttempts (when positive)', () => {
        const strategy = new ReactiveTaskRetryStrategy({
            type: 'fixed',
            interval: '1s',
            maxAttempts: 3,
        });

        expect(strategy.shouldFail(1)).toBe(false);
        expect(strategy.shouldFail(2)).toBe(false);
        expect(strategy.shouldFail(3)).toBe(true); // 3rd attempt failed -> stop
        expect(strategy.shouldFail(4)).toBe(true);
    });
});
