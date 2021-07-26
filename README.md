<br>

<img src="https://raw.githubusercontent.com/VaclavObornik/mongodash/master/logo.png" alt="Mongodash" height="150" />

A modern JavaScript & Typescript MongoDB-based utility library allowing to develop common app requirements incredible simple.

![Release](https://github.com/VaclavObornik/mongodash/workflows/Release/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/VaclavObornik/mongodash/badge.svg?branch=master)](https://coveralls.io/github/VaclavObornik/mongodash?branch=master)
[![Mutation testing badge](https://img.shields.io/endpoint?style=flat&url=https%3A%2F%2Fbadge-api.stryker-mutator.io%2Fgithub.com%2FVaclavObornik%2Fmongodash%2Fmaster)](https://dashboard.stryker-mutator.io/reports/github.com/VaclavObornik/mongodash/master)


See full documentation on [http://mongodash.com](http://mongodash.com)

---

<br>

Installation:
```bash
npm install mongodash
```

Initialization
```javascript
const mongodash = require('mongodash');

await mongodash.init({
    uri: 'mongodb://mongodb0.example.com:27017/myDatabase' 
});
```
See more initialization options [here](https://mongodash.readme.io/docs/initialization).

<br>

## cronTask
```javascript
const { cronTask } = require('mongodash');

await cronTask('my-task-id', '5m 20s', async () => {
  
    console.log('Hurray the task is running!');

});
```
See detailed description and more cron tasks methods [here](https://mongodash.readme.io/docs/cron-tasks).

<br>

## withLock

```javascript
const { withLock } from 'mongodash';

await withLock('my-lock-id', async () => {
  
  // it is quaranteed this callback will never run in parallel, 
  // so all race-conditions are solved
  const data = await loadFromDatabase();
  data.counter += 1;
  await saveToDatabase(data);
  
});
```
See detailed description [here](https://mongodash.readme.io/docs/withlock).

<br>

## withTransaction
```javascript
const { withTransaction, getCollection } = require('mongodash');

const createdDocuments = await withTransaction(async (session) => {
    
  const myDocument1 = { value: 1 };
  const myDocument2 = { value: 2 };
  
  const collection = getCollection('myCollection');
  await testCollection.insertOne(myDocument1, { session });
  await testCollection.insertOne(myDocument2, { session });
  
  return [myDocument1, myDocument2];
});
```
See detailed description [here](https://mongodash.readme.io/docs/withtransaction).

<br>

### getCollection
```javascript
const { getCollection } = require('mongodash');

const myCollection = getCollection('myCollectionName');
```
See detailed description [here](https://mongodash.readme.io/docs/getters).

<br>

### getMongoClient
```javascript
const { getMongoClient } = require('mongodash');

const mongoClient = getMongoClient();
```
See detailed description [here](https://mongodash.readme.io/docs/getters).
