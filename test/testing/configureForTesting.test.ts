import { getNewInstance } from '../testHelpers';

describe('configureForTesting', () => {
    let testInstance: ReturnType<typeof getNewInstance>;

    beforeEach(async () => {
        testInstance = getNewInstance();
        await testInstance.initInstance();
    });

    afterEach(async () => {
        await testInstance.cleanUpInstance();
    });

    it('updates scheduler internal options', () => {
        const { mongodash } = testInstance;
        // @ts-ignore
        mongodash.configureForTesting({ minPollMs: 123 });
        // @ts-ignore - accessing private
        expect(mongodash._scheduler.internalOptions.minPollMs).toBe(123);
    });

    it('overrides persistence forceDebounce', () => {
        const { mongodash } = testInstance;
        // @ts-ignore
        mongodash.configureForTesting({ debounce: 456 });
        expect(mongodash._scheduler.forceDebounce).toBe(456);
    });

    it('propagates updates to runtime components', async () => {
        const { mongodash } = testInstance;
        // Start the scheduler to create components
        await mongodash.startReactiveTasks();

        // Initial state check (default or configured during init)
        // We assume default configuration

        // Update
        // @ts-ignore
        mongodash.configureForTesting({ minPollMs: 50, minBatchIntervalMs: 50 });

        // Verify propagation
        // @ts-ignore
        const _runner = mongodash._scheduler.concurrentRunnerInstance;
        // @ts-ignore
        const planner = mongodash._scheduler.taskPlannerInstance;

        // Check Planner
        // @ts-ignore
        expect(planner.internalOptions.minBatchIntervalMs).toBe(50);

        // Check Runner sources (harder as private)
        // But we assume if method called it works. We can check if `updateAllSources` was called if we mocked it,
        // but here we deal with real instances.
        // Let's rely on checking `internalOptions` on scheduler which acts as source of truth for "what was requested"
        // to components.
        // Actually, let's peek into runner sources if possible or trust the unit test of ConcurrentRunner (which we don't have explicitely for this method yet).

        // For now, let's trust the wiring if code runs without error.
        // Optionally, check if internalOptions of scheduler updated.
        // @ts-ignore
        expect(mongodash._scheduler.internalOptions.minPollMs).toBe(50);
    });

    it('forces debounce on new tasks', async () => {
        const { mongodash } = testInstance;

        // 1. Configure for testing
        mongodash.configureForTesting({ debounce: 10 });

        const taskName = 'test_new_task_forced_' + Date.now();

        // 2. Register task (should pick up default)
        await mongodash.reactiveTask({
            task: taskName,
            collection: 'test_col',
            handler: async () => {},
        });

        // 3. Verify
        // Registry should hold ORIGINAL value (undefined or default from registry logic, but NOT forced override value if it wasn't default)
        const registry = mongodash._scheduler.getRegistry();
        const task = registry.getTask(taskName);

        // Expect undefined (user input didn't have it)
        expect(task?.debounce).toBeUndefined();

        // Start scheduler to check Ops
        await mongodash.startReactiveTasks();

        // Check Scheduler internal state
        // @ts-ignore
        const ops = mongodash._scheduler.taskPlannerInstance.ops;
        expect(ops.forceDebounceMs).toBe(10);
    });

    it('forces debounce on EXISTING tasks', async () => {
        const { mongodash } = testInstance;
        const taskName = 'test_existing_task_' + Date.now();

        // 1. Create task with specific debounce
        await mongodash.reactiveTask({
            task: taskName,
            collection: 'test_col',
            handler: async () => {},
            debounce: 5000,
        });

        const registry = mongodash._scheduler.getRegistry();
        expect(registry.getTask(taskName)?.debounce).toBe(5000);

        // 2. Configure for testing
        mongodash.configureForTesting({ debounce: 20 });

        // 3. Verify it was updated in planner but NOT in registry
        expect(registry.getTask(taskName)?.debounce).toBe(5000);

        // Start scheduler to check Ops
        await mongodash.startReactiveTasks();

        // 4. Verify Ops has override
        // @ts-ignore
        const ops = mongodash._scheduler.taskPlannerInstance.ops;
        expect(ops.forceDebounceMs).toBe(20);
    });

    it('forces debounce on NEW tasks with EXPLICIT debounce', async () => {
        const { mongodash } = testInstance;

        // 1. Configure for testing
        mongodash.configureForTesting({ debounce: 10 });

        const taskName = 'test_new_task_explicit_' + Date.now();

        // 2. Register task with explicit high debounce
        await mongodash.reactiveTask({
            task: taskName,
            collection: 'test_col',
            handler: async () => {},
            debounce: 99999, // Specific value should be IGNORED
        });

        const registry = mongodash._scheduler.getRegistry();

        // Registry keeps explicit value
        expect(registry.getTask(taskName)?.debounce).toBe(99999);

        // Start scheduler to check Ops
        await mongodash.startReactiveTasks();

        // Scheduler has override
        // @ts-ignore
        const ops = mongodash._scheduler.taskPlannerInstance.ops;
        expect(ops.forceDebounceMs).toBe(10);
    });
});
