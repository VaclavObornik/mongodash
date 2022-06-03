import { addOnInfoListener } from './OnInfo';
import type { Registry, Gauge } from 'prom-client';
import { CODE_CRON_TASK_FAILED, CODE_CRON_TASK_FINISHED, CronTaskResultInfo, getTaskDatabaseInfo } from './cronTasks';

export type MonitoringOptions = {
    register: Registry;
    publishCronTasksStatistics?: boolean;
    cronTaskStatisticsBuckets?: number[];
    publishCronTasksStates?: boolean;
    publishCronTasksSchedules?: boolean;
    maxTimeMS?: number;
};

let schedulesMetric: Gauge<string>;

export async function init({ register, publishCronTasksStatistics, cronTaskStatisticsBuckets, maxTimeMS }: MonitoringOptions): Promise<void> {
    if (publishCronTasksStatistics) {
        const promClient = await import('prom-client');
        const histogram = new promClient.Histogram({
            name: 'cron_task_duration',
            help: 'report duration and states of each task',
            labelNames: ['taskId', 'result'],
            registers: [register],
            buckets: cronTaskStatisticsBuckets ?? promClient.exponentialBuckets(50, 2, 20), // todo
        });

        // todo how to report currently running tasks?
        // does it make sense to do it in duration? or should we create a separate metric for this?

        schedulesMetric = new promClient.Gauge({
            name: 'cron_task_scheduled_in_seconds',
            help: 'report time to next run of task',
            labelNames: ['taskId'],
            registers: [register],
            async collect() {
                // todo
                const times = await getTaskDatabaseInfo(maxTimeMS ?? 5000);
                times.forEach((taskInfo) => {
                    schedulesMetric.set({ taskId: taskInfo.taskId }, Math.round(taskInfo.shouldRunAfterTime / 1000));
                });
            },
        });

        addOnInfoListener((info) => {
            const { code } = info;
            if (code === CODE_CRON_TASK_FINISHED || code === CODE_CRON_TASK_FAILED) {
                const castedInfo = info as CronTaskResultInfo;
                const labels = {
                    taskId: castedInfo.taskId,
                    result: code === CODE_CRON_TASK_FINISHED ? 'success' : 'error',
                };
                histogram.labels(labels).observe(castedInfo.duration);
            }
        });
    }
}


// todo it'd be great if we can provide getter to all metrics

// ok we probably could just export metrics to the regisztry? or can it help to export the registry itself?
