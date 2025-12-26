# withTransaction

The more perfect variant of the native driver's `withTransaction` function.

## withTransaction(callback) => Promise

```typescript
withTransaction(callback) => Promise
```

```typescript
import { withTransaction, getCollection } from 'mongodash';
import { ClientSession } from 'mongodb';

const createdDocuments = await withTransaction(async (session: ClientSession) => {
    const collection = getCollection('myCollection');
    const myDocument1 = { value: 1 };
    const myDocument2 = { value: 2 };
    
    await collection.insertOne(myDocument1, { session });
    await collection.insertOne(myDocument2, { session });
    
    return [myDocument1, myDocument2];
});
```

## Benefits over the native driver's function

Benefits over the native driver's [withTransaction](https://mongodb.github.io/node-mongodb-native/4.0/classes/clientsession.html#withtransaction) function:

- automatically starts a new `clientSession`
- automatically ends the `clientSession` (even on failure)
- propagates the value returned from the callback

It does all the necessary code described in the [official docs](https://docs.mongodb.com/realm/mongodb/transactions/) automatically.

## Post Commit Hooks

You can register hooks that will be executed **only after the transaction successfully commits**.

### registerPostCommitHook(session, callback) => void

```typescript
registerPostCommitHook(session: ClientSession, callback: () => void | Promise<void>) => void
```

This is extremely useful for side effects that should happen effectively "outside" the transaction but only if the transaction succeeds, such as:
- Sending emails
- invalidating caches
- Triggering webhooks

```typescript
import { withTransaction, registerPostCommitHook } from 'mongodash';

await withTransaction(async (session) => {
    // 1. Modify DB inside transaction
    await db.collection('orders').insertOne({ status: 'created' }, { session });
    
    // 2. Register side-effect
    registerPostCommitHook(session, async () => {
        // This runs ONLY if transaction commits successfully
        await emailService.sendOrderConfirmation();
    });
});
```
