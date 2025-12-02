# 🐝 bee-threads

> Handle threading as promises.

Run CPU-intensive JavaScript in worker threads without blocking the main thread.

```js
const { beeThreads } = require('bee-threads');

// Runs in a separate thread, doesn't block!
const result = await beeThreads
  .run((data) => {
    // Heavy computation here
    return processData(data);
  })
  .usingParams(largeDataset)
  .execute();
```

## Install

```bash
npm install bee-threads
```

## Usage

### Basic

```js
const result = await beeThreads
  .run((a, b) => a + b)
  .usingParams(1, 2)
  .execute();
// → 3
```

### External Variables (Closures)

Functions can't capture closures. Use `.setContext()`:

```js
const TAX_RATE = 0.2;

const result = await beeThreads
  .run((price) => price * (1 + TAX_RATE))
  .usingParams(100)
  .setContext({ TAX_RATE })
  .execute();
// → 120
```

### Safe Mode

Never throws - returns result object:

```js
const result = await beeThreads
  .safeRun(() => JSON.parse('invalid'))
  .usingParams()
  .execute();

if (result.status === 'rejected') {
  console.error(result.error);
}
```

### Timeout

```js
await beeThreads
  .withTimeout(5000)(heavyTask)
  .usingParams(data)
  .execute();
```

### Cancellation

```js
const controller = new AbortController();

const task = beeThreads
  .run(heavyTask)
  .usingParams()
  .signal(controller.signal)
  .execute();

// Cancel anytime
controller.abort();
```

### Streaming (Generators)

```js
const stream = beeThreads
  .stream(function* (n) {
    for (let i = 0; i < n; i++) {
      yield i * i;
    }
  })
  .usingParams(5)
  .execute();

for await (const value of stream) {
  console.log(value); // 0, 1, 4, 9, 16
}
```

### Retry

```js
await beeThreads
  .run(unreliableTask)
  .usingParams()
  .retry({ maxAttempts: 3, baseDelay: 100 })
  .execute();
```

### Curried Functions

Automatically handled:

```js
const result = await beeThreads
  .run((a) => (b) => (c) => a + b + c)
  .usingParams(1, 2, 3)
  .execute();
// → 6
```

## API

| Method | Description |
|--------|-------------|
| `run(fn)` | Execute function in worker |
| `safeRun(fn)` | Like run, never throws |
| `withTimeout(ms)(fn)` | With time limit |
| `stream(genFn)` | Stream generator values |

| Executor Method | Description |
|-----------------|-------------|
| `.usingParams(...args)` | Set function arguments |
| `.setContext(obj)` | Inject closure variables |
| `.signal(signal)` | Cancellation support |
| `.transfer(list)` | Zero-copy ArrayBuffers |
| `.retry(opts)` | Auto-retry with backoff |
| `.execute()` | Run the function |

| Config | Description |
|--------|-------------|
| `configure(opts)` | Set pool options |
| `getPoolStats()` | Get metrics |
| `shutdown()` | Terminate workers |

## Error Types

```js
const { AbortError, TimeoutError, QueueFullError, WorkerError } = require('bee-threads');
```

## Why bee-threads?


 Inline functions ✅ 
 Closure injection ✅ 
 Fluent API ✅  
 Generators ✅  
 AbortSignal ✅ 
 Auto-retry ✅  
 Curried functions ✅

## License

MIT
