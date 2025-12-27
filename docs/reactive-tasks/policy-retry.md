# Retry Policy

You can configure the retry behavior using the `retryPolicy` option.

## General Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `type` | `string` | **Required** | `'fixed'`, `'linear'`, `'exponential'`, `'series'`, or `'cron'` |
| `maxAttempts` | `number` | `5`* | Maximum total attempts (use `-1` for unlimited). |
| `maxDuration` | `string \| number` | `undefined` | Stop retrying if elapsed time since the **first failure** in the current sequence exceeds this value. |
| `resetRetriesOnDataChange` | `boolean` | `true` | Reset attempt count if the source document changes. |

*\* If `maxDuration` is specified, `maxAttempts` defaults to unlimited.*

### Policy Specific Settings

| Policy | Property | Default | Description |
| :--- | :--- | :--- | :--- |
| **`fixed`** | `interval` | - | Delay between retries (e.g., `'10s'`). |
| **`linear`** | `interval` | - | Base delay multiplied by `attempt` number. |
| **`exponential`** | `min` | `'10s'` | Initial delay for the first retry. |
| **`exponential`** | `max` | `'1d'` | Maximum delay cap for backoff. |
| **`exponential`** | `factor` | `2` | Multiplication factor per attempt. |
| **`series`** | `intervals` | - | Array of fixed delays (e.g., `['1m', '5m', '15m']`). |
| **`cron`** | `expression` | - | Standard cron string for scheduling retries. |

### Examples

```typescript
// 1. Give up after 24 hours (infinite attempts within that window)
retryPolicy: {
    maxDuration: '24h',
    type: 'exponential',
    min: '10s',
    max: '1h'
}

// 2. Exact retry ladder (try after 1m, then 5m, then 15m, then fail)
retryPolicy: {
    maxAttempts: 4, // 1st run + 3 retries
    type: 'series',
    intervals: ['1m', '5m', '15m']
}

// 3. Series with last interval reuse
// Sequence: 1m, 5m, 5m, 5m ... (last one repeats)
retryPolicy: {
    maxAttempts: 10,
    type: 'series',
    intervals: ['1m', '5m']
}

// 4. Permanent retries every hour
retryPolicy: {
    maxAttempts: -1,
    type: 'fixed',
    interval: '1h'
}
```
