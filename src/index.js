/**
 * @fileoverview bee-threads - Handle threading as promises.
 * 
 * This is the main entry point for the bee-threads library.
 * It exposes the public API and re-exports error classes.
 * 
 * ## Architecture
 * 
 * The library is organized into modules:
 * - `index.js` - Public API (this file)
 * - `config.js` - Configuration and state management
 * - `pool.js` - Worker pool lifecycle
 * - `execution.js` - Task execution engine
 * - `executor.js` - Fluent API builder for sync tasks
 * - `stream-executor.js` - Fluent API builder for generators
 * - `errors.js` - Typed error classes
 * - `utils.js` - Utility functions
 * - `validation.js` - Input validation
 * - `worker.js` - Worker thread script
 * - `generator-worker.js` - Generator worker script
 * 
 * @module bee-threads
 * @license MIT
 * 
 * @example
 * // Basic usage
 * const { beeThreads } = require('bee-threads');
 * 
 * const result = await beeThreads
 *   .run((a, b) => a + b)
 *   .usingParams(1, 2)
 *   .execute();
 * // → 3
 * 
 * @example
 * // With closure injection
 * const factor = 10;
 * 
 * const result = await beeThreads
 *   .run((x) => x * factor)
 *   .usingParams(5)
 *   .setContext({ factor })
 *   .execute();
 * // → 50
 */

'use strict';

// ============================================================================
// IMPORTS
// ============================================================================

const { config, pools, poolCounters, queues, metrics } = require('./config');
const { createCurriedRunner } = require('./executor');
const { stream } = require('./stream-executor');
const { warmupPool, getQueueLength } = require('./pool');
const { validateTimeout, validatePoolSize } = require('./validation');
const { deepFreeze } = require('./utils');
const { 
  AsyncThreadError, 
  AbortError, 
  TimeoutError, 
  QueueFullError, 
  WorkerError 
} = require('./errors');

// ============================================================================
// SIMPLE CURRIED API
// ============================================================================

/**
 * Reserved option keys for the bee() function.
 * Used to detect if the last argument is an options object.
 * @type {Set<string>}
 * @internal
 */
const BEE_OPTION_KEYS = new Set([
  'context', 'timeout', 'signal', 'transfer', 'retry', 'priority', 'safe'
]);

/**
 * Checks if an object looks like a bee() options object.
 * 
 * @param {*} obj - Value to check
 * @returns {boolean} True if obj has any known option key
 * @internal
 */
function isBeeOptions(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.keys(obj).some(k => BEE_OPTION_KEYS.has(k));
}

/**
 * Simple curried API for bee-threads.
 * 
 * This provides a minimal, ergonomic interface for common use cases.
 * For advanced features, use `beeThreads` instead.
 * 
 * ## Syntax
 * 
 * ```js
 * // No arguments
 * await bee(fn)()
 * 
 * // With arguments
 * await bee(fn)(arg1, arg2)
 * 
 * // With options (last argument is options object)
 * await bee(fn)(arg1, { context: { x }, timeout: 5000 })
 * ```
 * 
 * ## Options
 * 
 * | Key | Type | Description |
 * |-----|------|-------------|
 * | `context` | object | Variables to inject into worker scope |
 * | `timeout` | number | Timeout in milliseconds |
 * | `signal` | AbortSignal | Cancellation signal |
 * | `transfer` | array | Transferable objects |
 * | `retry` | object | Retry options: `{ attempts, delay, backoff }` |
 * | `priority` | string | 'high', 'normal', or 'low' |
 * | `safe` | boolean | If true, never throws (returns result object) |
 * 
 * @param {Function} fn - The function to run in a worker thread
 * @returns {Function} A function that accepts arguments and returns a Promise
 * 
 * @example
 * // Simple - double a number
 * const result = await bee(x => x * 2)(21)
 * // → 42
 * 
 * @example
 * // With multiple arguments
 * const sum = await bee((a, b, c) => a + b + c)(1, 2, 3)
 * // → 6
 * 
 * @example
 * // With context (external variables)
 * const TAX = 0.2
 * const price = await bee(p => p * (1 + TAX))(100, { context: { TAX } })
 * // → 120
 * 
 * @example
 * // With timeout
 * const result = await bee(heavyTask)(data, { timeout: 5000 })
 * 
 * @example
 * // Safe mode - never throws
 * const result = await bee(() => JSON.parse('bad'))(undefined, { safe: true })
 * if (result.status === 'rejected') console.error(result.error)
 * 
 * @example
 * // Hash password (real-world example)
 * const hash = await bee((pwd) => {
 *   const crypto = require('crypto')
 *   return crypto.pbkdf2Sync(pwd, 'salt', 100000, 64, 'sha512').toString('hex')
 * })('user-password')
 */
