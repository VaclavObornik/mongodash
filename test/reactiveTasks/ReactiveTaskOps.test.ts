import { ReactiveTaskOps } from '../../src/reactiveTasks/ReactiveTaskOps';
import { Collection } from 'mongodb';

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
                'scheduledAt',
                'resetRetriesOnDataChange',
            ];

            // Verify keys
            expect(projectedKeys.sort()).toEqual(expectedKeys.sort());

            // Specific negative assertion for debounce
            expect(projectedKeys).not.toContain('debounce');

            // Verify scheduledAt calculation
            expect(projectStage.$project.scheduledAt).toEqual({ $add: ['$$NOW', '$tasks.debounceMs'] });
        });
    });
});
