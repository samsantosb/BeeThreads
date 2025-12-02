# 🐝 bee-threads

[![npm version](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dm/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![license](https://img.shields.io/npm/l/bee-threads.svg)](https://github.com/samsantosb/BeeThreads/blob/main/LICENSE)

> **Handle threading as promises.**

Run CPU-intensive JavaScript in worker threads without blocking the main thread. Simple, fluent API.

```js
const { beeThreads } = require('bee-threads');

const result = await beeThreads
  .run((data) => {
    // Runs in a separate thread!
    return heavyComputation(data);
  })
  .usingParams(largeDataset)
  .execute();
```

## Install

```bash
npm install bee-threads
```

## Features

✅ **Inline functions** - No separate worker files needed  
✅ **Closure injection** - Use external variables with `.setContext()`  
✅ **Fluent API** - Chain methods naturally  
✅ **Generators** - Stream values with `beeThreads.stream()`  
✅ **Cancellation** - AbortController support  
✅ **Retry** - Automatic retry with exponential backoff  
✅ **TypeScript** - Full type definitions included  
✅ **Console logs** - `console.log` in workers prints to main thread  

## Quick Start

### Basic Usage

```js
const result = await beeThreads
  .run((a, b) => a + b)
  .usingParams(1, 2)
  .execute();
// → 3
```

### No Parameters? No Problem

```js
// usingParams() is optional when function has no arguments
const result = await beeThreads
  .run(() => heavyComputation())
  .execute();
```

### With External Variables

Functions can't capture closures. Use `.setContext()` to inject them:

```js
const TAX_RATE = 0.2;

const result = await beeThreads
  .run((price) => price * (1 + TAX_RATE))
  .usingParams(100)
  .setContext({ TAX_RATE })
  .execute();
// → 120
```

### Console Logs from Workers

```js
await beeThreads
  .run(() => {
    console.log('This prints on main thread!');
    return 42;
  })
  .execute();
// Output: [worker] This prints on main thread!
```

### Safe Mode (Never Throws)

```js
const result = await beeThreads
  .safeRun(() => JSON.parse('invalid'))
  .execute();

if (result.status === 'rejected') {
  console.error(result.error);
} else {
  console.log(result.value);
}
```

### With Timeout

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

## API Reference

### Execution Methods

| Method | Description |
|--------|-------------|
| `run(fn)` | Execute function in worker |
| `safeRun(fn)` | Like run, never throws |
| `withTimeout(ms)(fn)` | With time limit |
| `stream(genFn)` | Stream generator values |

### Executor Methods

| Method | Description |
|--------|-------------|
| `.usingParams(...args)` | Set function arguments |
| `.setContext(obj)` | Inject closure variables |
| `.signal(signal)` | Cancellation support |
| `.transfer(list)` | Zero-copy ArrayBuffers |
| `.retry(opts)` | Auto-retry with backoff |
| `.execute()` | Run the function |

### Configuration

| Method | Description |
|--------|-------------|
| `configure(opts)` | Set pool options |
| `getPoolStats()` | Get metrics |
| `shutdown()` | Terminate all workers |

## Error Handling

```js
const { AbortError, TimeoutError, QueueFullError, WorkerError } = require('bee-threads');

try {
  await beeThreads.run(task).usingParams().execute();
} catch (err) {
  if (err instanceof TimeoutError) {
    console.log(`Timed out after ${err.timeout}ms`);
  }
}
```

## Configuration

```js
beeThreads.configure({
  poolSize: 8,              // Max workers
  maxQueueSize: 500,        // Max pending tasks
  workerIdleTimeout: 60000, // Cleanup idle workers (ms)
  retry: { maxAttempts: 5 } // Default retry config
});
```

## Why bee-threads?

| Feature | bee-threads | Piscina | workerpool |
|---------|:-----------:|:-------:|:----------:|
| Inline functions | ✅ | ❌ | ❌ |
| Closure injection | ✅ | ❌ | ❌ |
| Fluent API | ✅ | ❌ | ❌ |
| Generators | ✅ | ❌ | ❌ |
| AbortSignal | ✅ | ❌ | ❌ |
| Auto-retry | ✅ | ❌ | ❌ |
| Curried functions | ✅ | ❌ | ❌ |

## License

MIT © [samsantosb](https://github.com/samsantosb)
