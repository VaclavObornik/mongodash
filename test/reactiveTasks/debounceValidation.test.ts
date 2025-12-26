import { createSandbox } from 'sinon';
import { getNewInstance } from '../testHelpers';

describe('reactiveTasks - debounce validation', () => {
    let instance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        instance = getNewInstance();
    }, 10000);

    afterEach(async () => {
        await instance.cleanUpInstance();
    });

    const sandbox = createSandbox();
    afterEach(() => sandbox.verifyAndRestore());

    const attemptRegisterTask = async (debounce: any) => {
        await instance.initInstance();
        // collection name doesn't matter much as we expect rejection before using it often
        const collection = instance.mongodash.getCollection('debounce_test');

        return instance.mongodash.reactiveTask({
            collection,
            task: 'debounceTestTask',
            filter: {},
            handler: async () => {},
            debounce,
        } as any);
    };

    it('should accept valid number duration (ms)', async () => {
        await expect(attemptRegisterTask(500)).resolves.not.toThrow();
        // Verify internal value
        const task = instance.mongodash._scheduler.getRegistry().getTask('debounceTestTask');
        expect(task).toBeDefined();
        expect(task?.debounceMs).toBe(500);
    });

    it('should accept valid string duration ("1s")', async () => {
        await expect(attemptRegisterTask('1s')).resolves.not.toThrow();
        const task = instance.mongodash._scheduler.getRegistry().getTask('debounceTestTask');
        expect(task).toBeDefined();
        expect(task?.debounceMs).toBe(1000);
    });

    it('should accept valid string duration ("500ms")', async () => {
        await expect(attemptRegisterTask('500ms')).resolves.not.toThrow();
        const task = instance.mongodash._scheduler.getRegistry().getTask('debounceTestTask');
        expect(task?.debounceMs).toBe(500);
    });

    it('should reject negative numbers', async () => {
        try {
            await attemptRegisterTask(-100);
            throw new Error('Should have thrown');
        } catch (e: any) {
            expect(e.message).toMatch(/must be a non-negative number/);
        }
    });

    it('should reject invalid string formats', async () => {
        try {
            await attemptRegisterTask('invalid');
            throw new Error('Should have thrown');
        } catch (e: any) {
            expect(e.message).toMatch(/Invalid duration format/);
        }
    });

    it('should default to 1000ms if undefined', async () => {
        await expect(attemptRegisterTask(undefined)).resolves.not.toThrow();
        const task = instance.mongodash._scheduler.getRegistry().getTask('debounceTestTask');
        expect(task?.debounceMs).toBe(1000);
    });
});
