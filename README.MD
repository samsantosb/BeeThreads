# 🐝 bee-threads

[![npm version](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dm/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![license](https://img.shields.io/npm/l/bee-threads.svg)](https://github.com/samsantosb/BeeThreads/blob/main/LICENSE)

> Run sync code in worker threads with a simple await.

```js
const { beeThreads } = require('bee-threads');

const hash = await beeThreads
  .run((pwd) => require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex'))
  .usingParams('password')
  .execute();
```

**Short syntax:**

```js
const { bee } = require('bee-threads');

const hash = await bee(
  (pwd) => require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex')
)('password');
```

## Install

```bash
npm install bee-threads
```

---

## `bee` — Short Syntax

```js
// no params (always requires empty call)
await bee(() => 42)()

// with params
await bee((a, b, c) => a + b + c)(1, 2, 3)

// supports curried callbacks!
await bee((a) => (b) => a + b)(1)(2)
// → 3

// with external variables
const TAX = 0.2;
await bee((price) => price * (1 + TAX))(100)({ beeClosures: { TAX } })
```

---

## `beeThreads` — Full API

### `.usingParams(...args)` — Pass arguments

```js
const sum = await beeThreads
  .run((a, b, c) => a + b + c)
  .usingParams(10, 20, 30)
  .execute();
// → 60
```

### `.setContext(obj)` — Inject external variables

```js
const TAX_RATE = 0.2;
const DISCOUNT = 0.1;

const finalPrice = await beeThreads
  .run((price) => price * (1 + TAX_RATE) * (1 - DISCOUNT))
  .usingParams(100)
  .setContext({ TAX_RATE, DISCOUNT })
  .execute();
// → 108
```

### `.signal(AbortSignal)` — Cancellation

```js
const controller = new AbortController();

// Cancel after 1 second
setTimeout(() => controller.abort(), 1000);

try {
  await beeThreads
    .run(() => { while(true) {} }) // infinite loop
    .signal(controller.signal)
    .execute();
} catch (err) {
  console.log(err.name); // 'AbortError'
}
```

### `.transfer([ArrayBuffer])` — Zero-copy transfer

```js
const buffer = new ArrayBuffer(1024 * 1024); // 1MB

const result = await beeThreads
  .run((buf) => {
    const view = new Uint8Array(buf);
    view.fill(42);
    return buf;
  })
  .usingParams(buffer)
  .transfer([buffer]) // zero-copy, buffer is moved not copied
  .execute();
```

### `.retry({ attempts })` — Auto-retry

```js
const result = await beeThreads
  .run(() => {
    if (Math.random() < 0.5) throw new Error('Transient failure');
    return 'success';
  })
  .retry({ 
    attempts: 3,      // max retries
    delay: 100,       // initial delay ms
    backoff: 2        // exponential backoff multiplier
  })
  .execute();
```

### `.priority('high'|'normal'|'low')` — Queue priority

```js
// Critical task - jumps to front of queue
await beeThreads
  .run(processPayment)
  .usingParams(paymentData)
  .priority('high')
  .execute();

// Background task - processed last
await beeThreads
  .run(generateReport)
  .usingParams(reportData)
  .priority('low')
  .execute();
```

---

## Variants

### `beeThreads.safeRun(fn)` — Never throws

Returns `{ status, value/error }` like `Promise.allSettled`:

```js
const result = await beeThreads
  .safeRun(() => JSON.parse('invalid json'))
  .execute();

if (result.status === 'fulfilled') {
  console.log(result.value);
} else {
  console.error(result.error); // SyntaxError
}
```

### `beeThreads.withTimeout(ms)(fn)` — Execution with timeout

```js
try {
  await beeThreads
    .withTimeout(5000)((data) => heavyComputation(data))
    .usingParams(largeDataset)
    .execute();
} catch (err) {
  console.log(err.name); // 'TimeoutError'
}
```

### `beeThreads.stream(generatorFn)` — Async iterator

```js
const stream = beeThreads
  .stream(function* (start, end) {
    for (let i = start; i <= end; i++) {
      yield i * i; // yields squares
    }
  })
  .usingParams(1, 5)
  .execute();

for await (const square of stream) {
  console.log(square);
}
// → 1, 4, 9, 16, 25
```

---

## Parallel Execution

### `beeThreads.all(tasks)` — Like Promise.all

Executes multiple tasks in parallel. Throws on first error.

```js
const [a, b, c] = await beeThreads.all([
  [(x) => x * 2, [21]],
  [(a, b) => a + b, [10, 20]],
  [() => 'hello']
]);
// a = 42, b = 30, c = 'hello'

// With shared context
const TAX = 0.2;
const [p1, p2] = await beeThreads.all([
  [(price) => price * (1 + TAX), [100]],
  [(price) => price * (1 + TAX), [200]],
], { context: { TAX } });
// p1 = 120, p2 = 240
```

### `beeThreads.allSettled(tasks)` — Like Promise.allSettled

Never throws. Returns results array with `status` and `value`/`reason`.

```js
const results = await beeThreads.allSettled([
  [() => 'success'],
  [() => { throw new Error('fail'); }],
  [() => 42]
]);
// [
//   { status: 'fulfilled', value: 'success' },
//   { status: 'rejected', reason: Error },
//   { status: 'fulfilled', value: 42 }
// ]
```

---

## Pool

```js
// Configure pool
beeThreads.configure({ 
  poolSize: 8,           // max workers
  minThreads: 2,         // always-ready workers
  maxQueueSize: 100,     // max pending tasks
  workerIdleTimeout: 60000 // cleanup idle workers after 60s
});

// Pre-warm workers (eliminates cold-start)
await beeThreads.warmup(4);

// Get metrics
const stats = beeThreads.getPoolStats();
console.log(stats.normal.busy);  // workers currently busy
console.log(stats.normal.idle);  // workers available

// Graceful shutdown
await beeThreads.shutdown();
```

---

## Errors

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads');

// TimeoutError - task exceeded timeout
// AbortError - task was cancelled via AbortSignal
// QueueFullError - queue at maxQueueSize capacity
// WorkerError - worker crashed or threw error
```

---

## Use Cases

1. **Password Hashing** — PBKDF2, bcrypt, scrypt
2. **Image Processing** — resize, compress, filters (sharp, jimp)
3. **Large JSON Parsing** — 50MB+ JSON files
4. **Data Compression** — gzip, brotli, zstd
5. **Complex Regex** — pattern matching on large text
6. **PDF Generation** — multi-page documents
7. **Batch Validation** — validate thousands of records
8. **Heavy Loops** — millions of iterations, Monte Carlo simulations

---

## Why bee-threads?

**Developer Experience:**

- **Inline functions** — no separate worker files
- **Simple syntax** — `await bee(fn)(args)` 
- **Closure support** — pass external variables with `beeClosures`
- **Full TypeScript** — complete type definitions
- **Zero config** — works out of the box

**Performance:**

- **Worker pool** — reuses threads, no cold-start
- **Load balancing** — distributes tasks across workers
- **Worker affinity** — routes same function to same worker (V8 JIT optimization)
- **Function caching** — avoids repeated calls
- **Priority queue** — critical tasks first
- **Auto-retry** — handles transient failures

**Production Ready:**

- **Non-blocking shutdown** — `worker.unref()` doesn't hold process
- **Console forwarding** — logs from workers appear in main thread
- **Graceful degradation** — queue overflow handling

## License

MIT
