# Getting Started

## 1. Initialization

Ensure `mongodash` is initialized with a global `uri` or `mongoClient`.

```typescript
import mongodash from 'mongodash';

await mongodash.init({
    uri: 'mongodb://localhost:27017/my-app'
});
```

## 2. Define a Task

Use the `reactiveTask` function to register a task. You define *what* to watch and *how* to process it.

```typescript
import { reactiveTask } from 'mongodash';

// Define a task that sends an email when a User is created or updated
// multiple tasks can listen to the same collection!
await reactiveTask({
    task: 'send-welcome-email', // Unique Job ID
    collection: 'users',        // Collection to watch
    
    // Optional: Only trigger if specific fields change
    watchProjection: { status: 1, email: 1 },
    
    // Optional: Filter documents (Standard Query or Aggregation Expression)
    filter: { status: 'active' },

    // The logic to execute
    handler: async (context) => {
        // Fetch the document (verifies filter & optimistic locking)
        const userDoc = await context.getDocument();
        
        console.log(`Processing user: ${userDoc._id}`);
        await sendEmail(userDoc.email, 'Welcome!');
    }
});
```
For a full list of options, see [Configuration](./configuration.md).

## 3. Start the System

After registering all tasks, start the scheduler. This will assume leadership (if possible) and start processing.

```typescript
import { startReactiveTasks } from 'mongodash';

await startReactiveTasks();
```