function bee(fn) {
  // Validate function upfront
  if (typeof fn !== 'function') {
    throw new TypeError(`bee() requires a function, got ${typeof fn}`);
  }
  
  const fnString = fn.toString();
  
  /**
   * Returns a function that executes the task with the given arguments.
   * 
   * @param {...*} callArgs - Arguments to pass to the function
   * @returns {Promise<*>} Resolves with the function result
   */
  return function(...callArgs) {
    // Detect if last argument is options
    const lastArg = callArgs[callArgs.length - 1];
    const hasOptions = callArgs.length > 0 && isBeeOptions(lastArg);
    
    let args, opts;
    if (hasOptions) {
      args = callArgs.slice(0, -1);
      opts = lastArg;
    } else {
      args = callArgs;
      opts = {};
    }
    
    // Build options for execute()
    const executeOptions = {
      context: opts.context,
      timeout: opts.timeout,
      signal: opts.signal,
      transfer: opts.transfer,
      retry: opts.retry,
      priority: opts.priority,
      safe: opts.safe || false
    };
    
    // Use the executor internally
    const { execute } = require('./execution');
    return execute(fnString, args, executeOptions);
  };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * The main bee-threads API object.
 * 
 * Provides methods for running JavaScript code in worker threads
 * with a fluent, chainable API.
 * 
 * @namespace beeThreads
 * @type {Object}
 * 
 * @property {Function} run - Runs a function in a worker thread
 * @property {Function} safeRun - Runs a function in safe mode (never throws)
 * @property {Function} withTimeout - Creates a runner with timeout
 * @property {Function} safeWithTimeout - Creates a safe runner with timeout
 * @property {Function} stream - Streams values from a generator
 * @property {Function} configure - Configures pool settings
 * @property {Function} shutdown - Shuts down all workers
 * @property {Function} getPoolStats - Returns pool statistics
 * 
 * @example
 * const { beeThreads } = require('bee-threads');
 * 
 * // CPU-intensive work doesn't block the main thread
 * const hash = await beeThreads
 *   .run((data) => {
 *     const crypto = require('crypto');
 *     return crypto.createHash('sha256').update(data).digest('hex');
 *   })
 *   .usingParams('hello world')
 *   .execute();
 */
const beeThreads = {
  // ──────────────────────────────────────────────────────────────────────────
  // EXECUTION METHODS
  // ──────────────────────────────────────────────────────────────────────────
  
  /**
   * Creates an executor for running a function in a worker thread.
   * 
   * Returns an executor object with chainable methods for configuration.
   * The function is serialized and sent to a worker thread for execution.
   * 
   * **Important**: The function cannot access variables from its outer scope
   * (closures). Use `.setContext()` to inject external variables.
   * 
   * @function run
   * @memberof beeThreads
   * @param {Function} fn - The function to execute in the worker
   * @returns {Executor} A chainable executor object
   * @throws {TypeError} If fn is not a function
   * 
   * @example
   * // Simple computation
   * const result = await beeThreads
   *   .run((a, b) => a + b)
   *   .usingParams(10, 20)
   *   .execute();
   * // → 30
   * 
   * @example
   * // With external variables (closure injection)
   * const TAX_RATE = 0.2;
   * const result = await beeThreads
   *   .run((price) => price * (1 + TAX_RATE))
   *   .usingParams(100)
   *   .setContext({ TAX_RATE })
   *   .execute();
   * // → 120
   * 
   * @example
   * // Curried functions work automatically
   * const result = await beeThreads
   *   .run((a) => (b) => (c) => a + b + c)
   *   .usingParams(1, 2, 3)
   *   .execute();
   * // → 6
   * 
   * @example
   * // With cancellation support
   * const controller = new AbortController();
   * setTimeout(() => controller.abort(), 1000);
   * 
   * const result = await beeThreads
   *   .run(heavyComputation)
   *   .usingParams(data)
   *   .signal(controller.signal)
   *   .execute();
   */
  run: createCurriedRunner({ safe: false }),
  
  /**
   * Creates a safe executor that never throws exceptions.
   * 
   * Instead of throwing, returns a result object with:
   * - `{ status: 'fulfilled', value: T }` on success
   * - `{ status: 'rejected', error: Error }` on failure
   * 
   * Useful for fire-and-forget operations or when you want to handle
   * errors without try/catch.
   * 
   * @function safeRun
   * @memberof beeThreads
   * @param {Function} fn - The function to execute
   * @returns {SafeExecutor} A chainable executor that never throws
   * @throws {TypeError} If fn is not a function
   * 
   * @example
   * const result = await beeThreads
   *   .safeRun(() => JSON.parse(invalidJson))
   *   .usingParams()
   *   .execute();
   * 
   * if (result.status === 'rejected') {
   *   console.error('Parse failed:', result.error.message);
   * } else {
   *   console.log('Parsed:', result.value);
   * }
   * 
   * @example
   * // Fire and forget with error logging
   * beeThreads
   *   .safeRun(sendAnalytics)
   *   .usingParams(eventData)
   *   .execute()
   *   .then(r => r.status === 'rejected' && console.error(r.error));
   */
  safeRun: createCurriedRunner({ safe: true }),

  /**
   * Creates an executor with a timeout limit.
   * 
   * If the function doesn't complete within the specified time,
   * the worker is terminated and a TimeoutError is thrown.
   * 
   * @function withTimeout
   * @memberof beeThreads
   * @param {number} ms - Timeout in milliseconds (must be positive finite number)
   * @returns {Function} A runner function that creates executors with timeout
   * @throws {TypeError} If ms is not a positive finite number
   * 
   * @example
   * try {
   *   const result = await beeThreads
   *     .withTimeout(5000)(complexCalculation)
   *     .usingParams(largeDataset)
   *     .execute();
   * } catch (err) {
   *   if (err instanceof TimeoutError) {
   *     console.log(`Timed out after ${err.timeout}ms`);
   *   }
   * }
   */
  withTimeout(ms) {
    validateTimeout(ms);
    return createCurriedRunner({ safe: false, timeout: ms });
  },

  /**
   * Creates a safe executor with timeout (never throws).
   * 
   * Combines the behavior of `safeRun` and `withTimeout`.
   * Returns a result object instead of throwing on timeout.
   * 
   * @function safeWithTimeout
   * @memberof beeThreads
   * @param {number} ms - Timeout in milliseconds
   * @returns {Function} A runner function for safe executors with timeout
   * @throws {TypeError} If ms is not a positive finite number
   * 
   * @example
   * const result = await beeThreads
   *   .safeWithTimeout(1000)(slowOperation)
   *   .usingParams()
   *   .execute();
   * 
   * if (result.status === 'rejected' && result.error instanceof TimeoutError) {
   *   console.log('Operation timed out, using fallback');
   *   return fallbackValue;
   * }
   */
  safeWithTimeout(ms) {
    validateTimeout(ms);
    return createCurriedRunner({ safe: true, timeout: ms });
  },

  /**
   * Creates a stream executor for generator functions.
   * 
   * Each `yield` in the generator produces a value in the stream.
   * Returns a standard `ReadableStream` that can be consumed with
   * `for await...of` or the streams API.
   * 
   * @function stream
   * @memberof beeThreads
   * @param {GeneratorFunction} genFn - A generator function
   * @returns {StreamExecutor} A chainable stream executor
   * @throws {TypeError} If genFn is not a function
   * 
   * @example
   * // Basic streaming
   * const stream = beeThreads
   *   .stream(function* (n) {
   *     for (let i = 0; i < n; i++) {
   *       yield i * i;
   *     }
   *   })
   *   .usingParams(5)
   *   .execute();
   * 
   * for await (const square of stream) {
   *   console.log(square); // 0, 1, 4, 9, 16
   * }
   * 
   * @example
   * // With closure injection
   * const multiplier = 10;
   * const stream = beeThreads
   *   .stream(function* (start, count) {
   *     for (let i = 0; i < count; i++) {
   *       yield (start + i) * multiplier;
   *     }
   *   })
   *   .usingParams(1, 3)
   *   .setContext({ multiplier })
   *   .execute();
   * // Yields: 10, 20, 30
   * 
   * @example
   * // Accessing return value
   * const stream = beeThreads
   *   .stream(function* () {
   *     yield 1;
   *     yield 2;
   *     return 'done';
   *   })
   *   .usingParams()
   *   .execute();
   * 
   * for await (const v of stream) { }
   * console.log(stream.returnValue); // 'done'
   */
  stream,

  // ──────────────────────────────────────────────────────────────────────────
  // CONFIGURATION
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Configures the worker pool settings.
   * 
   * Changes take effect for new workers. Existing workers are not affected.
   * Call `shutdown()` first if you need to apply changes to all workers.
   * 
   * @function configure
   * @memberof beeThreads
   * @param {Object} options - Configuration options
   * @param {number} [options.poolSize] - Maximum workers per pool (default: CPU cores - 1)
   * @param {number} [options.maxQueueSize] - Maximum pending tasks (default: 1000)
   * @param {number} [options.maxTemporaryWorkers] - Overflow workers when pool is full (default: 10)
   * @param {number} [options.workerIdleTimeout] - MS before idle worker termination (default: 30000)
   * @param {Object} [options.resourceLimits] - V8 memory limits for workers
   * @param {number} [options.resourceLimits.maxOldGenerationSizeMb] - Max old gen heap (default: 512)
   * @param {number} [options.resourceLimits.maxYoungGenerationSizeMb] - Max young gen heap (default: 128)
   * @param {Object} [options.retry] - Default retry configuration
   * @param {number} [options.retry.maxAttempts] - Max retry attempts (default: 3)
   * @param {number} [options.retry.baseDelay] - Initial delay in ms (default: 100)
   * @param {number} [options.retry.maxDelay] - Max delay cap in ms (default: 5000)
   * @param {number} [options.retry.backoffFactor] - Exponential factor (default: 2)
   * @throws {TypeError} If any option has an invalid value
   * 
   * @example
   * // High-throughput configuration
   * beeThreads.configure({
   *   poolSize: 16,
   *   maxQueueSize: 5000,
   *   maxTemporaryWorkers: 20,
   *   workerIdleTimeout: 60000
   * });
   * 
   * @example
   * // Memory-constrained environment
   * beeThreads.configure({
   *   poolSize: 2,
   *   resourceLimits: {
   *     maxOldGenerationSizeMb: 128,
   *     maxYoungGenerationSizeMb: 32
   *   }
   * });
   * 
   * @example
   * // Enable retry by default
   * beeThreads.configure({
   *   retry: {
   *     maxAttempts: 5,
   *     baseDelay: 200,
   *     backoffFactor: 3
   *   }
   * });
   */
  configure(options = {}) {
    if (options.poolSize !== undefined) {
      validatePoolSize(options.poolSize);
      config.poolSize = options.poolSize;
    }
    if (options.minThreads !== undefined) {
      if (!Number.isInteger(options.minThreads) || options.minThreads < 0) {
        throw new TypeError('minThreads must be a non-negative integer');
      }
      if (options.minThreads > config.poolSize) {
        throw new TypeError('minThreads cannot exceed poolSize');
      }
      config.minThreads = options.minThreads;
    }
    if (options.maxQueueSize !== undefined) {
      if (typeof options.maxQueueSize !== 'number' || options.maxQueueSize < 0) {
        throw new TypeError('maxQueueSize must be a non-negative number');
      }
      config.maxQueueSize = options.maxQueueSize;
    }
    if (options.maxTemporaryWorkers !== undefined) {
      if (typeof options.maxTemporaryWorkers !== 'number' || options.maxTemporaryWorkers < 0) {
        throw new TypeError('maxTemporaryWorkers must be a non-negative number');
      }
      config.maxTemporaryWorkers = options.maxTemporaryWorkers;
    }
    if (options.workerIdleTimeout !== undefined) {
      if (typeof options.workerIdleTimeout !== 'number' || options.workerIdleTimeout < 0) {
        throw new TypeError('workerIdleTimeout must be a non-negative number');
      }
      config.workerIdleTimeout = options.workerIdleTimeout;
    }
    if (options.resourceLimits !== undefined) {
      config.resourceLimits = options.resourceLimits;
    }
    if (options.retry !== undefined) {
      config.retry = { ...config.retry, ...options.retry };
    }
  },

  // ──────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Pre-creates workers to eliminate cold-start latency.
   * 
   * Call this at application startup to have workers ready before
   * the first task arrives. Workers will be created up to the
   * specified count or poolSize (whichever is smaller).
   * 
   * @function warmup
   * @memberof beeThreads
   * @param {number} [count=minThreads] - Number of workers to pre-create
   * @returns {Promise<void>} Resolves when workers are ready
   * 
   * @example
   * // At application startup
   * await beeThreads.warmup(4);
   * // Now tasks execute immediately without worker creation delay
   * 
   * @example
   * // Warmup based on minThreads config
   * beeThreads.configure({ minThreads: 2 });
   * await beeThreads.warmup(); // Creates 2 workers
   */
  async warmup(count) {
    const targetCount = count ?? config.minThreads;
    if (targetCount <= 0) return;
    
    await Promise.all([
      warmupPool('normal', targetCount),
      warmupPool('generator', targetCount)
    ]);
  },

  /**
   * Gracefully shuts down all worker pools.
   * 
   * - Rejects all pending queued tasks with an error
   * - Terminates all active workers
   * - Resets pool state
   * 
   * Call this before process exit to ensure clean shutdown.
   * Workers can be recreated automatically on next task.
   * 
   * @function shutdown
   * @memberof beeThreads
   * @returns {Promise<void>} Resolves when all workers are terminated
   * 
   * @example
   * // Clean shutdown on SIGTERM
   * process.on('SIGTERM', async () => {
   *   console.log('Shutting down...');
   *   await beeThreads.shutdown();
   *   process.exit(0);
   * });
   * 
   * @example
   * // Reset pool between tests
   * afterEach(async () => {
   *   await beeThreads.shutdown();
   * });
   */
  async shutdown() {
    // Reject all queued tasks
    for (const poolType of Object.keys(queues)) {
      const queue = queues[poolType];
      while (queue.length > 0) {
        queue.shift().reject(new AsyncThreadError('Pool shutting down', 'ERR_SHUTDOWN'));
      }
    }

    // Collect and clear pools
    const allWorkers = [...pools.normal, ...pools.generator];
    pools.normal = [];
    pools.generator = [];
    poolCounters.normal = { busy: 0, idle: 0 };
    poolCounters.generator = { busy: 0, idle: 0 };
    
    // Terminate all workers
    await Promise.all(allWorkers.map(entry => {
      clearTimeout(entry.idleTimer);
      return entry.worker.terminate();
    }));

    metrics.activeTemporaryWorkers = 0;
  },

  // ──────────────────────────────────────────────────────────────────────────
  // MONITORING
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Returns current pool statistics and metrics.
   * 
   * The returned object is deeply frozen to prevent accidental mutation.
   * Use this for monitoring, debugging, and auto-scaling decisions.
   * 
   * @function getPoolStats
   * @memberof beeThreads
   * @returns {Readonly<PoolStats>} Immutable pool statistics
   * 
   * @example
   * const stats = beeThreads.getPoolStats();
   * 
   * console.log('Pool status:');
   * console.log(`  Normal workers: ${stats.normal.busy} busy, ${stats.normal.idle} idle`);
   * console.log(`  Queue length: ${stats.normal.queueLength}`);
   * console.log(`  Total tasks: ${stats.metrics.totalTasksExecuted}`);
   * console.log(`  Failed tasks: ${stats.metrics.totalTasksFailed}`);
   * 
   * @example
   * // Auto-scaling based on queue length
   * const stats = beeThreads.getPoolStats();
   * if (stats.normal.queueLength > 100) {
   *   beeThreads.configure({ poolSize: stats.maxSize + 2 });
   * }
   * 
   * @example
   * // Health check endpoint
   * app.get('/health', (req, res) => {
   *   const stats = beeThreads.getPoolStats();
   *   res.json({
   *     healthy: stats.normal.queueLength < 500,
   *     workers: stats.normal.size,
   *     pending: stats.normal.queueLength
   *   });
   * });
   */
  getPoolStats() {
    const normalPool = pools.normal;
    const generatorPool = pools.generator;
    
    return deepFreeze({
      maxSize: config.poolSize,
      
      normal: {
        size: normalPool.length,
        busy: poolCounters.normal.busy,
        idle: poolCounters.normal.idle,
        queueLength: getQueueLength(queues.normal),
        queueByPriority: {
          high: queues.normal.high.length,
          normal: queues.normal.normal.length,
          low: queues.normal.low.length
        },
        workers: normalPool.map(e => ({
          busy: e.busy,
          tasksExecuted: e.tasksExecuted,
          failureCount: e.failureCount,
          avgExecutionTime: e.tasksExecuted > 0 
            ? Math.round(e.totalExecutionTime / e.tasksExecuted) 
            : 0,
          uptime: Date.now() - e.createdAt
        }))
      },
      
      generator: {
        size: generatorPool.length,
        busy: poolCounters.generator.busy,
        idle: poolCounters.generator.idle,
        queueLength: getQueueLength(queues.generator),
        queueByPriority: {
          high: queues.generator.high.length,
          normal: queues.generator.normal.length,
          low: queues.generator.low.length
        },
        workers: generatorPool.map(e => ({
          busy: e.busy,
          tasksExecuted: e.tasksExecuted,
          failureCount: e.failureCount,
          avgExecutionTime: e.tasksExecuted > 0 
            ? Math.round(e.totalExecutionTime / e.tasksExecuted) 
            : 0,
          uptime: Date.now() - e.createdAt
        }))
      },
      
      metrics: {
        totalTasksExecuted: metrics.totalTasksExecuted,
        totalTasksFailed: metrics.totalTasksFailed,
        totalRetries: metrics.totalRetries,
        temporaryWorkersCreated: metrics.temporaryWorkersCreated,
        activeTemporaryWorkers: metrics.activeTemporaryWorkers,
        temporaryWorkerTasks: metrics.temporaryWorkerTasks,
        avgTemporaryWorkerTime: metrics.temporaryWorkerTasks > 0
          ? Math.round(metrics.temporaryWorkerExecutionTime / metrics.temporaryWorkerTasks) 
          : 0
      },
      
      config: { ...config }
    });
  }
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = { 
  bee,
  beeThreads,
  AbortError, 
  TimeoutError, 
  QueueFullError, 
  WorkerError,
  AsyncThreadError 
};
