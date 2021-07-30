/* eslint-disable @typescript-eslint/no-var-requires */
import { Collection } from 'mongodb';
import * as _debug from 'debug';
import { InitOptions, OnError } from '../src';
const { getConnectionString, cleanTestingDatabases } = require('../tools/testingDatabase');

const debug = _debug('mongodash:testHelpers');

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function getNewInstance() {
    debug('getNewInstance');
    jest.resetModules();
    const mongodash = require('../src');

    let _onError: OnError = () => {}; // eslint-disable-line @typescript-eslint/no-empty-function

    function setOnError(onError: OnError): void {
        _onError = onError;
    }

    const collectionCalls: { [key: string]: number } = {};

    const usedCollections: { [key: string]: Collection } = {};

    const initInstance = async (initOptions: Partial<InitOptions> = {}) => {
        debug('initInstance');
        await cleanTestingDatabases();

        await mongodash.init({
            uri: getConnectionString(),

            onError: (error: Error) => _onError(error),

            // will serve single instances of collections during the tests so we can get
            // the same instances in test and manipulate with them using sinon
            collectionFactory: (name: string) => {
                if (!(name in usedCollections)) {
                    usedCollections[name] = mongodash.getCollection(name);
                }
                collectionCalls[name] = (collectionCalls[name] || 0) + 1;
                return usedCollections[name];
            },

            ...initOptions,
        });
    };

    const cleanUpInstance = async () => {
        debug('cleanUpInstance');
        mongodash.stopCronTasks();
        await mongodash.getMongoClient().close();
    };

    return {
        cleanUpInstance,
        setOnError,
        collectionCalls,
        mongodash: mongodash,
        initInstance,
    };
}

export async function wait(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}
