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

## Install

```bash
npm install bee-threads
```

```ts
import { bee, beeThreads } from 'bee-threads'

// Anything inside bee() runs on a separate thread
const result = await bee((x: number) => x * 2)(21) // 42
```

---

## `bee()` - Simple Curried API

```ts
// No arguments
await bee(() => 42)()

// With arguments
await bee((a: number, b: number) => a + b)(10, 20) // 30

// With closures
const TAX = 0.2
await bee((price: number) => price * (1 + TAX))(100, { beeClosures: { TAX } }) // 120
```

---

## Fluent API Methods

### `beeThreads.run()` - Full Control

```ts
await beeThreads
	.run((a: number, b: number) => a + b)
	.usingParams(10, 20)
	.execute() // 30
```

### `.setContext()` - Inject Variables

```ts
const TAX = 0.2
await beeThreads
	.run((price: number) => price * (1 + TAX))
	.usingParams(100)
	.setContext({ TAX })
	.execute() // 120
```

### `.signal()` - Cancellation

```ts
const controller = new AbortController()

const promise = beeThreads
	.run(() => heavyComputation())
	.signal(controller.signal)
	.execute()

controller.abort() // Cancel anytime
```

### `.retry()` - Auto-retry

```ts
await beeThreads
	.run(() => fetchFromFlakyAPI())
	.retry({ maxAttempts: 5, baseDelay: 100, backoffFactor: 2 })
	.execute()
```

### `.priority()` - Queue Priority

```ts
await beeThreads.run(() => processPayment()).priority('high').execute()
await beeThreads.run(() => generateReport()).priority('low').execute()
```

### `.transfer()` - Zero-copy ArrayBuffer

```ts
const buffer = new Uint8Array(10_000_000)
await beeThreads
	.run((buf: Uint8Array) => processImage(buf))
	.usingParams(buffer)
	.transfer([buffer.buffer])
	.execute()
```

### `.reconstructBuffers()` - Buffer Reconstruction

```ts
const buffer = await beeThreads
	.run((img: Buffer) => require('sharp')(img).resize(100).toBuffer())
	.usingParams(imageBuffer)
	.reconstructBuffers()
	.execute()

Buffer.isBuffer(buffer) // true
```

---

## `beeThreads.turbo()` - Parallel Arrays

Process arrays across **ALL CPU cores**. Non-blocking (main thread stays free).

```ts
const numbers = [1, 2, 3, 4, 5, 6, 7, 8]

const squares = await beeThreads.turbo(numbers).map((x: number) => x * x)
const evens = await beeThreads.turbo(numbers).filter((x: number) => x % 2 === 0)
const sum = await beeThreads.turbo(numbers).reduce((a: number, b: number) => a + b, 0)

// Custom worker count
await beeThreads.turbo(numbers).setWorkers(8).map((x: number) => x * x)

// With context
const factor = 2.5
await beeThreads.turbo(data, { context: { factor } }).map((x: number) => x * factor)
```

> **Default workers:** `os.cpus().length - 1` (leaves one core for main thread)

---

## `beeThreads.worker()` - File Workers

When you need **`require()`**, **database connections**, or **external modules**.

```ts
// workers/hash-password.js
const bcrypt = require('bcrypt')
module.exports = async function (password) {
	return bcrypt.hash(password, 12)
}

// main.ts - Just use relative path, it works! ✨
const hash = await beeThreads.worker('./workers/hash-password.js')('secret123')
```

### ✅ Smart Path Resolution

Relative paths (`./` or `../`) are **automatically resolved from your file's location**, not from `process.cwd()`. No more `__dirname` boilerplate!

```ts
// ✅ Just works - resolved from YOUR file's directory
beeThreads.worker('./workers/task.js')
beeThreads.worker('../shared/worker.js')

// ✅ Absolute paths also work
beeThreads.worker('/app/workers/task.js')
```

### TypeScript Workers

For TypeScript, point to the **compiled `.js` file**:

```ts
// src/workers/process.ts → compiled to dist/workers/process.js

// ✅ Point to compiled JS
beeThreads.worker('./workers/process.js')  // if running from dist/

// ✅ Or use explicit path to dist
import { join } from 'path'
beeThreads.worker(join(__dirname, '../dist/workers/process.js'))
```

### Worker File Format

```js
// workers/my-worker.js
const db = require('./database')

// Option 1: Direct export (recommended)
module.exports = async function (data) {
	return db.process(data)
}

// Option 2: Default export
module.exports.default = async function (data) {
	return db.process(data)
}
```

---

## `worker().turbo()` - File Workers + Parallel Arrays

Process large arrays with **database access** across multiple workers.

