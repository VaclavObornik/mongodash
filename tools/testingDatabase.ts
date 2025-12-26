import { MongoClient } from 'mongodb';
import _debug from 'debug';

const debug = _debug('mongodash:testingDatabase');

const baseDatabaseName = 'mongodashTesting';

export function getConnectionString() {
    if (process.env.MONGODB_URI) {
        return process.env.MONGODB_URI;
    }
    const withPostfix = !process.env.KEEP_SINGLE_DATABASE;
    const postfix = `__${process.pid}`;
    return `mongodb://127.0.0.1:27017/${baseDatabaseName}${withPostfix ? postfix : ''}`;
}

export async function cleanTestingDatabases(all = false) {
    let client: MongoClient;
    try {
        client = new MongoClient(getConnectionString(), {
            // @ts-expect-error useUnifiedTopology is legacy but might be needed for older drivers or specific testing setups
            useUnifiedTopology: true,
        });
    } catch (err) {
        if (/MongoParseError: option useunifiedtopology is not supported/i.test((err as Error).toString())) {
            client = new MongoClient(getConnectionString());
        } else {
            throw err;
        }
    }

    await client.connect();
    const db = client.db();

    const postfixMatcher = /__([0-9]+)/;

    const matcher = new RegExp(`^${baseDatabaseName}(${postfixMatcher.source})?$`);
    const adminDb = db.admin();
    const { databases } = await adminDb.listDatabases({ nameOnly: true });

    await Promise.all(
        databases.map(async ({ name }: { name: string }) => {
            const shouldDelete = !all ? name === db.databaseName : name.match(matcher);
            if (shouldDelete) {
                debug(`DROPPING TESTING database ${name}`);
                await client.db(name).dropDatabase();
            }
        }),
    );

    await client.close();
}
