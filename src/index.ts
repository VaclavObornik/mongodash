import { init as initCronTasks, InitOptions as CronTasksInitOptions } from './cronTasks';
import { init as initGetCollection, InitOptions as GetCollectionInitOptions } from './getCollection';
import { init as initMongoClient, InitOptions as GetMongoClientInitOptions } from './getMongoClient';
import { defaultOnError, OnError, secureOnError } from './OnError';
import { defaultOnInfo, OnInfo, secureOnInfo } from './OnInfo';
import { init as withLockInit } from './withLock';
import { resolveInitPromise } from './initPromise';
export {
    cronTask,
    Interval,
    runCronTask,
    scheduleCronTaskImmediately,
    startCronTasks,
    stopCronTasks,
    TaskFunction,
    TaskId,
    CODE_CRON_TASK_STARTED,
    CODE_CRON_TASK_FINISHED,
    CODE_CRON_TASK_SCHEDULED,
    CODE_CRON_TASK_FAILED,
} from './cronTasks';
export { getCollection } from './getCollection';
export { getMongoClient } from './getMongoClient';
export { OnError } from './OnError';
export { withLock, isLockAlreadyAcquiredError, WithLockOptions, LockAlreadyAcquiredError } from './withLock';
export { withTransaction } from './withTransaction';

let initCalled = false;

type PackageOptions = {
    onError?: OnError;
    onInfo?: OnInfo;
};

export type InitOptions = PackageOptions & GetMongoClientInitOptions & Partial<CronTasksInitOptions> & Partial<GetCollectionInitOptions>;

export async function init(options: InitOptions): Promise<void> {
    if (initCalled) {
        throw new Error('init method can be called only once.');
    }
    initCalled = true;

    const onError = options.onError ? secureOnError(options.onError) : defaultOnError;
    const onInfo = options.onInfo ? secureOnInfo(options.onInfo) : defaultOnInfo;

    initGetCollection({ collectionFactory: options.collectionFactory ?? null });

    withLockInit({ onError });

    initCronTasks({
        runCronTasks: options.runCronTasks ?? true,
        cronExpressionParserOptions: options.cronExpressionParserOptions ?? {},
        onError,
        onInfo,
        cronTaskCaller: options.cronTaskCaller ?? ((task) => task()),
        cronTaskFilter: options.cronTaskFilter ?? (() => true),
    });

    await initMongoClient({
        ...options,
        autoConnect: options.autoConnect ?? true,
    });

    resolveInitPromise();
}
