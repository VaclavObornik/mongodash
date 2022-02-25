/* eslint-disable @typescript-eslint/no-var-requires */
import * as assert from 'assert';
import { getNewInstance } from './testHelpers';
import { ValueProvider } from '../src/cache';
const { getConnectionString } = require('../tools/testingDatabase');

describe('Cache', () => {
    // each test has its new instance of mongodash
    let instance: ReturnType<typeof getNewInstance>;
    beforeEach(async () => {
        instance = getNewInstance();
        await instance.initInstance();
    });

    afterEach(() => instance.cleanUpInstance());

    it('should return an mongodb Collection instance', async () => {
        const orgId = 'bc1';

        const valueProvider1: ValueProvider<Record<any, any>, string> = (key, cachedVersion, noChange) => {
            return noChange;
        };

        const valueProvider2: ValueProvider<Record<any, any>, string> = (key, { noChange, freshValue }) => {
            return freshValue({ data: 'xxx' });
            return freshValue({ data: 'xxx' }, 5);
            return noChange;
        };

        const valueProvider3: ValueProvider<Record<any, any>, string> = async (key, { noChange, freshValue }) => {
            const result = await fetch('https://aaa.com');
            if (result.ok) {
                freshValue()
            }
        };



        const cacheOptions = {
            collectionName = 'cache',
            keepInMemory = false,
            valueProvider,
            lifeTime = 0,
            valueProtection,
            keepAfterLifespan = true,
            onError,
        };
        return persistentCache(
            orgId,
            {
                ifVersionNotMatch = null,
                timeout = Number.MAX_SAFE_INTEGER,
                timeoutIfEmpty = false,
            },
            () => {},
        );
    });
});
