# bee-threads - Internal Documentation

> For contributors and developers who want to understand/modify the code.

---

## What Each File Does

### `src/index.js` - Public API

**What it does:** Library entry point. Exports `beeThreads` and error classes.

**Why it exists:** Single file users should import. Hides all internal complexity.

```js
// Users only need to know this:
const { beeThreads, TimeoutError } = require('bee-threads');
```

**Responsibilities:**
- Expose `beeThreads.run()`, `safeRun()`, `withTimeout()`, `stream()`
- Expose `beeThreads.all()`, `allSettled()` for parallel execution
- Expose `configure()`, `shutdown()`, `getPoolStats()`, `warmup()`
- Re-export error classes

---

### `src/config.js` - State Management

**What it does:** Centralizes ALL configuration and mutable state.

**Why it exists:** Having a single place to view/reset state makes debugging and testing easier.

**State it maintains:**
```js
config        // User settings (poolSize, timeout, etc)
pools         // Active workers { normal: [], generator: [] }
poolCounters  // O(1) counters { busy: n, idle: n }
queues        // Tasks waiting for worker
metrics       // Execution statistics
```

**Why poolCounters exists:**
Avoids iterating the worker array just to count how many are busy. `getWorker()` checks `counters.idle > 0` in O(1).

---

### `src/pool.js` - Worker Pool

**What it does:** Manages worker lifecycle.

**Why it exists:** Separate pool logic from execution logic.

**Main functions:**

| Function | What it does |
|----------|--------------|
| `createWorkerEntry()` | Creates worker with metadata (tasksExecuted, failureCount, functionHashes, etc) |
| `getWorker(poolType, fnHash)` | Gets available worker using affinity-aware balancing |
| `releaseWorker()` | Returns worker to pool, tracks function hash for affinity |
| `requestWorker()` | Async wrapper - returns worker or queues task |
| `scheduleIdleTimeout()` | Schedules terminating idle worker after X ms |
| `fastHash(str)` | Creates djb2 hash for function affinity tracking |

**Selection strategy (getWorker):**
```
1. Has idle worker with affinity match? → Pick it (V8 hot path!)
2. Has other idle worker? → Pick the one with fewest tasks executed
3. Pool not full? → Create new worker
4. Can create temporary? → Create (will be terminated after use)
5. Otherwise → Queue task
```

**Why least-used:**
Distributes load evenly. Avoids scenario where 1 worker does everything while others sit idle.

---

### `src/execution.js` - Task Engine

**What it does:** Executes tasks on workers.

**Why it exists:** Separate worker communication from pool/API logic.

**Functions:**

| Function | What it does |
|----------|--------------|
| `executeOnce()` | Executes once (no retry) |
| `execute()` | Executes with retry if configured |

**executeOnce flow:**
```
1. Check if AbortSignal already aborted
2. Request worker via requestWorker()
3. Setup listeners (message, error, exit)
4. Setup timeout if any
5. Setup abort handler if any
6. Send task: worker.postMessage({ fn, args, context })
7. Wait for response
8. Cleanup (remove listeners, release worker)
9. Resolve/reject promise
```

**Why retry is separate:**
`execute()` is a wrapper that calls `executeOnce()` in a loop with backoff.

---

### `src/executor.js` - Fluent API Builder

**What it does:** Builds the chainable API that users use.

**Why it exists:** Separate user interface from implementation.

**Pattern used:** Immutable builder

```js
// Each method returns NEW executor (doesn't mutate)
const exec1 = beeThreads.run(fn);
const exec2 = exec1.usingParams(1);  // exec1 unchanged
const exec3 = exec2.setContext({});  // exec2 unchanged
```

**Why immutable:**
Allows reusing partially configured executors:
```js
const base = beeThreads.run(fn).setContext({ API_KEY });
await base.usingParams(1).execute();
await base.usingParams(2).execute(); // Reuses config
```

---

### `src/stream-executor.js` - Generator Streaming

**What it does:** Same as executor.js, but for generators.

