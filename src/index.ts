import { init as initCronTasks, InitOptions as CronTasksInitOptions } from './cronTasks';
import { init as initGetCollection, InitOptions as GetCollectionInitOptions } from './getCollection';
import { init as initMongoClient, InitOptions as GetMongoClientInitOptions } from './getMongoClient';
import { OnError } from './OnError';
import { init as withLockInit } from './withLock';
export { cronTask, Interval, runCronTask, scheduleCronTaskImmediately, startCronTasks, stopCronTasks, TaskFunction, TaskId } from './cronTasks';
export { getCollection } from './getCollection';
export { getMongoClient } from './getMongoClient';
export { OnError } from './OnError';
export { withLock } from './withLock';
export { withTransaction } from './withTransaction';

let initCalled = false;

export type InitOptions = GetMongoClientInitOptions & Partial<CronTasksInitOptions> & Partial<GetCollectionInitOptions>;

const defaultOnError = (error: Error) => {
    console.error(error);
};

export async function init(options: InitOptions): Promise<void> {
    if (initCalled) {
        throw new Error('init method can be called only once.');
    }
    initCalled = true;

    const _onError = options.onError ?? defaultOnError;
    const onError: OnError = (error) => {
        try {
            _onError(error);
        } catch (onErrorFailure) {
            // intentionally suppress
        }
    };

    initGetCollection({ collectionFactory: options.collectionFactory ?? null });

    withLockInit({ onError });

    initCronTasks({
        runCronTasks: options.runCronTasks ?? true,
        cronExpressionParserOptions: options.cronExpressionParserOptions ?? {},
        onError,
    });

    await initMongoClient({
        ...options,
        autoConnect: options.autoConnect ?? true,
    });
}