```ts
// workers/process-users.js
const db = require('../database')

module.exports = async function (users) {
	return Promise.all(
		users.map(async user => ({
			...user,
			score: user.value * 10,
			data: await db.fetch(user.id),
		}))
	)
}

// main.ts - 10,000 users across 8 workers
const results = await beeThreads.worker('./workers/process-users.js').turbo(users, { workers: 8 })
```

> **Default workers:** `os.cpus().length - 1`

### When to Use

| Need                            | Use                |
| ------------------------------- | ------------------ |
| Pure computation (no I/O)       | `turbo()`          |
| Single DB call                  | `worker()`         |
| **Batch processing + DB/API**   | `worker().turbo()` |
| **ETL pipelines**               | `worker().turbo()` |
| **Data enrichment at scale**    | `worker().turbo()` |

---

## Configuration

```ts
beeThreads.configure({
	poolSize: 8,
	minThreads: 2,
	maxQueueSize: 1000,
	workerIdleTimeout: 30000,
	debugMode: true,
	logger: console,
})

await beeThreads.warmup(4)
await beeThreads.shutdown()
```

---

## Error Handling

```ts
import { TimeoutError, AbortError, QueueFullError, WorkerError } from 'bee-threads'

try {
	await beeThreads.run(fn).execute()
} catch (err) {
	if (err instanceof TimeoutError) { /* timeout */ }
	if (err instanceof AbortError) { /* cancelled */ }
	if (err instanceof WorkerError) { /* worker error */ }
}

// Safe mode - never throws
const result = await beeThreads.run(fn).safe().execute()
if (result.status === 'fulfilled') console.log(result.value)
```

---

## When to Use

| Your Scenario | Best Choice | Why |
|---------------|-------------|-----|
| **Arrays** | `turbo()` | SharedArrayBuffer = zero-copy |
| **Single heavy function** | `bee()` | Keeps main thread free |
| **Light function** (`x * 2`) | Main thread | Overhead > benefit |
| **Need `require()`/DB** | `worker()` | Full Node.js access |
| **Batch processing with full import features** | `worker().turbo()` | Parallel + DB access |
| **HTTP server** | `turbo()` | Non-blocking for requests |

---

## Limitations (Inline Functions)

When using `bee()`, `beeThreads.run()`, or `turbo()` (without `worker()`), data is transferred via [Structured Clone Algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm).

### ✅ What CAN be passed as parameters

| Type | Works |
|------|-------|
| Primitives (`string`, `number`, `boolean`, `null`, `undefined`, `BigInt`) | ✅ |
| Arrays, Objects (POJOs) | ✅ |
| `Date`, `RegExp`, `Map`, `Set` | ✅ |
| `ArrayBuffer`, TypedArrays (`Uint8Array`, `Float64Array`, etc.) | ✅ |
| `Error` (with custom properties) | ✅ |
| Nested objects | ✅ |

### ❌ What CANNOT be passed as parameters

| Type | Why |
|------|-----|
| **Functions** | Not cloneable (use `setContext` instead) |
| **Symbols** | Not cloneable |
| **Class instances** | Lose prototype and methods |
| **WeakMap, WeakSet** | Not cloneable |
| **Circular references** | Not supported |
| **Streams** | Not cloneable |

### ⚠️ Closures Must Be Explicit

Functions lose access to external variables when sent to workers:

```ts
// ❌ FAILS - x doesn't exist in worker
const x = 10
await bee((a) => a + x)(5) // ReferenceError: x is not defined

// ✅ WORKS - pass x explicitly
const x = 10
await bee((a) => a + x)(5, { beeClosures: { x } }) // 15
```

```ts
// ❌ FAILS - helper loses access to multiplier
const multiplier = 2
const helper = (n) => n * multiplier

await beeThreads.run((x) => helper(x))
	.setContext({ helper }) // helper is stringified, loses closure!
	.usingParams(5)
	.execute()

// ✅ WORKS - pass all dependencies
await beeThreads.run((x) => helper(x))
	.setContext({ helper, multiplier })
	.usingParams(5)
	.execute() // 10
```

> **Need `require()`, database, or npm modules?** Use [`beeThreads.worker()`](#beethreadsworker---file-workers) instead.

---

## Why bee-threads?

- **Zero dependencies** - Lightweight and secure
- **Inline functions** - No separate worker files
- **Worker pool** - Auto-managed, no cold-start
- **Function caching** - LRU cache, 300-500x faster
- **Worker affinity** - V8 JIT optimization
- **Request coalescing** - Deduplicates identical calls
- **Turbo mode** - Parallel array processing
- **File workers** - External files with `require()` + turbo
- **Full TypeScript** - Complete type inference

---

MIT © [Samuel Santos](https://github.com/samsantosb)
