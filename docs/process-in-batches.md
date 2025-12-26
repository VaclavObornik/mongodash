# Process In Batches

Efficiently process large datasets by iterating through a collection in batches.

This utility handles cursor management, batch accumulation, and memory efficiency for you.

## processInBatches

```typescript
import { processInBatches } from 'mongodash';

// 1. Fetch users
// 2. Transform them (e.g. enrich data)
// 3. Save them (e.g. bulk write)
await processInBatches(
    // 1. Collection
    db.collection('users'), 
    
    // 2. Filter or Pipeline
    { status: 'active' }, 
    // OR: [{ $match: { status: 'active' } }]
    
    // 3. Transform: Return an operation, or null to skip
    async (user) => {
        const enrichment = await fetchEnrichment(user._id);
        return {
            updateOne: {
                filter: { _id: user._id },
                update: { $set: { enrichment } }
            }
        };
    },
    
    // 4. Execute Batch: Receives array of operations
    async (batchOps) => {
        if (batchOps.length > 0) {
            await db.collection('users').bulkWrite(batchOps);
        }
    },
    
    // 5. Options
    { batchSize: 500 }
);
```

### Signature

```typescript
function processInBatches<TDoc, TOp>(
    collection: Collection<TDoc>, 
    queryOrPipeline: Filter<TDoc> | Document[], 
    transform: (doc: TDoc) => TOp | TOp[] | null | undefined | Promise<...>, 
    executeBatch: (ops: TOp[]) => Promise<void>, 
    options?: { batchSize?: number; shouldStop?: () => boolean }
): Promise<{ processedDocuments: number, operationsPerformed: number }>
```

### Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `collection` | `Collection` | The source MongoDB collection. |
| `queryOrPipeline` | `Filter` \| `Document[]` | Standard query object OR Aggregation Pipeline. |
| `transform` | `Function` | Function called for **each document**. Returns an operation (to be batched), an array of operations, or `null`/`undefined` to skip. |
| `executeBatch` | `Function` | Function called when `batchSize` is reached. Receives the array of accumulated operations. |
| `options` | `Object` | Optional configuration. |

### Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `batchSize` | `number` | `1000` | Size of the batch passed to `executeBatch`. |
| `shouldStop` | `() => boolean` | `undefined` | Callback checked before processing each document. If returns `true`, processing stops gracefully. |