**Why separate:** Generators have different protocol (yield/end instead of ok/error).

**Output:** Standard Node/Browser `ReadableStream`.

---

### `src/errors.js` - Error Classes

**What it does:** Defines typed error classes.

**Why it exists:** Allows `instanceof` checks and consistent error codes.

```js
class TimeoutError extends AsyncThreadError {
  constructor(ms) {
    super(`Worker timed out after ${ms}ms`, 'ERR_TIMEOUT');
    this.timeout = ms;  // Useful extra info
  }
}
```

**Defined errors:**

| Class | Code | When |
|-------|------|------|
| `AbortError` | `ERR_ABORTED` | Task cancelled via AbortSignal |
| `TimeoutError` | `ERR_TIMEOUT` | Exceeded time limit |
| `QueueFullError` | `ERR_QUEUE_FULL` | Task queue full |
| `WorkerError` | `ERR_WORKER` | Error inside worker |

---

### `src/cache.js` - LRU Cache & Function Cache

**What it does:** Caches compiled functions to avoid repeated eval() calls.

**Why it exists:** Performance optimization. eval() is expensive (~0.3-0.5ms). Cache lookup is ~0.001ms.

**Components:**

| Export | What it does |
|--------|--------------|
| `createLRUCache(maxSize)` | Generic LRU cache using Map |
| `createFunctionCache(maxSize)` | Specialized cache for compiled functions |
| `createContextKey(context)` | Fast hash for context objects (replaces JSON.stringify) |

**Why LRU:**
Most recently used functions stay cached. Least used get evicted when cache is full. Optimal for repeated function calls.

**Context Key Optimization:**
Instead of slow `JSON.stringify(context)`, uses fast djb2 hash algorithm with type markers:
```js
// Old: JSON.stringify({ TAX: 0.2, name: "test" }) → '{"TAX":0.2,"name":"test"}'
// New: createContextKey({ TAX: 0.2, name: "test" }) → 'TAX:number:0.2|name:string:test'
```

---

### `src/worker.js` - Worker Script

**What it does:** Code that runs in the worker thread.

**Why separate:** Worker is isolated process, needs its own file.

**Flow:**
```
1. Receive: { fn: string, args: [], context: {} }
2. Validate that fn looks like a function (cached validation)
3. Get compiled function from cache (or compile + cache)
4. If has context → inject variables into scope
5. Apply args (supports curried automatically)
6. If return is Promise → wait
7. Send: { ok: true, value } or { ok: false, error }
```

**Validation Caching:**
Function source validation results are cached in a Set. Once a function is validated, subsequent calls skip regex matching entirely.

**applyCurried() - Why it exists:**
```js
// Normal function: fn(1, 2, 3)
// Curried: fn(1)(2)(3)
// We want both to work with usingParams(1, 2, 3)
```

**Console forwarding:**
All `console.log/warn/error/info/debug` calls are intercepted and sent to main thread via `postMessage`. They appear prefixed with `[worker]`.

---

### `src/generator-worker.js` - Generator Worker

**What it does:** Specialized worker for generators.

**Why separate:** Different protocol - sends multiple messages (one per yield).

**Messages sent:**
```js
{ type: 'yield', value }  // Each yield
{ type: 'return', value } // Final return value
{ type: 'end' }           // Generator finished
{ type: 'error', error }  // Error occurred
{ type: 'log', level, args } // Console output
```

---

### `src/validation.js` - Input Validation

**What it does:** Input validation functions.

**Why separate:** DRY - same validations used in multiple places.

```js
validateFunction(fn)   // Check if is function
validateTimeout(ms)    // Check if positive finite number
validatePoolSize(n)    // Check if integer >= 1
```

---

### `src/utils.js` - Utilities

**What it does:** Generic utility functions.

**Why separate:** Reusable and testable in isolation.

```js
deepFreeze(obj)      // Recursively freeze object (for getPoolStats)
sleep(ms)            // Promise that resolves after X ms
calculateBackoff()   // Calculate exponential delay with jitter
```

