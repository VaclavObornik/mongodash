import { Collection } from 'mongodb';
import { ReactiveTaskOps } from '../../src/reactiveTasks/ReactiveTaskOps';

describe('ReactiveTaskOps', () => {
    describe('generatePlanningPipeline', () => {
        it('should ensure the planned task document matches the expected shape (no extra fields)', () => {
            // Mock Registry
            const mockRegistry: any = {
                getEntry: () => ({
                    sourceCollection: { collectionName: 'source_coll' } as Collection,
                    tasksCollection: { collectionName: 'tasks_coll' } as Collection,
                    tasks: new Map([
                        [
                            'test_task',
                            {
                                task: 'test_task',
                                sourceCollection: { collectionName: 'source_coll' } as Collection,
                                tasksCollection: { collectionName: 'tasks_coll' } as Collection,
                                debounce: 1000,
                                watchProjection: { field1: 1 },
                                retryStrategy: {
                                    policy: {
                                        resetRetriesOnDataChange: true,
                                    },
                                },
                                initPromise: Promise.resolve(),
                            },
                        ],
                    ]),
                }),
            };

            const ops = new ReactiveTaskOps(mockRegistry, jest.fn());

            // Access private method
            const pipeline = (ops as any).generatePlanningPipeline(mockRegistry.getEntry('source_coll'), {});

            // Find the $project stage that prepares the document for $merge
            // It should be the one after $unwind
            const unwindIndex = pipeline.findIndex((stage: any) => stage.$unwind);
            expect(unwindIndex).toBeGreaterThan(-1);

            const projectStage = pipeline[unwindIndex + 1];
            expect(projectStage).toBeDefined();
            expect(projectStage.$project).toBeDefined();

            const projectedKeys = Object.keys(projectStage.$project);

            // Define the EXACT expected keys
            const expectedKeys = [
                'sourceDocId',
                'task',
                'lastObservedValues',
                'status',
                'attempts',
                'createdAt',
                'updatedAt',
                'nextRunAt',
                'dueAt',
                'resetRetriesOnDataChange',
            ];

            // Verify keys
            expect(projectedKeys.sort()).toEqual(expectedKeys.sort());

            // Specific negative assertion for debounce
            expect(projectedKeys).not.toContain('debounce');

            // Verify nextRunAt calculation
            expect(projectStage.$project.nextRunAt).toEqual({ $add: ['$$NOW', '$tasks.debounceMs'] });
            // Verify dueAt calculation
            expect(projectStage.$project.dueAt).toEqual({ $add: ['$$NOW', '$tasks.debounceMs'] });
        });
    });

    describe('dueAt calculation logic', () => {
        it('should include correct dueAt update logic in pipeline', () => {
            const mockRegistry: any = {
                getEntry: () => ({
                    sourceCollection: { collectionName: 'source_coll' } as Collection,
                    tasksCollection: { collectionName: 'tasks_coll' } as Collection,
                    tasks: new Map([['t1', { task: 't1', debounceMs: 1000, retryStrategy: { policy: {} } }]]),
                }),
            };
            const ops = new ReactiveTaskOps(mockRegistry, jest.fn());
            const pipeline = (ops as any).generatePlanningPipeline(mockRegistry.getEntry('source_coll'), {});

            // Find the $merge stage
            const mergeStage = pipeline.find((stage: any) => stage.$merge);
            expect(mergeStage).toBeDefined();

            // Find the $set stage within whenMatched
            const setStage = mergeStage.$merge.whenMatched.find((stage: any) => stage.$set && stage.$set.dueAt);
            expect(setStage).toBeDefined();

            const dueAtLogic = setStage.$set.dueAt;
            expect(dueAtLogic).toBeDefined();

            // Structure: $cond: { if: '$hasChanged', then: { ... }, else: '$dueAt' }
            expect(dueAtLogic.$cond.if).toBe('$hasChanged');
            expect(dueAtLogic.$cond.else).toBe('$dueAt');

            // Inner logic: Simplified - always reset if hasChanged
            expect(dueAtLogic.$cond.if).toBe('$hasChanged');
            expect(dueAtLogic.$cond.then).toBe('$$new.dueAt');
            expect(dueAtLogic.$cond.else).toBe('$dueAt');
        });
    });
});
