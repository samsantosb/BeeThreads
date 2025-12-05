# 🐝 bee-threads

[![npm](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dw/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/bee-threads)

<div align="center">

### ⚡ THE BEST THREADS DX IN NODE.JS ⚡

**Parallel programming made simple. Zero boilerplate. Zero dependencies.**

</div>

---

## Parallel Programming with bee-threads

```js
const { bee } = require('bee-threads');

// Run any function in a separate thread
const result = await bee((x) => x * 2)(21);  // 42

// CPU-intensive? No problem.
const hash = await bee((pwd) => 
  require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex')
)('password123');

// Parallel execution
const [a, b, c] = await Promise.all([
  bee((x) => x * 2)(21),
  bee((x) => x + 1)(41),
  bee(() => 'hello')()
]);
```

That's it. **One line = one thread.**

---

## Native worker_threads vs bee-threads

<table>
<tr>
<th>❌ Native worker_threads</th>
<th>✅ bee-threads</th>
</tr>
<tr>
<td>

```js
// worker.js (separate file!)
const { parentPort } = require('worker_threads');
parentPort.on('message', (x) => {
  parentPort.postMessage(x * 2);
});

// main.js
const { Worker } = require('worker_threads');
const worker = new Worker('./worker.js');

worker.postMessage(21);

worker.on('message', (result) => {
  console.log(result); // 42
});

worker.on('error', (err) => {
  console.error('Worker error:', err);
});

worker.on('exit', (code) => {
  if (code !== 0) {
    console.error(`Worker stopped: ${code}`);
  }
});

// No pooling, no reuse, no caching...
// 50+ lines of boilerplate
```

</td>
<td>

```js
const { bee } = require('bee-threads');

const result = await bee((x) => x * 2)(21);
// 42

// ✅ Worker pool (auto-managed)
// ✅ Function caching (300-500x faster)
// ✅ Worker affinity (V8 JIT benefits)
// ✅ Error handling (try/catch works)
// ✅ TypeScript support
// ✅ Zero dependencies
```

</td>
</tr>
</table>

```bash
npm install bee-threads
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
await bee((price) => price * (1 + TAX))(100, { beeClosures: { TAX } });  // → 120
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

> **Note:** Context values must be serializable (no functions or Symbols).

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

> **Note:** When using `.retry()` with `.withTimeout()`, the timeout applies **per attempt**, not total.

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
  if (err instanceof WorkerError) { 
    // Custom error properties are preserved
    console.log(err.code);       // e.g., 'ERR_CUSTOM'
    console.log(err.statusCode); // e.g., 500
  }
}
```

---

## TypeScript

Full type support:

```ts
import { bee, beeThreads } from 'bee-threads';

const result = await bee((x: number) => x * 2)(21);  // number
```

---

## Limitations

- **No `this` binding** - Use arrow functions or pass context via `.setContext()`
- **No closures** - External variables must be passed via `beeClosures` or `.setContext()`
- **Serializable only** - Arguments and return values must be serializable (no functions, Symbols, or circular refs with classes)

### Worker Environment

Some global APIs are **not available** inside worker functions:

| API | Status |
|-----|--------|
| `require()` | ✅ Works |
| `Buffer` | ✅ Works |
| `URL`, `URLSearchParams` | ✅ Works |
| `TextEncoder/Decoder` | ✅ Works |
| `crypto` | ✅ Works |
| `Intl` | ✅ Works |
| `AbortController` | ❌ Use signal externally |
| `structuredClone` | ❌ Not available |
| `performance.now()` | ❌ Use `Date.now()` |

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
- **Function caching** - LRU cache, 300-500x faster repeated calls
- **Worker affinity** - Same function → same worker (V8 JIT optimization)
- **Full TypeScript** - Complete type definitions

---

MIT © [Samuel Santos](https://github.com/samsantosb)