**Why jitter in backoff:**
Avoids thundering herd - if 100 tasks fail together, we don't want them all retrying at the same time.

---

### `src/index.d.ts` - TypeScript Types

**What it does:** Type definitions for TypeScript.

**Why it exists:** Autocomplete and type checking for TS users.

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                         User Code                           │
│  beeThreads.run(fn).usingParams(1).setContext({}).execute() │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     executor.js                             │
│  Builds execution config: { fn, args, context, signal }     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    execution.js                             │
│  1. Request worker from pool                                │
│  2. Setup timeout/abort handlers                            │
│  3. Send task to worker                                     │
│  4. Wait for response                                       │
│  5. Cleanup and return result                               │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
┌─────────────────────────┐   ┌─────────────────────────┐
│       pool.js           │   │       worker.js         │
│  - Get/create worker    │   │  - Receive task         │
│  - Track metrics        │   │  - Inject context       │
│  - Queue if busy        │   │  - Execute function     │
│  - Release after use    │   │  - Send result          │
└─────────────────────────┘   └─────────────────────────┘
```

---

## Technical Decisions

### Why `eval()` instead of `new Function()`?
`eval()` allows injecting context variables into the function's lexical scope. With `new Function()`, we'd need to pass context as parameters, making the API more complex.

### Why `worker.unref()`?
Workers don't block process exit. When your script finishes, Node.js terminates naturally without needing to call `shutdown()`.

### Why separate pools for normal/generator?
Different message protocols. Normal workers send one response. Generator workers send multiple (one per yield). Mixing them would complicate the code.

### Why immutable executor pattern?
Allows reusing partially configured executors. Each `.usingParams()` or `.setContext()` returns a new executor, so the original can be reused with different params.

### Why least-used load balancing?
Simple and effective. Always picks the worker with fewest executed tasks. Prevents one worker from being overloaded while others sit idle.

### Why worker affinity?
V8's TurboFan JIT compiler optimizes "hot" functions after several calls. By routing the same function to the same worker:
1. Function is already compiled and cached (no eval)
2. V8 has optimized machine code ready
3. Better CPU cache locality

The pool tracks function hashes per worker via `functionHashes` Set. When selecting a worker, it first looks for one that already executed this function.

---

## Performance Optimizations

### 1. Function Caching (cache.js)
- LRU cache stores compiled functions
- Avoids repeated eval() calls (~0.3-0.5ms → ~0.001ms)
- V8 retains TurboFan optimizations on cached functions

### 2. Worker Affinity (pool.js)
- Tracks which functions each worker has executed
- Routes same function to same worker when possible
- Leverages V8 JIT compilation across calls

### 3. Validation Caching (worker.js)
- Pre-compiled regex patterns (not created on each call)
- Validated sources cached in Set
- Skip validation for known-good functions

### 4. Context Hash (cache.js)
- Fast djb2 hash instead of JSON.stringify
- ~10x faster for typical context objects
- Type-aware key generation

### Metrics

```js
const stats = beeThreads.getPoolStats();

// Affinity metrics
stats.metrics.affinityHits      // Times worker had function cached
stats.metrics.affinityMisses    // Times no affinity match found
stats.metrics.affinityHitRate   // Hit rate percentage (e.g. "75.3%")

// Per-worker cache info
stats.normal.workers[0].cachedFunctions  // Functions cached in this worker
```

---

## Adding a New Feature

### Example: Adding `.timeout()` method to executor

1. **Update executor.js:**
```js
executor.timeout = function(ms) {
  return createExecutor({
    fnString,
    options: { ...options, timeout: ms },
    args
  });
};
```

2. **Update index.d.ts** (types)

3. **Add test in test.js**

4. **Update README if user-facing**

---

## Running Tests

```bash
npm test
# or
node test.js
```

Current coverage: **162 tests**

---

## Code Style

- JSDoc on all public functions
- "Why this exists" comments on modules
- Descriptive names (don't abbreviate)
- Small, focused functions
- Centralized state in config.js

---

## License

MIT
