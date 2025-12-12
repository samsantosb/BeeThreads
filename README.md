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
	.setContext({ multiplier: 2 })
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

### `beeThreads.stream()` - Generators

```ts
const stream = beeThreads
	.stream(function* (n: number) {
		for (let i = 1; i <= n; i++) yield i * i
	})
	.usingParams(5)
	.execute()

for await (const value of stream) console.log(value) // 1, 4, 9, 16, 25
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

When you need **`require()`**, **database connections**, or **external modules** in a more sophisticated way.

```ts
// workers/hash-password.ts
import bcrypt from 'bcrypt'
export default async function (password: string): Promise<string> {
	return bcrypt.hash(password, 12)
}

// main.ts
import type hashPassword from './workers/hash-password'
const hash = await beeThreads.worker<typeof hashPassword>('./workers/hash-password')('secret123')
```

---

## `worker().turbo()` - File Workers + Parallel Arrays

Process large arrays with **database access** across multiple workers. Each worker has its own connection pool.

```ts
// workers/process-users.ts
import { db } from '../database'
import { calculateScore } from '../scoring'

export default async function (users: User[]): Promise<ProcessedUser[]> {
	return Promise.all(
		users.map(async user => ({
			...user,
			score: await calculateScore(user),
			data: await db.fetch(user.id),
		}))
	)
}

// main.ts - 10,000 users across 8 workers
const results = await beeThreads.worker('./workers/process-users').turbo(users, { workers: 8 })
```

> **Default workers:** `os.cpus().length - 1` (if not specified)

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

## Benchmarks

```bash
bun benchmarks.js   # Bun
node benchmarks.js  # Node
```

### Results (1M items, heavy computation, 12 CPUs, 10 runs average)

**Windows**

| Runtime | Mode       | Time (±std)   | vs Main   | Main Thread |
| ------- | ---------- | ------------- | --------- | ----------- |
| Bun     | main       | 285 ± 5ms     | 1.00x     | ❌ blocked   |
| Bun     | bee        | 1138 ± 51ms   | 0.25x     | ✅ free      |
| Bun     | turbo(8)   | 180 ± 8ms     | 1.58x     | ✅ free      |
| Bun     | turbo(12)  | **156 ± 12ms**| **1.83x** | ✅ free      |
| Node    | main       | 368 ± 13ms    | 1.00x     | ❌ blocked   |
| Node    | bee        | 5569 ± 203ms  | 0.07x     | ✅ free      |
| Node    | turbo(8)   | 1052 ± 22ms   | 0.35x     | ✅ free      |
| Node    | turbo(12)  | 1017 ± 57ms   | 0.36x     | ✅ free      |

**Linux (Docker)**

| Runtime | Mode       | Time (±std)   | vs Main   | Main Thread |
| ------- | ---------- | ------------- | --------- | ----------- |
| Bun     | main       | 338 ± 8ms     | 1.00x     | ❌ blocked   |
| Bun     | bee        | 1882 ± 64ms   | 0.18x     | ✅ free      |
| Bun     | turbo(8)   | 226 ± 7ms     | 1.50x     | ✅ free      |
| Bun     | turbo(12)  | **213 ± 20ms**| **1.59x** | ✅ free      |
| Node    | main       | 522 ± 54ms    | 1.00x     | ❌ blocked   |
| Node    | bee        | 5520 ± 163ms  | 0.09x     | ✅ free      |
| Node    | turbo(8)   | 953 ± 44ms    | 0.55x     | ✅ free      |
| Node    | turbo(12)  | **861 ± 64ms**| **0.61x** | ✅ free      |

### Key Insights

| Insight | Explanation |
|---------|-------------|
| **Bun + turbo = real speedup** | 1.6-1.8x faster than main thread |
| **Node + turbo = non-blocking** | Main thread free for HTTP/events |
| **Linux > Windows** | Node performs ~40% better on Linux |
| **turbo >> bee for arrays** | 7x faster for large array processing |
| **Default workers** | `os.cpus() - 1` is safe for all systems |

### When to Use

| Scenario                   | Recommendation                      |
| -------------------------- | ----------------------------------- |
| Bun + heavy computation    | `turbo(cpus)` → real parallelism    |
| Node + HTTP server         | `turbo()` → non-blocking I/O        |
| Light function (`x * x`)   | Main thread → overhead not worth it |
| CLI/batch processing       | `turbo(cpus + 4)` → max throughput  |
| Database + large arrays    | `worker().turbo()` → best of both   |

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
