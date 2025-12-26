import { ReactiveTaskRetryStrategy } from '../../src/reactiveTasks/ReactiveTaskRetryStrategy';
import { RetryPolicy } from '../../src/reactiveTasks/ReactiveTaskTypes';

describe('ReactiveTaskRetryStrategy', () => {
    describe('calculateNextRetry', () => {
        beforeAll(() => {
            jest.useFakeTimers();
            jest.setSystemTime(new Date('2023-01-01T00:00:00Z'));
        });

        afterAll(() => {
            jest.useRealTimers();
        });

        it('should calculate linear backoff', () => {
            const policy: RetryPolicy = { type: 'linear', interval: '1m' };
            const strategy = new ReactiveTaskRetryStrategy(policy);

            expect(strategy.calculateNextRetry(1)).toEqual(new Date('2023-01-01T00:01:00Z'));
            expect(strategy.calculateNextRetry(2)).toEqual(new Date('2023-01-01T00:02:00Z'));
        });

        it('should calculate exponential backoff', () => {
            const policy: RetryPolicy = { type: 'exponential', min: '1s', max: '10s', factor: 2 };
            const strategy = new ReactiveTaskRetryStrategy(policy);

            // attempt 1: min = 1s
            expect(strategy.calculateNextRetry(1)).toEqual(new Date('2023-01-01T00:00:01Z'));
            // attempt 2: 1s * 2^1 = 2s
            expect(strategy.calculateNextRetry(2)).toEqual(new Date('2023-01-01T00:00:02Z'));
            // attempt 3: 1s * 2^2 = 4s
            expect(strategy.calculateNextRetry(3)).toEqual(new Date('2023-01-01T00:00:04Z'));
            // attempt 4: 1s * 2^3 = 8s
            expect(strategy.calculateNextRetry(4)).toEqual(new Date('2023-01-01T00:00:08Z'));
            // attempt 5: 1s * 2^4 = 16s (capped at 10s)
            expect(strategy.calculateNextRetry(5)).toEqual(new Date('2023-01-01T00:00:10Z'));
        });

        it('should calculate fixed backoff', () => {
            const policy: RetryPolicy = { type: 'fixed', interval: '10s' };
            const strategy = new ReactiveTaskRetryStrategy(policy);

            expect(strategy.calculateNextRetry(1)).toEqual(new Date('2023-01-01T00:00:10Z'));
            expect(strategy.calculateNextRetry(5)).toEqual(new Date('2023-01-01T00:00:10Z'));
        });

        it('should calculate series backoff', () => {
            const policy: RetryPolicy = { type: 'series', intervals: ['1s', '10s', '1m'] };
            const strategy = new ReactiveTaskRetryStrategy(policy);

            expect(strategy.calculateNextRetry(1)).toEqual(new Date('2023-01-01T00:00:01Z')); // index 0
            expect(strategy.calculateNextRetry(2)).toEqual(new Date('2023-01-01T00:00:10Z')); // index 1
            expect(strategy.calculateNextRetry(3)).toEqual(new Date('2023-01-01T00:01:00Z')); // index 2
            expect(strategy.calculateNextRetry(4)).toEqual(new Date('2023-01-01T00:01:00Z')); // index 2 (last)
        });

        it('should calculate cron schedule', () => {
            // cron-parser depends on local time or UTC? It usually handles timezones if specified.
            // Let's assume server time. Mocked to 2023-01-01T00:00:00Z (Sunday)
            const policy: RetryPolicy = { type: 'cron', expression: '0 12 * * *' }; // Every day at 12:00
            const strategy = new ReactiveTaskRetryStrategy(policy);

            const next = strategy.calculateNextRetry(1);

            // Calculate expected date based on local time (which cron-parser uses)
            const expected = new Date(Date.now());
            expected.setHours(12, 0, 0, 0);
            if (expected.getTime() <= Date.now()) {
                expected.setDate(expected.getDate() + 1);
            }

            expect(next.toISOString()).toBe(expected.toISOString());
        });

        it('should throw error for invalid cron expression', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'cron',
                    expression: 'invalid-cron',
                });
            }).toThrow(/Invalid cron expression 'invalid-cron'/);
        });

        it('should throw error for unknown policy type', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'unknown-policy-type',
                } as unknown as RetryPolicy);
            }).toThrow(/Invalid retry policy type: 'unknown-policy-type'/);
        });

        it('should throw error for series policy without intervals', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'series',
                    intervals: [],
                });
            }).toThrow(/Series retry policy requires non-empty 'intervals' array/);
        });

        it('should throw error for fixed policy without interval', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'fixed',
                } as unknown as RetryPolicy);
            }).toThrow(/Retry policy requires 'interval' to be specified/);
        });

        it('should throw error for invalid interval format', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'fixed',
                    interval: 'not-a-duration',
                });
            }).toThrow(/Invalid duration format for 'interval'/);
        });

        it('should throw error for exponential policy without min', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'exponential',
                } as unknown as RetryPolicy);
            }).toThrow(/Retry policy requires 'min' to be specified/);
        });

        it('should throw error for invalid maxDuration format', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'fixed',
                    interval: '1s',
                    maxDuration: 'invalid-duration',
                });
            }).toThrow(/Invalid duration format for 'maxDuration'/);
        });

        it('should throw error for invalid series interval', () => {
            expect(() => {
                new ReactiveTaskRetryStrategy({
                    type: 'series',
                    intervals: ['1s', 'not-valid', '5m'],
                });
            }).toThrow(/Invalid duration format for 'intervals\[1\]'/);
        });
    });

    describe('shouldFail', () => {
        it('should fail if maxAttempts exceeded', () => {
            const policy: RetryPolicy = { type: 'linear', interval: '1s', maxAttempts: 3 };
            const strategy = new ReactiveTaskRetryStrategy(policy);

            expect(strategy.shouldFail(1)).toBe(false);
            expect(strategy.shouldFail(2)).toBe(false);
            expect(strategy.shouldFail(3)).toBe(true);
            expect(strategy.shouldFail(4)).toBe(true);
        });

        it('should fail if maxDuration exceeded', () => {
            const policy: RetryPolicy = { type: 'linear', interval: '1s', maxDuration: '1h' };
            const strategy = new ReactiveTaskRetryStrategy(policy);

            const now = Date.now();
            const start = new Date(now - 30 * 60 * 1000); // 30 mins ago
            const startOld = new Date(now - 61 * 60 * 1000); // 61 mins ago

            expect(strategy.shouldFail(1, start)).toBe(false);
            expect(strategy.shouldFail(1, startOld)).toBe(true);
        });
    });
});
