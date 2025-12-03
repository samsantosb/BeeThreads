# 🐝 bee-threads

[![npm](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)

> Worker threads with zero boilerplate. Zero dependencies.

```bash
npm install bee-threads
```

## Quick Start

```js
const { bee } = require('bee-threads');

// Any function runs in a separate thread
const hash = await bee((pwd) => 
  require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex')
)('password123');
```

---

## Basic Usage

```js
// Simple
await bee(() => 42)();

// With arguments
await bee((a, b) => a + b)(10, 20);  // → 30

// External variables (closures)
const TAX = 0.2;
await bee((price) => price * (1 + TAX))(100)({ beeClosures: { TAX } });  // → 120
```

---

## Full API

For more control, use `beeThreads`:

```js
const { beeThreads } = require('bee-threads');

await beeThreads
  .run((x) => x * 2)
  .usingParams(21)
  .execute();  // → 42
```

### `.usingParams(...args)`
Pass arguments to the function:
```js
await beeThreads.run((a, b) => a + b).usingParams(10, 20).execute();  // → 30
```

### `.setContext({ vars })`
Inject external variables (closures):
```js
const TAX = 0.2;
await beeThreads.run((p) => p * (1 + TAX)).usingParams(100).setContext({ TAX }).execute();  // → 120
```

### `.signal(AbortSignal)`
Enable cancellation:
```js
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 1000);
await beeThreads.run(() => longTask()).signal(ctrl.signal).execute();
```

### `.retry(options)`
Auto-retry on failure:
```js
await beeThreads.run(() => unstableApi()).retry({ maxAttempts: 3, baseDelay: 100 }).execute();
```

### `.priority(level)`
Queue priority (`'high'` | `'normal'` | `'low'`):
```js
await beeThreads.run(() => critical()).priority('high').execute();
```

### `.transfer([ArrayBuffer])`
Zero-copy for large binary data:
```js
const buf = new ArrayBuffer(1024);
await beeThreads.run((b) => process(b)).usingParams(buf).transfer([buf]).execute();
```

### Timeout

```js
await beeThreads
  .withTimeout(5000)((data) => process(data))
  .usingParams(data)
  .execute();
```

### Streaming (Generators)

```js
const stream = beeThreads
  .stream(function* (n) {
    for (let i = 1; i <= n; i++) yield i * i;
  })
  .usingParams(5)
  .execute();

for await (const value of stream) {
  console.log(value);  // 1, 4, 9, 16, 25
}
```

---

## Configuration

```js
beeThreads.configure({
  poolSize: 8,              // Max workers (default: CPU cores)
  minThreads: 2,            // Pre-warmed workers
  maxQueueSize: 1000,       // Max pending tasks
  workerIdleTimeout: 30000, // Cleanup idle workers (ms)
  debugMode: true,          // Show function source in errors
  logger: console,          // Custom logger (or null to disable)
  lowMemoryMode: false,     // Reduce memory (~60-80% less)
});

// Pre-warm workers
await beeThreads.warmup(4);

// Metrics
const stats = beeThreads.getPoolStats();

// Shutdown
await beeThreads.shutdown();
```

---

## Error Handling

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads');

try {
  await beeThreads.run(fn).execute();
} catch (err) {
  if (err instanceof TimeoutError) { /* timeout */ }
  if (err instanceof AbortError) { /* cancelled */ }
  if (err instanceof QueueFullError) { /* queue full */ }
  if (err instanceof WorkerError) { /* worker error */ }
}
```

---

## Parallel Execution

```js
const [a, b, c] = await Promise.all([
  bee((x) => x * 2)(21),
  bee((x) => x + 1)(41),
  bee(() => 'hello')()
]);
// [42, 42, 'hello']
```

---

## TypeScript

Full type support:

```ts
import { bee, beeThreads } from 'bee-threads';

const result = await bee((x: number) => x * 2)(21);  // number
```

---

## Use Cases

- Password hashing (PBKDF2, bcrypt)
- Image processing (sharp, jimp)
- Large JSON parsing
- Data compression
- PDF generation
- Heavy computations

---

## Why bee-threads?

- **Zero dependencies** - Lightweight and secure
- **Inline functions** - No separate worker files
- **Worker pool** - Reuses threads, no cold-start
- **Function caching** - LRU cache, VM.Script optimization
- **Worker affinity** - Same function → same worker (V8 JIT)
- **Full TypeScript** - Complete type definitions

---

MIT © [Samuel Santos](https://github.com/samsantosb)
