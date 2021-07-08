/* eslint-disable @typescript-eslint/no-var-requires */
import * as assert from 'assert';
import { MongoClient } from 'mongodb';
import { getNewInstance } from './testHelpers';
const { getConnectionString } = require('../tools/testingDatabase');

describe('getters', () => {
    describe('getCollection', function () {
        // each test has its new instance of mongodash
        let instance: ReturnType<typeof getNewInstance>;
        beforeEach(async () => {
            instance = getNewInstance();
            await instance.initInstance();
        });
        afterEach(() => instance.cleanUpInstance());

        it('should return an mongodb Collection instance', async () => {
            const collection = instance.mongodash.getCollection('someName');
            assert(collection.constructor.name === 'Collection');
            assert(collection.collectionName === 'someName');
        });
    });

    describe('getMongoClient', function () {
        it('should return an MongoClient instance if initialized with uri', async () => {
            const instance = getNewInstance();
            try {
                await instance.mongodash.init({ uri: getConnectionString() });
                const client = instance.mongodash.getMongoClient();
                assert.strictEqual(client.constructor.name, 'MongoClient');
                assert.strictEqual(client.s.options.useUnifiedTopology, true, 'The useUnifiedTopology should be used automatically');
            } finally {
                await instance.cleanUpInstance();
            }
        });

        it('should return the MongoClient instance if initialized mongoClient', async () => {
            const instance2 = getNewInstance();
            try {
                const mongoClient = new MongoClient(getConnectionString());
                await instance2.mongodash.init({ mongoClient: mongoClient });
                const client = instance2.mongodash.getMongoClient();
                assert.strictEqual(client, mongoClient);
            } finally {
                await instance2.cleanUpInstance();
            }
        });

        it('should not be possible to init with wrong argument combination', async () => {
            const instance1 = getNewInstance();
            await assert.rejects(
                () => instance1.mongodash.init({ mongoClient: new MongoClient('aaa'), uri: 'aaa' }),
                /Error: It is not possible use uri with ready mongoClient instance./,
            );

            const instance2 = getNewInstance();
            await assert.rejects(
                () => instance2.mongodash.init({ mongoClient: new MongoClient('aaa'), clientOptions: {} }),
                /Error: It is not possible use clientOptions with ready mongoClient instance./,
            );

            const instance3 = getNewInstance();
            await assert.rejects(
                () => instance3.mongodash.init({ clientOptions: {} }),
                /Error: The `mongoClient` or the connection `uri` parameter has to be specified./,
            );
        });

        it('autoConnect option should work', async () => {
            const uri = getConnectionString();

            // default value
            const instance1 = getNewInstance();
            try {
                await instance1.mongodash.init({ uri });
                assert.strictEqual(instance1.mongodash.getMongoClient().isConnected(), true);
            } finally {
                await instance1.cleanUpInstance();
            }

            // 'true' value
            const instance2 = getNewInstance();
            try {
                await instance2.mongodash.init({ uri, autoConnect: true });
                assert.strictEqual(instance2.mongodash.getMongoClient().isConnected(), true);
            } finally {
                await instance2.cleanUpInstance();
            }

            // 'false' value
            const instance3 = getNewInstance();
            try {
                await instance3.mongodash.init({ uri, autoConnect: false });
                assert.strictEqual(instance3.mongodash.getMongoClient().isConnected(), false);
            } finally {
                await instance3.cleanUpInstance();
            }
        });

        it('should not be possible to call before init', async () => {
            const instance1 = getNewInstance();
            assert.throws(() => instance1.mongodash.getMongoClient(), /The mongodash.init\(\) has to be called first./);
        });
    });
});
