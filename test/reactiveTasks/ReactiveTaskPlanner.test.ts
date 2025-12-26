import { ReactiveTaskPlanner } from '../../src/reactiveTasks/ReactiveTaskPlanner';

import { noop } from 'lodash';

describe('ReactiveTaskPlanner', () => {
    describe('getChangeStreamPipeline', () => {
        it('should project only necessary fields to reduce memory usage', () => {
            const mockRegistry: any = {
                getAllTasks: () => [
                    {
                        sourceCollection: { collectionName: 'testColl' },
                        filter: {},
                        tasksCollection: { collectionName: 'testColl_tasks' },
                        task: 'testTask',
                    },
                ],
                getEntry: () => undefined,
            };

            const planner = new ReactiveTaskPlanner(
                { findOne: jest.fn() } as any, // Mock GlobalsCollection
                'instance-id',
                mockRegistry,
                { onStreamError: noop, onTaskPlanned: noop },
                { batchSize: 100, batchIntervalMs: 1000, getNextCleanupDate: () => new Date() } as any,
            );

            // Access private method
            const pipeline = (planner as any).getChangeStreamPipeline();

            // Verify the last stage is a $project
            const lastStage = pipeline[pipeline.length - 1];
            expect(lastStage).toBeDefined();
            expect(lastStage.$project).toBeDefined();

            // Verify projected fields
            expect(lastStage.$project).toEqual({
                _id: 1,
                operationType: 1,
                ns: 1,
                documentKey: 1,
                clusterTime: 1,
            });

            // Explicitly ensure 'fullDocument' and 'updateDescription' are NOT present (by absence of inclusion or explicit exclusion if we used exclusion style)
            // Since we use inclusion style, they are excluded by default.
            expect(Object.keys(lastStage.$project)).not.toContain('fullDocument');
            expect(Object.keys(lastStage.$project)).not.toContain('updateDescription');
        });
    });
});
