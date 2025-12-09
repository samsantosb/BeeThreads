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

```bash
npm install bee-threads
```

```js
const { bee } = require('bee-threads')

// Run any function in a separate thread - promise style
const result = await bee(x => x * 2)(21) // 42

// Non-blocking CPU-intensive operations
const hash = await bee(pwd => require('crypto').pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex'))('password123')

// Run with Promise.all
const [a, b, c] = await Promise.all([bee(x => x * 2)(21), bee(x => x + 1)(41), bee(() => 'hello')()])
```

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
const { parentPort } = require('worker_threads')
parentPort.on('message', x => {
	parentPort.postMessage(x * 2)
})

// main.js
const { Worker } = require('worker_threads')
const worker = new Worker('./worker.js')

worker.postMessage(21)

worker.on('message', result => {
	console.log(result) // 42
})

worker.on('error', err => {
	console.error('Worker error:', err)
})

worker.on('exit', code => {
	if (code !== 0) {
		console.error(`Worker stopped: ${code}`)
	}
})

// No pooling, no reuse, no caching...
// 50+ lines of boilerplate
```

</td>
<td>

```js
const { bee } = require('bee-threads')

const result = await bee(x => x * 2)(21)
// 42

// ✅ Worker pool (auto-managed)
// ✅ Function caching (300-500x faster)
// ✅ Worker affinity (V8 JIT benefits)
// ✅ Priority Queues
// ✅ Error handling (try/catch works)
// ✅ TypeScript support
// ✅ Zero dependencies
// ✅ Promise-like syntax
```

</td>
</tr>
</table>

---

## Basic Usage

```js
// Simple
await bee(() => 42)()

// With arguments
await bee((a, b) => a + b)(10, 20) // → 30

// External variables (closures)
const TAX = 0.2
await bee(price => price * (1 + TAX))(100, { beeClosures: { TAX } }) // → 120
```

---

## Full API

For more control, use `beeThreads`:

```js
const { beeThreads } = require('bee-threads')

await beeThreads
	.run(x => x * 2)
	.usingParams(21)
	.execute() // → 42
```

### `.usingParams(...args)`

```js
await beeThreads.run((a, b) => a + b).usingParams(10, 20).execute() // → 30
```

### `.setContext({ vars })`

Inject external variables (closures):

```js
const TAX = 0.2
await beeThreads.run(p => p * (1 + TAX)).usingParams(100).setContext({ TAX }).execute() // → 120
```

### `.signal(AbortSignal)` - Cancellation

Cancel long-running tasks from outside the worker:

```js
const { AbortError } = require('bee-threads')

const controller = new AbortController()

// Start a long task
const promise = beeThreads
  .run(() => {
    let sum = 0
    for (let i = 0; i < 1e10; i++) sum += i  // Very long loop
    return sum
  })
  .signal(controller.signal)
  .execute()

// Cancel after 100ms
setTimeout(() => controller.abort(), 100)

try {
  await promise
} catch (err) {
  if (err instanceof AbortError) {
    console.log('Task was cancelled!')  // ← This runs
  }
}
```

### `.retry(options)` - Auto-retry with Exponential Backoff

Automatically retry failed tasks with configurable backoff:

```js
// Retry flaky API calls
const data = await beeThreads
  .run(() => {
    const res = require('https').get('https://flaky-api.com/data')
    if (Math.random() < 0.5) throw new Error('Random failure')
    return res
  })
  .retry({
    maxAttempts: 5,      // Try up to 5 times (default: 3)
    baseDelay: 100,      // Start with 100ms delay (default: 100)
    maxDelay: 5000,      // Cap delay at 5s (default: 5000)
    backoffFactor: 2     // Double delay each retry (default: 2)
  })
  .execute()

// Delays: 100ms → 200ms → 400ms → 800ms → 1600ms (capped at maxDelay)
```

### `.priority('high' | 'normal' | 'low')` - Task Priority

Control execution order when the queue has pending tasks:

```js
// Critical tasks jump the queue
await beeThreads.run(() => processPayment()).priority('high').execute()

// Background tasks wait for others
await beeThreads.run(() => generateReport()).priority('low').execute()

