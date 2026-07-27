import * as assert from 'assert';
import { getNewInstance } from './testHelpers';

describe('mongodash', () => {
    it('should be possible to init only once', async () => {
        const instance = getNewInstance();

        try {
            await instance.initInstance();

            await assert.rejects(() => instance.initInstance(), /Error: init method can be called only once./, 'Unexpected error message.');
        } finally {
            await instance.cleanUpInstance();
        }
    });

    it('should allow init to be retried after it failed to connect', async () => {
        // A common startup race: the app container comes up before MongoDB is
        // reachable. The failed attempt must not consume the one-shot init
        // guard, otherwise the app can never recover without a restart and
        // every awaiter of initPromise hangs forever.
        const instance = getNewInstance();

        try {
            // Unroutable address so connect() fails fast rather than hanging.
            await assert.rejects(() =>
                instance.mongodash.init({
                    uri: 'mongodb://127.0.0.1:1/mongodashRetryTest',
                    clientOptions: { serverSelectionTimeoutMS: 300 },
                } as never),
            );

            // The retry must NOT be refused with "can be called only once".
            await instance.initInstance();

            // And the instance is genuinely usable afterwards.
            const collection = instance.mongodash.getCollection('init_retry_probe');
            await collection.insertOne({ _id: 'ok' } as never);
            expect(await collection.countDocuments({ _id: 'ok' } as never)).toBe(1);
        } finally {
            await instance.cleanUpInstance();
        }
    }, 20000);

    it('should allow init to be retried after an invalid option', async () => {
        // Pure-config validation happens before any sub-system is handed its
        // one-shot config, so a typo does not consume the init guard and leave
        // initPromise pending forever.
        const instance = getNewInstance();

        try {
            await assert.rejects(() => instance.initInstance({ reactiveTaskCleanupInterval: 0 } as never), /positive/);

            await instance.initInstance();

            const collection = instance.mongodash.getCollection('init_option_retry_probe');
            await collection.insertOne({ _id: 'ok' } as never);
            expect(await collection.countDocuments({ _id: 'ok' } as never)).toBe(1);
        } finally {
            await instance.cleanUpInstance();
        }
    }, 20000);
});
