# withLock

Utility function to control concurrency.

## withLock(key, callback [, options]) => Promise

```typescript
withLock(key, callback [, options]) => Promise
```

The `withLock` function ensures only one process steps into the [critical section](https://en.wikipedia.org/wiki/Critical_section) (callback).

```typescript
import { withLock } from 'mongodash';

function updateUser (userId, data) {
    return withLock(`user-update-${userId}`, async () => {
        const user = await getUserFromDatabase(userId);
        user.setData(data);
        await saveUserToDatabase(user);
        return user;
    });
}

// all calls are triggered in parallel,
// the withLock ensures they will be processed one by one
updateUser(1, { name: 'Joe' });
updateUser(1, { surname: 'Doe' });
updateUser(1, { nick: 'J' });
```

The `withLock` function uses [busy wait](https://en.wikipedia.org/wiki/Busy_waiting) with a combination of sleep if the lock is occupied. The sleep time is determined by the [exponential backoff](https://en.wikipedia.org/wiki/Exponential_backoff) strategy.

The key is always converted to a string internally, so `100` and `"100"` are considered as the same key.

The lock is acquired for an amount of time (see expireIn option). If the callback lasts too long, the lock is prolonged automatically.

## Usable even in scalable (multi-instance) applications

Usable even in scalable (multi-instance) applications thanks to lock registration in MongoDB.
Mongodash will ensure only one execution process step into the callback.

## Options

(Documentation for options was not fully retrievable. Common options likely include `expireIn`.)
