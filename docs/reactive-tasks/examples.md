# Examples & Use Cases

Reactive Tasks are versatile. Here are a few patterns you can implement:

## A. Webhook Delivery & Data Sync
Perfect for reliable delivery of data to external systems. If the external API is down, Mongodash will automatically retry with exponential backoff.

```typescript
await reactiveTask({
    task: 'sync-order-to-erp',
    collection: 'orders',
    filter: { status: 'paid' }, // Only sync when paid
    watchProjection: { status: 1 },  // Only check when status changes
    
    handler: async (context) => {
        const order = await context.getDocument();
        await axios.post('https://erp-system.com/api/orders', order);
    }
});
```

## B. Async Statistics Recalculation
Offload heavy calculations from the main request path. When a raw document changes, update the aggregated view in the background.

```typescript
await reactiveTask({
    task: 'recalc-product-rating',
    collection: 'reviews',
    debounce: '5s', // Re-calc at most once every 5 seconds per product
    
    handler: async (context) => {
        // We only watched 'status', so we might need the full doc? 
        // Or if we have the ID, that's enough for aggregation:
        const { docId } = context; 

        // Calculate new average
        const stats = await calculateAverageRating(docId);
        
        // Update product document
        await db.collection('products').updateOne(
            { _id: docId },
            { $set: { rating: stats.rating, reviewCount: stats.count } }
        );
    }
});
```

## C. Pub-Sub (Event Bus)
Use Reactive Tasks as a distributed Event Bus. By creating an events collection and watching only the `_id`, you effectively create a listener that triggers **only on new insertions**.

```typescript
await reactiveTask({
    task: 'send-welcome-sequence',
    collection: 'app_events',
    
    // TRICK: _id never changes. 
    // This config ensures the handler ONLY runs when a new document is inserted.
    watchProjection: { _id: 1 }, 
    filter: { type: 'user-registered' },
    
    handler: async (context) => {
        const event = await context.getDocument();
        await emailService.sendWelcome(event.payload.email);
    }
});
```
