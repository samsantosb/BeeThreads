# bee-threads - Technical Documentation

> Complete guide to architecture, internal decisions, and performance optimizations.

**Version:** 3.4.0 (TypeScript)

---

## Table of Contents

1. [What is bee-threads?](#what-is-bee-threads)
2. [Architecture Overview](#architecture-overview)
3. [File-by-File Breakdown](#file-by-file-breakdown)
4. [Technical Decisions](#technical-decisions)
5. [Security Architecture](#security-architecture)
6. [Performance Architecture](#performance-architecture)
7. [Data Flow](#data-flow)
8. [Error Handling](#error-handling)
9. [Memory Management](#memory-management)
10.   [Runtime & Bundler Compatibility](#runtime--bundler-compatibility)
11.   [Contributing Guide](#contributing-guide)

---

## What is bee-threads?

**bee-threads** is a zero-dependency library that makes Node.js worker threads as simple as Promises.

### The Problem

Native `worker_threads` require:

-  Creating separate worker files
-  Managing message passing manually
-  Handling worker lifecycle (creation, errors, termination)
-  Implementing your own pooling logic

```js
// Native worker_threads: ~50+ lines of boilerplate
const { Worker } = require('worker_threads')
const worker = new Worker('./worker.js')
worker.postMessage({ data: 21 })
worker.on('message', result => console.log(result))
worker.on('error', handleError)
worker.on('exit', handleExit)
// ... error handling, lifecycle management, pooling...
```

### The Solution

```js
// bee-threads: 1 line
const result = await bee(x => x * 2)(21) // 42
```

### Key Features

| Feature                | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| **Zero dependencies**  | Only uses Node.js built-in modules                      |
| **Inline functions**   | No separate worker files needed                         |
| **Worker pool**        | Automatic worker reuse with load balancing              |
| **Function caching**   | LRU cache with vm.Script compilation                    |
| **Worker affinity**    | Routes same function to same worker for V8 JIT benefits |
| **TypeScript**         | Full type definitions included                          |
| **Generators**         | Stream results with generator functions                 |
| **Cancellation**       | AbortSignal support for task cancellation               |
| **Retry**              | Automatic retry with exponential backoff                |
| **Request Coalescing** | Deduplicates identical simultaneous calls               |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                             User Code                                   │
│   bee(fn)(args)  or  beeThreads.run(fn).usingParams(...).execute()      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         index.ts (Public API)                           │
│   • bee() - Simple curried API                                          │
│   • beeThreads.run/withTimeout/stream                                   │
│   • configure/shutdown/warmup/getPoolStats                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
           ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
           │ executor.ts  │ │stream-exec.ts│ │   pool.ts    │
           │ Fluent API   │ │Generator API │ │ Worker mgmt  │
           └──────────────┘ └──────────────┘ └──────────────┘
                    │               │               │
                    └───────────────┼───────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        execution.ts (Task Engine)                       │
│   • Worker communication                                                │
│   • Timeout/abort handling (race-condition safe)                        │
│   • Retry with exponential backoff                                      │
│   • Request coalescing (via coalescing.ts)                              │
│   • Metrics tracking                                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
              ┌─────────────────────┴──────────────────────┐
              ▼                                            ▼
┌─────────────────────────────┐             ┌─────────────────────────────┐
│         worker.ts           │             │     generator-worker.ts     │
│  • vm.Script compilation    │             │   • Streaming yields        │
│  • LRU function cache       │             │   • Return value capture    │
│  • Curried fn support       │             │   • Same optimizations      │
│  • Console forwarding       │             │                             │
│  • Error property preserve  │             │                             │
└─────────────────────────────┘             └─────────────────────────────┘
```

---

## File-by-File Breakdown

### `src/index.ts` - Public API Entry Point

**Why it exists:**
Single entry point that hides internal complexity. Users only need `require('bee-threads')`.

**What it does:**

-  Exports `bee()` - the simple curried API
-  Exports `beeThreads` - the full fluent API
-  Re-exports error classes for catch handling
-  Implements the `bee()` function with thenable support

**Key exports:**

| Export           | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `bee(fn)`        | Simple curried API for quick tasks                     |
| `beeThreads`     | Full API with all features                             |
| `AbortError`     | Thrown on cancellation                                 |
| `TimeoutError`   | Thrown on timeout                                      |
| `QueueFullError` | Thrown when queue limit reached                        |
| `WorkerError`    | Wraps errors from worker (preserves custom properties) |
| `noopLogger`     | Silent logger for disabling logs                       |

**Example:**

```js
const { bee, beeThreads, TimeoutError } = require('bee-threads')

// Simple API
const result = await bee(x => x * 2)(21)

// Full API
const result = await beeThreads
	.run(x => x * 2)
	.usingParams(21)
	.execute()
```

---

### `src/types.ts` - TypeScript Type Definitions

**Why it exists:**
Centralizes all type definitions for the entire library. Enables full IntelliSense support and compile-time type checking.

**What it does:**

-  Defines all interfaces (`PoolConfig`, `WorkerEntry`, `ExecutionOptions`, etc.)
-  Defines message types for worker communication
-  Exports the `noopLogger` for disabling logs

**Key types:**

```typescript
// Message types for worker communication
const MessageType = {
	SUCCESS: 'success',
	ERROR: 'error',
	LOG: 'log',
	YIELD: 'yield',
	RETURN: 'return',
	END: 'end',
} as const

// Logger interface (compatible with Pino, Winston, console)
interface Logger {
	log(...args: unknown[]): void
	warn(...args: unknown[]): void
	error(...args: unknown[]): void
	info(...args: unknown[]): void
	debug(...args: unknown[]): void
}
```

**Technical Decision:** Uses `as const` object instead of TypeScript `enum` for better tree-shaking and runtime performance.

---

### `src/config.ts` - Centralized State Management

**Why it exists:**
Single source of truth for ALL mutable state. Makes debugging easier and testing predictable.

**What it does:**

-  Stores pool configuration (`poolSize`, `minThreads`, `timeout`, etc.)
-  Manages worker pools (`pools.normal`, `pools.generator`)
-  Maintains O(1) counters for busy/idle workers
-  Tracks execution metrics

**State managed:**

```typescript
config // User settings (poolSize, timeout, retry, etc.)
pools // Active workers { normal: Worker[], generator: Worker[] }
poolCounters // O(1) counters { busy: N, idle: N }
queues // Pending tasks by priority { high: [], normal: [], low: [] }
metrics // Execution statistics
```

**Technical Decision:** `poolCounters` exist for O(1) state checks. Instead of `pools.filter(w => !w.busy).length` (O(n)), we maintain counters that update on every state change.

---

### `src/pool.ts` - Worker Pool Management

**Why it exists:**
Manages the lifecycle of worker threads with intelligent task routing.

**What it does:**

-  Creates workers with proper configuration
-  Selects best worker for each task (load balancing + affinity)
-  Returns workers to pool after use
-  Cleans up idle workers to free resources
-  Manages temporary overflow workers

**Selection Strategy (priority order):**

| Priority | Strategy              | Why                                               |
| -------- | --------------------- | ------------------------------------------------- |
| 1        | **Affinity match**    | Worker already has function cached & V8-optimized |
| 2        | **Least-used idle**   | Distributes load evenly across pool               |
| 3        | **Create new pooled** | Pool not at capacity                              |
| 4        | **Create temporary**  | Overflow handling, terminated after use           |
| 5        | **Queue task**        | No resources available                            |

**Example:**

```js
// Affinity in action
await bee(x => heavyComputation(x))(1) // Worker A
await bee(x => heavyComputation(x))(2) // Worker A again (affinity hit)
await bee(y => differentFn(y))(3) // Worker B (affinity miss)
```

---

### `src/execution.ts` - Core Task Engine

**Why it exists:**
Heart of task execution. Orchestrates worker communication and handles edge cases.

**What it does:**

-  Acquires worker from pool (with affinity preference)
-  Sends task to worker via `postMessage`
-  Handles responses, errors, and timeouts
-  Releases worker back to pool
-  Tracks metrics for monitoring
-  Implements retry with exponential backoff

**Race Condition Prevention:**

```typescript
// Timeout handler - set settled BEFORE terminate
timer = setTimeout(() => {
  if (settled) return;
  settled = true;  // FIRST - prevents onExit race

  // Remove listeners before terminate
  worker.removeListener('exit', onExit);
  worker.terminate();

  // Release with terminated=true to remove from pool
  releaseWorker(entry, worker, ..., terminated: true);
  reject(new TimeoutError(timeout));
}, timeout);
```

**Technical Decision:** Setting `settled = true` BEFORE calling `terminate()` prevents race conditions where the async `exit` event could beat the timeout handler.

---

### `src/executor.ts` - Fluent API Builder

**Why it exists:**
Implements the immutable builder pattern for task execution.

**What it does:**

-  Creates chainable API (`.usingParams()`, `.setContext()`, `.retry()`, `.noCoalesce()`, etc.)
-  Each method returns a NEW executor instance (immutable)
-  Validates inputs before execution

**Chainable methods:**

| Method                     | Description                                  |
| -------------------------- | -------------------------------------------- |
| `.usingParams(...args)`    | Pass arguments to the function               |
| `.setContext(obj)`         | Inject external variables (closures)         |
| `.signal(AbortSignal)`     | Enable cancellation                          |
| `.retry(options)`          | Auto-retry on failure                        |
| `.priority(level)`         | Set queue priority                           |
| `.transfer([ArrayBuffer])` | Zero-copy for large binary data              |
| `.noCoalesce()`            | Skip request coalescing for this execution   |
| `.reconstructBuffers()`    | Convert Uint8Array back to Buffer in results |
| `.execute()`               | Run the function                             |

**Example:**

```js
// Immutable - base can be reused
const base = beeThreads.run(fn).setContext({ API_KEY: 'xxx' })

await base.usingParams(1).execute() // Uses context
await base.usingParams(2).execute() // Same context, different params

// Skip coalescing for specific call
await beeThreads
	.run(() => Date.now())
	.noCoalesce()
	.execute()
```

**Validation:**

```typescript
// Context validation - no functions or Symbols
setContext(context: Record<string, unknown>): Executor<T> {
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === 'function') {
      throw new TypeError(`setContext() key "${key}" contains a function...`);
    }
  }
}
```

---

### `src/stream-executor.ts` - Generator Streaming

**Why it exists:**
Enables streaming results from generator functions.

**What it does:**

-  Creates `ReadableStream` from generator functions
-  Streams yielded values as they're produced
-  Captures return value for access after completion
-  Handles cleanup on cancel

**Chainable methods:**

| Method                  | Description                                  |
| ----------------------- | -------------------------------------------- |
| `.usingParams(...args)` | Pass arguments to the generator              |
| `.setContext(obj)`      | Inject external variables (closures)         |
| `.transfer([...]))`     | Zero-copy for large binary data              |
| `.reconstructBuffers()` | Convert Uint8Array back to Buffer in results |
| `.execute()`            | Start streaming                              |

**Example:**

```js
const stream = beeThreads
	.stream(function* (n) {
		for (let i = 1; i <= n; i++) {
			yield i * i
		}
		return 'done'
	})
	.usingParams(5)
	.execute()

for await (const value of stream) {
	console.log(value) // 1, 4, 9, 16, 25
}

console.log(stream.returnValue) // 'done'
```

**With Buffer reconstruction:**

```js
const stream = beeThreads
	.stream(function* () {
		yield require('fs').readFileSync('chunk1.bin')
		yield require('fs').readFileSync('chunk2.bin')
	})
	.reconstructBuffers()
	.execute()

for await (const chunk of stream) {
	console.log(Buffer.isBuffer(chunk)) // true ✅
}
```

---

### `src/cache.ts` - LRU Function Cache

**Why it exists:**
Avoids repeated function compilation for massive performance gains.

**What it does:**

-  Compiles functions using `vm.Script` (not `eval()`)
-  Caches compiled functions in LRU cache
-  Creates optimized sandbox for context injection
-  Reuses shared base context when no custom context needed

**Performance comparison:**

| Operation         | Time         |
| ----------------- | ------------ |
| vm.Script compile | ~0.3-0.5ms   |
| Cache lookup      | ~0.001ms     |
| **Speedup**       | **300-500x** |

**Why vm.Script instead of eval():**

| Aspect                   | eval()                | vm.Script               |
| ------------------------ | --------------------- | ----------------------- |
| Context injection        | String manipulation   | Native runInContext()   |
| V8 code caching          | Lost on string change | produceCachedData: true |
| Performance (cached)     | ~1.2-3µs              | ~0.08-0.3µs             |
| Performance (w/ context) | ~4.8ms                | ~0.1ms (43x faster)     |
| Stack traces             | Shows "eval"          | Proper filename         |

**Technical Decision:** When no context is needed (~90% of cases), we reuse a shared base context instead of creating a new V8 context (~1-2MB each).

---

### `src/worker.ts` - Worker Thread Script

**Why it exists:**
The code that runs inside each worker thread for regular functions.

**What it does:**

-  Receives function source + arguments + context from main thread
-  Validates function source (with caching)
-  Compiles using vm.Script with LRU caching
-  Executes function (handles async and curried)
-  Sends result back to main thread
-  Forwards console.log/warn/error to main thread

**Error Serialization:**

```typescript
function serializeError(e: unknown): SerializedError {
	const serialized = {
		name: err.name,
		message: err.message,
		stack: err.stack,
		// Preserve Error.cause (ES2022)
		cause: err.cause ? serializeError(err.cause) : undefined,
		// Preserve AggregateError.errors
		errors: err.errors?.map(serializeError),
	}

	// Copy custom properties (code, statusCode, etc.)
	for (const key of Object.keys(err)) {
		if (!['name', 'message', 'stack'].includes(key)) {
			serialized[key] = err[key]
		}
	}

	return serialized
}
```

**Technical Decision:** We check `e.name` instead of `instanceof Error` because errors from `vm.createContext()` have a different Error class.

---

### `src/generator-worker.ts` - Generator Worker Script

**Why it exists:**
The code that runs inside worker threads for generator functions.

**What it does:**

-  Same as `worker.ts` but handles generators
-  Streams yielded values back to main thread
-  Captures return value for final message
-  Handles async generators (yields that return Promises)

**Message flow:**

```
Main Thread                    Worker Thread
     |                              |
     |-------- { fn, args } ------->|
     |                              | (execute generator)
     |<------ { type: YIELD } ------|
     |<------ { type: YIELD } ------|
     |<------ { type: RETURN } -----|
     |<------ { type: END } --------|
```

---

### `src/errors.ts` - Custom Error Classes

**Why it exists:**
Typed errors for specific failure modes with error codes.

**Error classes:**

| Error            | Code             | When                           |
| ---------------- | ---------------- | ------------------------------ |
| `AbortError`     | `ERR_ABORTED`    | Task cancelled via AbortSignal |
| `TimeoutError`   | `ERR_TIMEOUT`    | Exceeded time limit            |
| `QueueFullError` | `ERR_QUEUE_FULL` | Queue at maxQueueSize          |
| `WorkerError`    | `ERR_WORKER`     | Error thrown inside worker     |

**Example:**

```js
try {
	await beeThreads
		.withTimeout(1000)(() => slowTask())
		.execute()
} catch (err) {
	if (err instanceof TimeoutError) {
		console.log(`Timed out after ${err.timeout}ms`)
	}
	if (err instanceof WorkerError) {
		console.log(err.code) // Custom error code preserved
		console.log(err.statusCode) // Custom properties preserved
	}
}
```

---

### `src/validation.ts` - Input Validation

**Why it exists:**
Fail-fast validation functions that throw immediately on invalid input.

**Functions:**

```typescript
validateFunction(fn) // Ensures fn is a callable function
validateTimeout(ms) // Ensures ms is positive finite number
validatePoolSize(size) // Ensures size is positive integer
validateClosure(obj) // Ensures obj is non-null object
```

---

### `src/turbo.ts` - Parallel Array Processing (Turbo Mode)

**Why it exists:**
Processes large arrays in parallel across ALL available workers using SharedArrayBuffer for zero-copy data transfer with TypedArrays.

**What it does:**

-  Creates TurboExecutor for parallel map/filter/reduce operations
-  Automatically splits data across all available workers
-  Uses SharedArrayBuffer for TypedArrays (Float64Array, Int32Array, etc.)
-  Falls back to single-worker for small arrays (< 10K items)
-  Provides execution statistics (speedup ratio, workers used, etc.)

**Key functions:**

```typescript
createTurboExecutor(fn, options) // Creates executor with map/filter/reduce
executeTurboMap(fn, data, options) // Parallel map operation
executeTurboFilter(fn, data, options) // Parallel filter operation
executeTurboReduce(fn, data, initial, options) // Parallel tree reduction
```

**TurboExecutor methods:**

| Method                | Description                          |
| --------------------- | ------------------------------------ |
| `.map(data)`          | Transform each item in parallel      |
| `.mapWithStats()`     | Map with execution statistics        |
| `.filter(data)`       | Filter items in parallel             |
| `.reduce(data, init)` | Reduce using parallel tree reduction |

**Example:**

```js
// Map - transform each item
const squares = await beeThreads.turbo(x => x * x).map(numbers)

// With TypedArray (SharedArrayBuffer - zero-copy)
const data = new Float64Array(1_000_000)
const result = await beeThreads.turbo(x => Math.sqrt(x)).map(data)

// Filter
const evens = await beeThreads.turbo(x => x % 2 === 0).filter(numbers)

// Reduce
const sum = await beeThreads.turbo((a, b) => a + b).reduce(numbers, 0)

// With stats
const { data, stats } = await beeThreads.turbo(x => heavyMath(x)).mapWithStats(arr)
console.log(stats.speedupRatio) // "7.2x"
```

---

### `src/turbo.ts` - Max Mode (Maximum Throughput)

**Why it exists:**
Provides **maximum CPU utilization** by including the main thread in parallel processing. While `turbo()` keeps the main thread free for event handling, `max()` sacrifices main thread availability for ultimate throughput.

**What it does:**

- Same API as turbo mode (`map`, `filter`, `reduce`)
- Splits work across ALL CPU cores INCLUDING the main thread
- Main thread processes its chunk while coordinating workers (async/sync hybrid)
- Context injection works on both main thread and workers
- Ideal for CLI scripts, batch processors, and dedicated processing servers

**Key functions:**

```typescript
createMaxExecutor(data, options) // Creates executor with map/filter/reduce
executeMaxMap(fn, data, options) // Parallel map with main thread
executeMaxFilter(fn, data, options) // Parallel filter with main thread
executeMaxReduce(fn, data, initial, options) // Parallel reduce with main thread
compileWithContext(fn, context) // Injects context for main thread execution
```

**Architecture:**

```
┌─────────────────────────────────────────────────────────────┐
│ max() on 8-core CPU = 7 workers + 1 main thread = 8 cores  │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌─────────────┐     ┌─────────────┐     ┌──────────────┐
   │  Worker 1-7 │     │  Worker N   │     │ MAIN THREAD  │
   │  (async)    │     │  (async)    │     │ (sync work)  │
   └─────────────┘     └─────────────┘     └──────────────┘
          │                   │                   │
          └───────────────────┴───────────────────┘
                              │
                    await Promise.all()
```

**Example:**

```js
// CLI script - maximum throughput
const data = new Array(1_000_000).fill(0).map((_, i) => i)
const result = await beeThreads.max(data).map(x => heavyComputation(x))

// Batch processor with stats
const { data: processed, stats } = await beeThreads
  .max(records)
  .mapWithStats(record => transformRecord(record))

console.log(`Used ${stats.workersUsed} threads (including main)`)
console.log(`Speedup: ${stats.speedupRatio}`)

// With context injection
await beeThreads
  .max(data, { context: { API_KEY: process.env.API_KEY } })
  .map(item => processWithKey(item, API_KEY))
```

**When to use:**

| Use Case | `turbo()` | `max()` |
|----------|-----------|---------|
| HTTP servers | ✅ | ❌ |
| CLI scripts | ✅ | ✅✅✅ |
| Batch jobs | ✅ | ✅✅✅ |
| Event-driven apps | ✅ | ❌ |
| Processing servers | ✅ | ✅✅✅ |

**Is max() async/await?**

YES! `max()` is fully async/await compatible:

1. Starts workers (async coordination)
2. **While waiting**, main thread processes its chunk (sync work)
3. Awaits all workers to complete (async)
4. Merges and returns results (async)

The main thread blocks **only during step 2** (its own chunk processing). It's a hybrid: async coordination + sync work.

**Performance vs turbo():**

| Metric | `turbo()` | `max()` |
|--------|-----------|---------|
| **Cores used (8-core CPU)** | 7 workers | 8 (7 + main) |
| **Main thread blocked** | No | Yes (during chunk processing) |
| **Throughput gain** | Baseline | ~10-15% faster |
| **HTTP server safe** | Yes | No |

**Context injection implementation:**

```typescript
// Main thread gets same context support as workers
function compileWithContext(fnString: string, context?: Record<string, unknown>): Function {
  if (!context || Object.keys(context).length === 0) {
    return new Function('return ' + fnString)();
  }
  
  // Inject context variables
  const contextKeys = Object.keys(context);
  const contextValues = contextKeys.map(k => context[k]);
  
  const wrapperCode = `
    return function(${contextKeys.join(', ')}) {
      const fn = ${fnString};
      return fn;
    }
  `;
  
  const wrapper = new Function(wrapperCode)();
  return wrapper(...contextValues);
}
```

**Optimizations applied:**

- Batch worker acquisition (same as turbo)
- Pre-calculated merge offsets (same as turbo)
- Main thread processes chunk in parallel with workers
- Zero overhead for context injection on main thread

---

### `src/coalescing.ts` - Request Coalescing (Promise Deduplication)

**Why it exists:**
Prevents duplicate simultaneous calls with the same function and arguments from executing multiple times. Also known as "singleflight" or "promise deduplication".

**What it does:**

-  Tracks in-flight promises by unique request key (function hash + arguments hash)
-  Returns existing promise for duplicate requests
-  Automatically detects non-deterministic functions (`Date.now()`, `Math.random()`, etc.)
-  Provides statistics for monitoring coalescing effectiveness

**Key functions:**

```typescript
coalesce(key, factory) // Returns existing or creates new promise
isNonDeterministic(fnStr) // Detects Date.now, Math.random, etc.
setCoalescingEnabled(bool) // Enable/disable globally
isCoalescingEnabled() // Check if enabled
getCoalescingStats() // { coalesced, unique, inFlight, coalescingRate }
resetCoalescingStats() // Reset counters
clearInFlightPromises() // Clear pending promises (used in shutdown)
```

**Non-deterministic patterns detected:**

| Pattern                        | Example                          |
| ------------------------------ | -------------------------------- |
| `Date.now()`                   | `() => Date.now()`               |
| `new Date()`                   | `() => new Date().toISOString()` |
| `Math.random()`                | `() => Math.random()`            |
| `crypto.randomUUID()`          | `() => crypto.randomUUID()`      |
| `performance.now()`            | `() => performance.now()`        |
| `uuid()`, `nanoid()`, `cuid()` | Common ID generation libraries   |
| `process.hrtime`               | `() => process.hrtime.bigint()`  |

**Example:**

```js
// Without coalescing: 3 separate executions
await Promise.all([bee(expensiveFn)(42), bee(expensiveFn)(42), bee(expensiveFn)(42)])

// With coalescing (default): 1 execution, 3 promises share result
// Stats: { coalesced: 2, unique: 1, coalescingRate: '66.67%' }
```

---

### `src/utils.ts` - Utility Functions

**Why it exists:**
Shared utility functions used across the codebase.

**Functions:**

```typescript
// Recursively freeze an object
deepFreeze({ a: { b: 1 } })

// Promise-based sleep
await sleep(1000)

// Exponential backoff with jitter
calculateBackoff(attempt, baseDelay, maxDelay, factor)

// Reconstruct Buffer from Uint8Array after postMessage serialization
reconstructBuffers(value)
```

**Why reconstructBuffers()?**

The Structured Clone Algorithm used by `postMessage` converts `Buffer` to `Uint8Array`.
This function recursively converts them back to `Buffer` for compatibility with
libraries like Sharp that expect `Buffer` returns.

```typescript
function reconstructBuffers(value: unknown): unknown {
	if (value instanceof Uint8Array && !(value instanceof Buffer)) {
		return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
	}
	// Recursively handle arrays and plain objects...
}
```

---

## Technical Decisions

### 1. Why vm.Script instead of eval()?

**Decision:** Use `vm.Script` with `vm.createContext()` instead of `eval()`.

**Rationale:**

-  **43x faster** for context injection scenarios
-  Native `runInContext()` vs string manipulation
-  V8 code caching with `produceCachedData: true`
-  Proper stack traces (shows filename instead of "eval")

### 2. Why LRU cache for functions?

**Decision:** Cache compiled functions using LRU (Least Recently Used) strategy.

**Rationale:**

-  Compilation is expensive (~0.3-0.5ms)
-  Cache lookup is cheap (~0.001ms)
-  LRU ensures frequently-used functions stay cached
-  Bounded size prevents memory bloat

### 3. Why worker affinity?

**Decision:** Route same function to same worker when possible.

**Rationale:**

-  V8's TurboFan JIT compiles hot functions to machine code
-  Affinity keeps functions "hot" in the same worker
-  Combined with LRU cache = near-native performance
-  Hash-based routing is O(1)

### 4. Why O(1) counters instead of array iteration?

**Decision:** Maintain separate `busy` and `idle` counters.

**Rationale:**

-  `pools.filter(w => !w.busy).length` is O(n)
-  Counter updates on state change are O(1)
-  Critical for high-throughput scenarios

### 5. Why shared base context?

**Decision:** Reuse a single `vm.Context` when no custom context is needed.

**Rationale:**

-  Creating a new context is expensive (~1-2MB each)
-  ~90% of calls don't need custom context
-  Massive memory savings in high-volume scenarios

### 6. Why settled flag before terminate()?

**Decision:** Set `settled = true` BEFORE calling `worker.terminate()`.

**Rationale:**

-  `terminate()` fires `exit` event asynchronously
-  Without the flag, `onExit` could race with timeout handler
-  This caused ~50% wrong error type in v3.1.1

### 7. Why monomorphic object shapes?

**Decision:** Declare all properties upfront in objects like `SerializedError`.

**Rationale:**

-  V8 optimizes objects with consistent shapes (hidden classes)
-  Adding properties dynamically causes deoptimization
-  Pre-declaring `undefined` properties maintains shape

### 8. Why request coalescing (singleflight)?

**Decision:** Deduplicate identical simultaneous calls by sharing the same promise.

**Rationale:**

-  Prevents redundant work when multiple callers request the same computation
-  Common in web servers: multiple requests for same data hit simultaneously
-  Uses minimal memory (Map of in-flight promises, cleared on completion)
-  Automatic detection of non-deterministic functions avoids incorrect sharing
-  Manual opt-out via `.noCoalesce()` for edge cases

**Trade-off:** Functions with side effects that should run multiple times need `.noCoalesce()`.

### 9. Why turbo mode with SharedArrayBuffer?

**Decision:** Use SharedArrayBuffer for TypedArrays and chunk-based distribution for regular arrays.

**Rationale:**

-  **Zero-copy for TypedArrays:** SharedArrayBuffer allows all workers to read/write the same memory without serialization overhead
-  **Automatic threshold:** Arrays < 10K items use single-worker (overhead > benefit)
-  **Parallel tree reduction:** Reduces each chunk independently, then combines results
-  **High priority dispatch:** Turbo tasks get 'high' priority in the queue to minimize latency
-  **Automatic fallback:** Small arrays fall back to single-worker mode transparently

**Performance characteristics:**

| Array Size | Single Worker | Turbo (8 cores) | Speedup |
| ---------- | ------------- | --------------- | ------- |
| 10K items  | 45ms          | 20ms            | 2.2x    |
| 100K items | 450ms         | 120ms           | 3.7x    |
| 1M items   | 4.2s          | 580ms           | 7.2x    |

**Trade-offs:**

-  SharedArrayBuffer only works with numeric TypedArrays (not objects/strings)
-  Overhead for small arrays exceeds parallel benefit
-  Reduce operations require associative functions for correctness

### 10. Why max mode (main thread + workers)?

**Decision:** Add `max()` mode that includes the main thread in parallel processing, alongside `turbo()` which keeps main thread free.

**Rationale:**

- **Ultimate throughput:** On 8-core CPU, `turbo()` uses 7 workers (1 core idle), `max()` uses all 8 cores (~10-15% faster)
- **Different use cases:** HTTP servers need main thread free (use `turbo()`), batch processors want max speed (use `max()`)
- **Still async/await:** While main thread processes its chunk synchronously, overall coordination is async
- **Safe by design:** Name "max" signals main thread involvement, users consciously choose when to use it
- **Same API:** `max()` has identical API to `turbo()` for easy switching

**Implementation details:**

- Main thread compiles function with context injection (same logic as workers)
- Processes its chunk **while** awaiting workers (parallel work)
- No extra synchronization needed (Promise.all handles coordination)
- Context injection uses same `compileWithContext()` helper on main thread

**Trade-offs:**

- Main thread blocked during chunk processing (not suitable for servers with incoming requests)
- Only valuable when CPU utilization is bottleneck (not I/O bound tasks)
- ~10-15% speedup may not justify loss of main thread responsiveness in many scenarios

**When to recommend:**

| Scenario | Recommendation |
|----------|----------------|
| HTTP/WebSocket servers | `turbo()` |
| CLI data processing | `max()` |
| Batch ETL jobs | `max()` |
| Dedicated processing servers | `max()` |
| Real-time event handling | `turbo()` |
| Cron jobs | `max()` |

### 11. Why security by default?

**Decision:** Enable security protections by default with opt-out config.

**Rationale:**

-  Security should be the default state
-  Transparent protections don't affect normal use cases
-  Users who need to disable can do so explicitly
-  Follows principle of least surprise

---

## Security Architecture

### Built-in Protections

| Protection                    | Type                 | Default       | Configurable                       |
| ----------------------------- | -------------------- | ------------- | ---------------------------------- |
| **Function size limit**       | DoS prevention       | 1MB           | `security.maxFunctionSize`         |
| **Prototype pollution block** | Injection prevention | Enabled       | `security.blockPrototypePollution` |
| **vm.Script sandboxing**      | Isolation            | Always        | No                                 |
| **data: URL workers**         | CSP-friendly         | Auto-detected | No                                 |

### Function Size Limit

Prevents DoS attacks via extremely large function strings:

```typescript
// src/validation.ts
export function validateFunctionSize(fnString: string, maxSize: number): void {
	const size = Buffer.byteLength(fnString, 'utf8')
	if (size > maxSize) {
		throw new RangeError(`Function source exceeds maximum size (${size} bytes > ${maxSize} bytes limit)`)
	}
}
```

### Prototype Pollution Protection

Blocks dangerous keys in context objects:

```typescript
// src/validation.ts
export function validateContextSecurity(context: Record<string, unknown>): void {
	const keys = Object.keys(context)
	for (const key of keys) {
		if (key === 'constructor' || key === 'prototype') {
			throw new TypeError(`Context key "${key}" is not allowed (potential prototype pollution)`)
		}
	}
}
```

### Configuration

```js
beeThreads.configure({
	security: {
		maxFunctionSize: 2 * 1024 * 1024, // 2MB (default: 1MB)
		blockPrototypePollution: false, // Disable if you know what you're doing
	},
})
```

---

## Performance Architecture

### Four-Layer Optimization

```
┌────────────────────────────────────────────────────────────────┐
│ Layer 1: vm.Script Compilation                                 │
│ • Compile once, run many times                                 │
│ • produceCachedData enables V8 code caching                    │
│ • 5-15x faster than eval() for context injection               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 2: LRU Function Cache                                    │
│ • Avoid recompilation of repeated functions                    │
│ • Cache key includes context hash                              │
│ • Bounded size prevents memory bloat                           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 3: Worker Affinity                                       │
│ • Route same function to same worker                           │
│ • Leverages V8 TurboFan optimization                           │
│ • Function hash → Worker mapping                               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ Layer 4: V8 TurboFan JIT                                       │
│ • Hot functions get compiled to machine code                   │
│ • Affinity ensures functions stay "hot" in same worker         │
│ • Combined effect: near-native performance                     │
└────────────────────────────────────────────────────────────────┘
```

### Micro-Optimizations Applied (v3.1.3)

| Category                      | Count | Examples                                        |
| ----------------------------- | ----- | ----------------------------------------------- |
| **Loop replacements**         | 24    | `for...of` → classic `for` with cached length   |
| **Array method replacements** | 12    | `.map()`, `.filter()`, `.some()` → manual loops |
| **Spread → concat**           | 6     | `[...a, ...b]` → `a.concat(b)`                  |
| **Monomorphic objects**       | 6     | Pre-declare all properties                      |
| **O(1) lookups**              | 4     | `.includes()` → direct comparison               |
| **Big O reductions**          | 2     | O(2n) → O(n)                                    |

---

## Data Flow

### Regular Function Execution

```
1. User calls bee(fn)(args)
2. index.ts: Convert fn to string, create thenable
3. execution.ts: Request worker from pool
4. pool.ts: Select best worker (affinity → idle → new → temp → queue)
5. execution.ts: Send { fn, args, context } to worker
6. worker.ts: Validate, compile (cached), execute
7. worker.ts: Send { type: SUCCESS, value } or { type: ERROR, error }
8. execution.ts: Resolve/reject promise, release worker
9. pool.ts: Return worker to pool or process queued task
```

### Generator Streaming

```
1. User calls beeThreads.stream(gen).execute()
2. stream-executor.ts: Create ReadableStream, request worker
3. generator-worker.ts: Execute generator
4. For each yield: Send { type: YIELD, value }
5. On return: Send { type: RETURN, value }, { type: END }
6. stream-executor.ts: Enqueue values to ReadableStream
7. User consumes with for-await-of
```

---

## Error Handling

### Error Preservation

Custom error properties are preserved across worker boundaries:

```js
// In worker
const err = new Error('Failed');
err.code = 'ERR_CUSTOM';
err.statusCode = 500;
throw err;

// In main thread
catch (err) {
  console.log(err.code);       // 'ERR_CUSTOM'
  console.log(err.statusCode); // 500
}
```

### Error Chain Preservation (ES2022)

```js
// Error.cause is preserved
throw new Error('High level', { cause: lowLevelError })

// AggregateError.errors are preserved
throw new AggregateError([err1, err2], 'Multiple failures')
```

---

## Memory Management

### Low Memory Mode

For memory-constrained environments (IoT, serverless):

```js
beeThreads.configure({ lowMemoryMode: true })
```

Effects:

-  Function cache size reduced to 10 (default: 100) → ~35-50% less memory
-  Validation cache disabled → ~10-20% less memory
-  Worker affinity tracking disabled → ~15-25% less memory
-  **Total reduction: ~60-80% less memory**

Trade-off: Slower repeated executions (no caching benefits).

### Resource Limits

Control V8 heap size per worker:

```js
beeThreads.configure({
	resourceLimits: {
		maxOldGenerationSizeMb: 256, // Default: 512
		maxYoungGenerationSizeMb: 64, // Default: 128
		codeRangeSizeMb: 32, // Default: 64
	},
})
```

### Request Coalescing

Disable request coalescing globally:

```js
beeThreads.configure({ coalescing: false })
```

Or disable per-execution:

```js
await beeThreads
	.run(() => sideEffectFn())
	.noCoalesce()
	.execute()
```

---

## Runtime & Bundler Compatibility

### Multi-Runtime Support

bee-threads supports multiple JavaScript runtimes:

| Runtime     | Status          | Notes                                           |
| ----------- | --------------- | ----------------------------------------------- |
| **Node.js** | ✅ Full support | v16+ recommended, uses native `worker_threads`  |
| **Bun**     | ✅ Full support | Uses Bun's `worker_threads` compatibility layer |
| **Deno**    | ⚠️ Experimental | Requires `--allow-read` flag, limited testing   |

**Runtime detection:**

```typescript
// src/config.ts
export function detectRuntime(): Runtime {
	if (typeof globalThis.Bun !== 'undefined') return 'bun'
	if (typeof globalThis.Deno !== 'undefined') return 'deno'
	return 'node'
}

export const RUNTIME = detectRuntime()
export const IS_BUN = RUNTIME === 'bun'
```

### Bundler Compatibility

bee-threads works with **all major bundlers** without any configuration:

| Bundler       | Status   | Notes            |
| ------------- | -------- | ---------------- |
| **Webpack**   | ✅ Works | No config needed |
| **Vite**      | ✅ Works | No config needed |
| **Rspack**    | ✅ Works | No config needed |
| **esbuild**   | ✅ Works | No config needed |
| **Rollup**    | ✅ Works | No config needed |
| **Turbopack** | ✅ Works | No config needed |

### How Bundler Compatibility Works

#### The Problem

Traditional `worker_threads` require external `.js` files:

```js
// ❌ This breaks with bundlers - worker.js won't be included
const worker = new Worker(path.join(__dirname, 'worker.js'))
```

Bundlers (Webpack, Vite, etc.) don't automatically include worker files in the bundle.

#### The Solution: Inline Workers

bee-threads auto-detects bundler environments and uses **inline workers** via `data:` URLs:

```typescript
// src/inline-workers.ts
export const INLINE_WORKER_CODE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
// ... complete worker code as string ...
`

export function createWorkerDataUrl(code: string): string {
	const base64 = Buffer.from(code, 'utf-8').toString('base64')
	return `data:text/javascript;base64,${base64}`
}
```

#### Auto-Detection

```typescript
// src/config.ts
function detectBundlerMode(): boolean {
	// Check 1: Worker file doesn't exist (bundled scenario)
	const workerPath = path.join(__dirname, 'worker.js')
	if (!fs.existsSync(workerPath)) return true

	// Check 2: Known bundler globals
	if (typeof __webpack_require__ !== 'undefined' || typeof __vite_ssr_import__ !== 'undefined' || typeof __rspack_require__ !== 'undefined') return true

	return false
}

export function getWorkerScript(type: PoolType): string {
	if (USE_INLINE_WORKERS) {
		const code = type === 'generator' ? INLINE_GENERATOR_WORKER_CODE : INLINE_WORKER_CODE
		return createWorkerDataUrl(code)
	}
	return path.join(__dirname, 'worker.js')
}
```

### Security Considerations

**Why `data:` URLs instead of `eval: true`?**

| Approach     | Security | CSP Compatible    | Performance |
| ------------ | -------- | ----------------- | ----------- |
| `eval: true` | ⚠️ Risky | ❌ Blocked by CSP | ✅ Fast     |
| `data:` URL  | ✅ Safe  | ✅ Works          | ✅ Fast     |

The worker code is **static** (not user input), so `data:` URLs are safe and work with Content Security Policy.

### Usage Examples

```bash
# Node.js (development)
node app.js
# Uses: worker.js files from dist/

# Bun (development)
bun run app.ts
# Uses: worker.js files from dist/

# Webpack/Vite/etc (production bundle)
npm run build && node dist/bundle.js
# Uses: inline workers (data: URLs)
```

**No configuration needed - it just works!**

---

## Contributing Guide

### Running Tests

```bash
npm test  # Builds and runs 313 tests
```

### Code Style

-  TypeScript strict mode
-  JSDoc on all public functions
-  "Why this exists" comments on modules
-  Descriptive names (no abbreviations)
-  Small, focused functions (< 50 lines preferred)
-  Centralized state in config.ts

### Performance Guidelines

1. Use classic `for` loops with cached length
2. Avoid `Array.prototype.includes()` for small sets
3. Prefer `concat()` over spread for array merging
4. Pre-declare all object properties (monomorphic shapes)
5. Use direct comparisons instead of `includes()` for 2-3 items

---

## License

MIT © [Samuel Santos](https://github.com/samsantosb)
