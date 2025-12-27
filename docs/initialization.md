# Initialization

## Installation

```bash
npm install mongodash
```

## mongodash.init(options) => Promise

Initializes the `mongodash` library. This method must be called before using any other features.

```typescript
import mongodash from 'mongodash';

// Initialize with connection string
await mongodash.init({
    uri: 'mongodb://localhost:27017/my-app',
    // ...other options
});

// OR initialize with existing MongoClient
await mongodash.init({
    mongoClient: myExistingClient,
    // ...other options
});
```

### Options Reference

#### Connection Options

| Option | Type | Description |
| :--- | :--- | :--- |
| `uri` | `string` | **Required** (if `mongoClient` is not provided). The MongoDB connection string. `mongodash` will connect automatically. |
| `mongoClient` | `MongoClient` | **Required** (if `uri` is not provided). An existing, connected `MongoClient` instance. |
| `clientOptions` | `MongoClientOptions` | Optional. Used only when `uri` is provided. Options passed to the MongoDB driver. |

#### General Options

| Option | Type | Description |
| :--- | :--- | :--- |
| `globalsCollection` | `string` \| `Collection` | Name of the collection used for distributed locking and coordination. Mongodash uses a fixed set of documents identified by unique derived `_id`s, so it has a minimal storage footprint and doesn't pollute the collection. Default: `_mongodash_globals`. |
| `onError` | `(err: Error) => void` | Global error handler. Default: `console.error`. |
| `onInfo` | `(info: Info) => void` | Global info/debug handler. Default: `console.info`.  |

#### Cron Tasks Options

See [Cron Tasks](./cron-tasks.md#initialization-options-optional) for feature-specific options (e.g. `runCronTasks`, `cronExpressionParserOptions`, etc).

#### Reactive Tasks Options

See [Reactive Tasks](./reactive-tasks/configuration.md#advanced-initialization) for feature-specific options (e.g. `concurrency`, `monitoring`, etc).

#### Testing Options

| Option | Type | Description |
| :--- | :--- | :--- |
| `collectionFactory` | `Function` | **Internal**. Used for injecting mock collections during testing. |
