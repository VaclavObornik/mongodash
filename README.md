<br>

<img src="https://raw.githubusercontent.com/VaclavObornik/mongodash/master/logo.png" alt="Mongodash" height="150" />

A modern JavaScript & Typescript MongoDB-based utility library. Includes **Reactive Tasks**, **Cron Tasks**, **Distributed Locks**, **Transactions**, and a **[Dashboard](https://vaclavobornik.github.io/mongodash/dashboard)**.

[![Coverage Status](https://coveralls.io/repos/github/VaclavObornik/mongodash/badge.svg?branch=master)](https://coveralls.io/github/VaclavObornik/mongodash?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2FVaclavObornik%2Fmongodash%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/VaclavObornik/mongodash/master)
![Types](https://badgen.net/npm/types/tslib)


See full documentation [here](https://vaclavobornik.github.io/mongodash/getting-started)

---

<br>

Installation:
```bash
npm install mongodash
```

Initialization
```typescript
import mongodash from 'mongodash';

await mongodash.init({
    uri: 'mongodb://mongodb0.example.com:27017/myDatabase' 
});
```
See more initialization options [here](https://vaclavobornik.github.io/mongodash/initialization).

<br>

## Reactive Tasks

```typescript
import { reactiveTask } from 'mongodash';

// Trigger a task when a user is updated
await reactiveTask({
    task: 'on-user-update', 
    collection: 'users',
    handler: async (doc) => {
        console.log('User changed:', doc._id);
    }
});
```
See detailed description [here](https://vaclavobornik.github.io/mongodash/reactive-tasks).

<br>

## cronTask
```typescript
import { cronTask } from 'mongodash';

await cronTask('my-task-id', '5m 20s', async () => {
  
    console.log('Hurray the task is running!');

});
```
See detailed description and more cron tasks methods [here](https://vaclavobornik.github.io/mongodash/cron-tasks).

<br>

## withLock

```typescript
import { withLock } from 'mongodash';

await withLock('my-lock-id', async () => {
  
  // it is quaranteed this callback will never run in parallel, 
  // so all race-conditions are solved
  const data = await loadFromDatabase();
  data.counter += 1;
  await saveToDatabase(data);
  
});
```
See detailed description [here](https://vaclavobornik.github.io/mongodash/with-lock).

<br>

## withTransaction
```typescript
import { withTransaction, getCollection } from 'mongodash';

const createdDocuments = await withTransaction(async (session) => {
    
  const myDocument1 = { value: 1 };
  const myDocument2 = { value: 2 };
  
  const collection = getCollection('myCollection');
  await collection.insertOne(myDocument1, { session });
  await collection.insertOne(myDocument2, { session });
  
  return [myDocument1, myDocument2];
});
```
See detailed description [here](https://vaclavobornik.github.io/mongodash/with-transaction).

<br>

## getCollection
```typescript
import { getCollection } from 'mongodash';

const myCollection = getCollection('myCollectionName');
```
See detailed description [here](https://vaclavobornik.github.io/mongodash/getters).

<br>

## getMongoClient
```typescript
import { getMongoClient } from 'mongodash';

const mongoClient = getMongoClient();
```
See detailed description [here](https://vaclavobornik.github.io/mongodash/getters).
