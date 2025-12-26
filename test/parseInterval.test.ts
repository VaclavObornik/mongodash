import { createIntervalFunction } from '../src/parseInterval';

describe('createIntervalFunction', () => {
    describe('number input', () => {
        it('should accept number as milliseconds', () => {
            const getNext = createIntervalFunction(3600000);
            const now = Date.now();
            const next = getNext();
            expect(next.getTime()).toBeGreaterThanOrEqual(now + 3600000);
            // Allow small delta for execution time
            expect(next.getTime()).toBeLessThan(now + 3600000 + 100);
        });

        it('should throw for non-finite numbers', () => {
            expect(() => createIntervalFunction(Infinity)).toThrow(/finite/);
            expect(() => createIntervalFunction(NaN)).toThrow(/finite/);
        });
    });

    describe('duration string input', () => {
        it('should parse hours', () => {
            const getNext = createIntervalFunction('1h');
            const now = Date.now();
            const next = getNext();
            expect(next.getTime()).toBeGreaterThanOrEqual(now + 3600000);
        });

        it('should parse days', () => {
            const getNext = createIntervalFunction('7d');
            const now = Date.now();
            const next = getNext();
            expect(next.getTime()).toBeGreaterThanOrEqual(now + 7 * 24 * 60 * 60 * 1000);
        });

        it('should parse milliseconds', () => {
            const getNext = createIntervalFunction('500ms');
            const now = Date.now();
            const next = getNext();
            expect(next.getTime()).toBeGreaterThanOrEqual(now + 500);
        });

        it('should throw for invalid duration string', () => {
            expect(() => createIntervalFunction('invalid')).toThrow(/Invalid interval/);
        });
    });

    describe('cron expression input (with CRON prefix)', () => {
        it('should parse cron expression with CRON prefix and calculate interval', () => {
            // Every minute - next occurrence
            const getNext = createIntervalFunction('CRON * * * * *');
            const next = getNext();
            expect(next.getTime()).toBeGreaterThan(Date.now());
            // Should be less than 60 seconds from now
            expect(next.getTime() - Date.now()).toBeLessThanOrEqual(60 * 1000);
        });

        it('should respect referenceDate', () => {
            // 3am daily
            const getNext = createIntervalFunction('CRON 0 3 * * *', { cronOptions: { tz: 'UTC' } });
            const refDate = new Date('2023-01-01T10:00:00Z');
            const next = getNext(refDate);
            // Should be 2023-01-02T03:00:00Z
            expect(next.toISOString()).toBe('2023-01-02T03:00:00.000Z');
        });

        it('should be stateless', () => {
            const getNext = createIntervalFunction('CRON 0 3 * * *', { cronOptions: { tz: 'UTC' } });
            const refDate1 = new Date('2023-01-01T10:00:00Z');
            const next1 = getNext(refDate1);
            expect(next1.toISOString()).toBe('2023-01-02T03:00:00.000Z');

            const refDate2 = new Date('2023-01-05T10:00:00Z');
            const next2 = getNext(refDate2);
            expect(next2.toISOString()).toBe('2023-01-06T03:00:00.000Z');
        });

        it('should be case insensitive for CRON prefix', () => {
            const getNext1 = createIntervalFunction('CRON * * * * *');
            const getNext2 = createIntervalFunction('cron * * * * *');
            expect(getNext1().getTime()).toBeGreaterThan(Date.now());
            expect(getNext2().getTime()).toBeGreaterThan(Date.now());
        });

        it('should throw for invalid cron expression', () => {
            expect(() => createIntervalFunction('CRON invalid')).toThrow(/Invalid interval/);
        });

        it('should NOT treat string with spaces as cron without CRON prefix', () => {
            // Without CRON prefix, spaces in string should be treated as duration (and fail)
            expect(() => createIntervalFunction('0 3 * * *')).toThrow(/Invalid interval/);
        });
    });
});