// Default priority
await beeThreads.run(() => normalTask()).priority('normal').execute()
```

Queue order: `high` → `normal` → `low`. Same-priority tasks execute in FIFO order.

### `.transfer([ArrayBuffer])` - Zero-copy Binary Transfer

Transfer ownership of ArrayBuffers to avoid copying large data:

```js
// ❌ WITHOUT transfer: Buffer is COPIED (slow for large data)
const buf = new ArrayBuffer(10 * 1024 * 1024)  // 10MB
await beeThreads.run(b => process(b)).usingParams(buf).execute()
// buf is still usable here, but 10MB was copied to worker

// ✅ WITH transfer: Buffer is MOVED (zero-copy, instant)
const buf2 = new ArrayBuffer(10 * 1024 * 1024)  // 10MB
await beeThreads.run(b => process(b)).usingParams(buf2).transfer([buf2]).execute()
// buf2 is now "neutered" (unusable) - ownership transferred to worker
// console.log(buf2.byteLength)  // 0 - buffer was transferred!
```

**Use case:** Image/video processing, large file handling, WebAssembly memory.

---

## ⚡ Turbo Mode - Parallel Array Processing

Process large arrays across **ALL CPU cores** with **fail-fast** error handling.

```
┌─────────────────────────────────────────────────────────────────────┐
│  beeThreads.turbo(fn).map([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │         SPLIT INTO BATCHES              │
        │    (auto-calculated per worker)         │
        └─────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
   │  Worker 1   │     │  Worker 2   │     │  Worker 3   │
   │ [1,2,3,4]   │     │ [5,6,7,8]   │     │ [9,10,11,12]│
   │  fn(item)   │     │  fn(item)   │     │  fn(item)   │
   └─────────────┘     └─────────────┘     └─────────────┘
          │                   │                   │
          │              ❌ ERROR!                │
          │                   │                   │
          ▼                   ▼                   ▼
   ┌─────────────────────────────────────────────────────┐
   │  FAIL-FAST: All workers abort, Promise rejects     │
   │  Resources cleaned up, error propagated to caller  │
   └─────────────────────────────────────────────────────┘
```

### Usage

```js
// Map
const squares = await beeThreads.turbo(x => x * x).map(numbers)

// Filter
const evens = await beeThreads.turbo(x => x % 2 === 0).filter(numbers)

// Reduce
const sum = await beeThreads.turbo((a, b) => a + b).reduce(numbers, 0)

// TypedArray (SharedArrayBuffer - 4x faster!)
const pixels = new Float64Array(1_000_000)
const bright = await beeThreads.turbo(x => Math.min(255, x * 1.2)).map(pixels)

// With context
const factor = 2.5
await beeThreads.turbo(x => x * factor, { context: { factor } }).map(data)

// With stats
const { data, stats } = await beeThreads.turbo(x => x * x).mapWithStats(arr)
console.log(stats.speedupRatio) // "7.2x"
```

### Image & Video Processing

```js
// 🖼️ Image: Grayscale conversion (1920x1080 = 2M pixels)
const imageBuffer = new Uint8Array(rawPixelData)
const grayscale = await beeThreads
	.turbo(v => Math.round(v * 0.299)) // Simplified grayscale
	.map(imageBuffer)

// 🎬 Video: Process frames with generator (memory efficient)
const stream = beeThreads.stream(function* (videoPath) {
	const decoder = createVideoDecoder(videoPath)
	for (const frame of decoder) {
		yield processFrame(frame) // Yields each frame as processed
	}
}).usingParams('video.mp4').execute()

for await (const processedFrame of stream) {
	writeFrame(processedFrame) // Stream to output without loading all in memory
}

// 🔥 Batch process video frames with turbo
const frames = extractFrames('video.mp4') // Array of Uint8Array
const processed = await Promise.all(
	frames.map(frame => beeThreads.turbo(px => px * 1.2).map(frame))
)
```

### When to Use

| Scenario | Best Choice | Why |
| -------- | ----------- | --- |
| Single heavy task | `bee()` | Simple, one worker |
| Batch processing (10K+) | `turbo()` | Parallel across all cores |
| TypedArray / Image | `turbo()` | SharedArrayBuffer, zero-copy |
| Video / Large files | `stream()` | Memory efficient, yields as processed |
| Real-time processing | `bee()` + `stream()` | Combine for best of both |

> **Auto-fallback:** `turbo()` with < 10K items automatically uses single-worker mode.

---

## Request Coalescing

Prevents duplicate simultaneous calls from running multiple times. When the same function with identical arguments is called while a previous call is in-flight, subsequent calls share the same Promise.

```js
// All 3 calls share ONE execution, return same result
const [r1, r2, r3] = await Promise.all([
	bee(x => expensiveComputation(x))(42),
	bee(x => expensiveComputation(x))(42),
	bee(x => expensiveComputation(x))(42),
])

// Control coalescing
beeThreads.setCoalescing(false) // disable globally
beeThreads.getCoalescingStats() // { coalesced: 15, unique: 100, coalescingRate: '13%' }

// Opt-out for specific execution
await beeThreads.run(() => Date.now()).noCoalesce().execute()
```

**Auto-detection:** Functions with `Date.now()`, `Math.random()`, `crypto.randomUUID()` are automatically excluded.

---

## Generators (Streaming)

Stream results as they're produced instead of waiting for all:

```js
const stream = beeThreads
	.stream(function* (n) {
		for (let i = 1; i <= n; i++) {
			yield i * i // Streamed immediately
		}
		return 'done' // Captured in stream.returnValue
	})
	.usingParams(5)
	.execute()

for await (const value of stream) {
	console.log(value) // 1, 4, 9, 16, 25
}
console.log(stream.returnValue) // 'done'
```

---

## Error Handling

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads')

try {
	await beeThreads.run(fn).execute()
} catch (err) {
	if (err instanceof TimeoutError) {
		/* timeout */
	}
	if (err instanceof AbortError) {
		/* cancelled */
	}
	if (err instanceof QueueFullError) {
		/* queue full */
	}
	if (err instanceof WorkerError) {
		// Custom error properties preserved
		console.log(err.code, err.statusCode)
	}
}

// Safe mode - never throws, returns result object
const result = await beeThreads.run(fn).safe().execute()
if (result.status === 'fulfilled') {
	console.log(result.value)
} else {
	console.log(result.error)
}
```

---

## Configuration

```js
beeThreads.configure({
	poolSize: 8, // Max workers (default: CPU cores)
	minThreads: 2, // Pre-warmed workers
	maxQueueSize: 1000, // Max pending tasks
	workerIdleTimeout: 30000, // Cleanup idle workers (ms)
	debugMode: true, // Show function source in errors
	logger: console, // Custom logger (or null)
	lowMemoryMode: false, // Reduce memory (~60-80% less)
	coalescing: true, // Request coalescing (default: true)
})

await beeThreads.warmup(4) // Pre-warm 4 workers
const stats = beeThreads.getPoolStats() // Metrics
await beeThreads.shutdown() // Graceful shutdown
```

---

## TypeScript

Full type inference:

```ts
import { bee, beeThreads, TimeoutError, WorkerError } from 'bee-threads'

const result = await bee((x: number) => x * 2)(21) // number

const stream = beeThreads
	.stream(function* (n: number) {
		yield n * 2
	})
	.usingParams(5)
	.execute() // StreamResult<number>
```

---

## Limitations

- **No `this` binding** - Use arrow functions or `.setContext()`
- **No closures** - External vars via `beeClosures` or `.setContext()`
- **Serializable only** - No functions, Symbols, or circular refs in args/return

---

## Worker Environment

| API                      | Status                   |
| ------------------------ | ------------------------ |
| `require()`              | ✅ Works                 |
| `Buffer`                 | ✅ Works                 |
| `URL`, `URLSearchParams` | ✅ Works                 |
| `TextEncoder/Decoder`    | ✅ Works                 |
| `crypto`                 | ✅ Works                 |
| `Intl`                   | ✅ Works                 |
| `AbortController`        | ❌ Use signal externally |
| `structuredClone`        | ❌ Not available         |
| `performance.now()`      | ❌ Use `Date.now()`      |

---

## Use Cases

- Password hashing (PBKDF2, bcrypt)
- Image processing (sharp, jimp)
- Large JSON parsing
- Data compression
- PDF generation
- Heavy computations
- **Large array processing** (turbo mode)
- **Matrix operations** (turbo mode)
- **Numerical simulations** (turbo mode)

---

## Why bee-threads?

- **Zero dependencies** - Lightweight and secure
- **Inline functions** - No separate worker files
- **Worker pool** - Reuses threads, no cold-start
- **Function caching** - LRU cache, 300-500x faster
- **Worker affinity** - Same function → same worker (V8 JIT)
- **Request coalescing** - Deduplicates identical calls
- **Turbo mode** - Parallel array processing
- **Full TypeScript** - Complete type definitions

---

MIT © [Samuel Santos](https://github.com/samsantosb)
