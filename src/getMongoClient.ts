'use strict';
import { MongoClient, MongoClientOptions } from 'mongodb';

let mongoClientInstance: MongoClient;
/**
 * Whether {@link init} created {@link mongoClientInstance} itself (uri mode). A
 * client handed in by the caller is theirs to close; one we created must be
 * closed before we replace it, otherwise a retried init() abandons it with its
 * connection pool and topology monitor still running.
 */
let clientIsSelfCreated = false;

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
    // init() is retryable, and a previous attempt may have connected before a
    // later step failed. Release the client we created then, so we never leak it.
    if (mongoClientInstance && clientIsSelfCreated) {
        const previous = mongoClientInstance;
        clientIsSelfCreated = false;
        await previous.close().catch(() => undefined);
    }

    if ('mongoClient' in options) {
        if ('clientOptions' in options) {
            throw new Error('It is not possible use clientOptions with ready mongoClient instance.');
        }
        if ('uri' in options) {
            throw new Error('It is not possible use uri with ready mongoClient instance.');
        }
        mongoClientInstance = options.mongoClient;
    } else if ('uri' in options) {
        const client = new MongoClient(options.uri, options.clientOptions);
        try {
            await client.connect();
        } catch (err) {
            // init() is retryable (e.g. the app started before MongoDB was
            // reachable). Close the half-open client so a retry does not leave
            // its topology monitoring running, and leave the module-level
            // instance unset so getMongoClient() keeps reporting "not inited".
            await client.close().catch(() => undefined);
            throw err;
        }
        mongoClientInstance = client;
        clientIsSelfCreated = true;
    } else {
        throw new Error('The `mongoClient` or the connection `uri` parameter has to be specified.');
    }
}
