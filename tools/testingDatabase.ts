const mongodb = require('mongodb');
const _debug = require('debug')('mongodash:testingDatabase');

const baseDatabaseName = 'mongodashTesting';

function getConnectionString () {
  const withPostfix = !process.env.KEEP_SINGLE_DATABASE;
  const postfix = `__${process.pid}`;
  return `mongodb://127.0.0.1:27017/${baseDatabaseName}${withPostfix ? postfix : ''}`;
}

module.exports = {

  getConnectionString,

  cleanTestingDatabases: async function (all = false) {
    const client = new mongodb.MongoClient(getConnectionString(), {
      useUnifiedTopology: true
    });
    await client.connect();
    const db = client.db();

    const postfixMatcher = /__([0-9]+)/;

    const matcher = new RegExp(`^${baseDatabaseName}(${postfixMatcher.source})?$`);
    const adminDb = db.admin();
    const {databases} = await adminDb.listDatabases({nameOnly: true});

    await Promise.all(databases.map(async ({name}: { name: string }) => {
      const shouldDelete = !all ? name === db.databaseName : name.match(matcher);
      if (shouldDelete) {
        _debug(`DROPPING TESTING database ${name}`);
        await client.db(name).dropDatabase();
      }
    }));

    await client.close();
  }

}
