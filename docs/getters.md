# Collection and Client getters

Utility functions for global access to Collections and MongoClient.

## getCollection(name [, options]) => Collection

```typescript
getCollection(name [, options]) => Collection
```

Get a new instance of a [collection](https://mongodb.github.io/node-mongodb-native/4.0/classes/collection.html). Uses default database determined from the connection string. See [official driver documentation](http://mongodb.github.io/node-mongodb-native/3.6/api/Db.html#collection) for valid options.

```typescript
import { getCollection } from 'mongodash'; 
const myCollection = getCollection('myCollectionName');
```

The method just shortens `getMongoClient().db().collection('myCollectionName')`.

## getMongoClient() => MongoClient

```typescript
getMongoClient() => MongoClient
```

Returns the global instance of MongoClient. See [official driver documentation](https://mongodb.github.io/node-mongodb-native/4.0/classes/mongoclient.html) for documentation of MongoClient.

```typescript
import { getMongoClient } from 'mongodash'; 
const mongoClient = getMongoClient();
```
