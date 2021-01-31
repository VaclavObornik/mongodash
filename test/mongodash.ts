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
});
