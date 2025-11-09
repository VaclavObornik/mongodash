'use strict';
import { MongoClient, MongoClientOptions } from 'mongodb';

let mongoClientInstance: MongoClient;

export function getMongoClient(): MongoClient {
    if (!mongoClientInstance) {
        throw Error('The mongodash.init() has to be called first.');
    }
    return mongoClientInstance;
}

type ReadyClientOptions = { mongoClient: MongoClient };
type UriOptions = { uri: string; clientOptions?: MongoClientOptions };
export type InitOptions = ReadyClientOptions | UriOptions;

export async function init(options: InitOptions): Promise<void> {
    if ('mongoClient' in options) {
        if ('clientOptions' in options) {
            throw new Error('It is not possible use clientOptions with ready mongoClient instance.');
        }
        if ('uri' in options) {
            throw new Error('It is not possible use uri with ready mongoClient instance.');
        }
        mongoClientInstance = options.mongoClient;
    } else if ('uri' in options) {
        mongoClientInstance = new MongoClient(options.uri, options.clientOptions);
        await mongoClientInstance.connect();
    } else {
        throw new Error('The `mongoClient` or the connection `uri` parameter has to be specified.');
    }
}
