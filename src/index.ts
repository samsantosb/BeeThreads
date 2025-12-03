/**
 * @fileoverview bee-threads - Handle threading as promises.
 *
 * This is the main entry point for the bee-threads library.
 * It exposes the public API and re-exports error classes.
 *
 * @module bee-threads
 * @license MIT
 */

// ============================================================================
// IMPORTS
// ============================================================================

import { config, pools, poolCounters, queues, metrics } from './config';
import { createCurriedRunner, Executor } from './executor';
import { stream, StreamExecutor } from './stream-executor';
import { warmupPool, getQueueLength } from './pool';
import { validateTimeout, validatePoolSize } from './validation';
import { deepFreeze } from './utils';
import {
  AsyncThreadError,
  AbortError,
  TimeoutError,
  QueueFullError,
  WorkerError
} from './errors';
import { execute } from './execution';
import { noopLogger } from './types';
import type { ConfigureOptions, FullPoolStats, PoolType, Priority, Logger } from './types';

// ============================================================================
// SIMPLE CURRIED API
// ============================================================================

interface BeeClosuresArg {
  beeClosures: Record<string, unknown>;
}

/**
 * Checks if an object contains beeClosures key.
 */
function hasBeeClosures(obj: unknown): obj is BeeClosuresArg {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj) && 'beeClosures' in obj;
}

/**
 * Curried function type with thenable support
 */
interface CurriedFunction<T> {
  (...args: unknown[]): CurriedFunction<T> | Promise<T>;
  then: <TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ) => Promise<TResult1 | TResult2>;
  catch: <TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ) => Promise<T | TResult>;
  finally: (onfinally?: (() => void) | null) => Promise<T>;
}

/**
 * Simple curried API for bee-threads.
 *
 * Minimal syntax for running functions in worker threads.
 * For advanced features (timeout, retry, priority, signal), use `beeThreads`.
 *
 * @example
 * // Simple - double a number
 * const result = await bee(x => x * 2)(21)
 * // → 42
 *
 * @example
 * // With closures
 * const TAX = 0.2
 * const price = await bee(p => p * (1 + TAX))(100)({ beeClosures: { TAX } })
 * // → 120
 */
export function bee<T = unknown>(fn: Function): CurriedFunction<T> {
  if (typeof fn !== 'function') {
    throw new TypeError(`bee() requires a function, got ${typeof fn}`);
  }

  const fnString = fn.toString();

  function createCurry(accumulatedArgs: unknown[]): CurriedFunction<T> {
    const curry = function (...callArgs: unknown[]): CurriedFunction<T> | Promise<T> {
      // Check if any argument has beeClosures
      const closuresArg = callArgs.find(hasBeeClosures);

      if (closuresArg) {
        // Found beeClosures - execute with context
        const paramsFromThisCall = callArgs.filter(a => !hasBeeClosures(a));
        const allArgs = [...accumulatedArgs, ...paramsFromThisCall];
        return execute<T>(fnString, allArgs, { context: closuresArg.beeClosures }) as Promise<T>;
      }

      if (callArgs.length === 0) {
        // Empty call () - execute with accumulated args
        return execute<T>(fnString, accumulatedArgs, {}) as Promise<T>;
      }

      // Accumulate args and return new curry (thenable for await)
      const nextCurry = createCurry([...accumulatedArgs, ...callArgs]);

      return nextCurry;
    } as CurriedFunction<T>;

    // Make thenable so `await bee(fn)(args)` works without extra ()
    curry.then = <TResult1 = T, TResult2 = never>(
      onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
      onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> => {
      return (execute<T>(fnString, accumulatedArgs, {}) as Promise<T>).then(onFulfilled, onRejected);
    };

    curry.catch = <TResult = never>(
      onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
    ): Promise<T | TResult> => {
      return (execute<T>(fnString, accumulatedArgs, {}) as Promise<T>).catch(onRejected);
    };

    curry.finally = (onFinally?: (() => void) | null): Promise<T> => {
      return (execute<T>(fnString, accumulatedArgs, {}) as Promise<T>).finally(onFinally);
    };

    return curry;
  }

  return createCurry([]);
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * The main bee-threads API object.
 */
export const beeThreads = {
  /**
   * Creates an executor for running a function in a worker thread.
   */
  run: createCurriedRunner({ safe: false }),

  /**
   * Creates an executor with a timeout limit.
   */
  withTimeout(ms: number): (fn: Function) => Executor {
    validateTimeout(ms);
    return createCurriedRunner({ safe: false, timeout: ms });
  },

  /**
   * Creates a stream executor for generator functions.
   */
  stream,

  /**
   * Configures the worker pool settings.
   */
  configure(options: ConfigureOptions = {}): void {
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
    if (options.functionCacheSize !== undefined) {
      if (!Number.isInteger(options.functionCacheSize) || options.functionCacheSize < 1) {
        throw new TypeError('functionCacheSize must be a positive integer');
      }
      config.functionCacheSize = options.functionCacheSize;
    }
    if (options.lowMemoryMode !== undefined) {
      if (typeof options.lowMemoryMode !== 'boolean') {
        throw new TypeError('lowMemoryMode must be a boolean');
      }
      config.lowMemoryMode = options.lowMemoryMode;
    }
    if (options.debugMode !== undefined) {
      if (typeof options.debugMode !== 'boolean') {
        throw new TypeError('debugMode must be a boolean');
      }
      config.debugMode = options.debugMode;
    }
    if (options.logger !== undefined) {
      // null = disable logging, otherwise must have log methods
      if (options.logger !== null) {
        if (typeof options.logger !== 'object' || typeof options.logger.log !== 'function') {
          throw new TypeError('logger must be an object with log/warn/error/info/debug methods, or null to disable');
        }
      }
      config.logger = options.logger;
    }
  },

  /**
   * Pre-creates workers to eliminate cold-start latency.
   */
  async warmup(count?: number): Promise<void> {
    const targetCount = count ?? config.minThreads;
    if (targetCount <= 0) return;

    await Promise.all([
      warmupPool('normal', targetCount),
      warmupPool('generator', targetCount)
    ]);
  },

  /**
   * Gracefully shuts down all worker pools.
   */
  async shutdown(): Promise<void> {
    // Reject all queued tasks
    for (const poolType of Object.keys(queues) as PoolType[]) {
      const queue = queues[poolType];
      for (const priority of ['high', 'normal', 'low'] as const) {
        while (queue[priority].length > 0) {
          const task = queue[priority].shift();
          if (task) {
            task.reject(new AsyncThreadError('Pool shutting down', 'ERR_SHUTDOWN'));
          }
        }
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
      if (entry.terminationTimer) {
        clearTimeout(entry.terminationTimer);
      }
      return entry.worker.terminate();
    }));

    metrics.activeTemporaryWorkers = 0;
  },

  /**
   * Symbol.dispose for automatic cleanup with `using` keyword (ES2024).
   * @example
   * {
   *   using pool = beeThreads;
   *   await pool.run(() => 42).execute();
   * } // auto-shutdown here
   */
  [Symbol.dispose](): void {
    // Fire-and-forget shutdown
    this.shutdown().catch(() => {});
  },

  /**
   * Symbol.asyncDispose for async cleanup with `await using` keyword.
   * @example
   * {
   *   await using pool = beeThreads;
   *   await pool.run(() => 42).execute();
   * } // awaits shutdown here
   */
  [Symbol.asyncDispose](): Promise<void> {
    return this.shutdown();
  },

  /**
   * Returns current pool statistics and metrics.
   */
  getPoolStats(): Readonly<FullPoolStats> {
    const normalPool = pools.normal;
    const generatorPool = pools.generator;

    return deepFreeze({
      maxSize: config.poolSize,

      normal: {
        size: normalPool.length,
        busy: poolCounters.normal.busy,
        idle: poolCounters.normal.idle,
        queued: getQueueLength(queues.normal),
        queueByPriority: {
          high: queues.normal.high.length,
          normal: queues.normal.normal.length,
          low: queues.normal.low.length
        },
        workers: normalPool.map(e => ({
          id: e.id,
          busy: e.busy,
          tasksExecuted: e.tasksExecuted,
          failedTasks: e.failedTasks,
          avgExecutionTime: e.tasksExecuted > 0
            ? Math.round(e.totalExecutionTime / e.tasksExecuted)
            : 0,
          temporary: e.temporary,
          cachedFunctions: e.cachedFunctions?.size || 0
        }))
      },

      generator: {
        size: generatorPool.length,
        busy: poolCounters.generator.busy,
        idle: poolCounters.generator.idle,
        queued: getQueueLength(queues.generator),
        queueByPriority: {
          high: queues.generator.high.length,
          normal: queues.generator.normal.length,
          low: queues.generator.low.length
        },
        workers: generatorPool.map(e => ({
          id: e.id,
          busy: e.busy,
          tasksExecuted: e.tasksExecuted,
          failedTasks: e.failedTasks,
          avgExecutionTime: e.tasksExecuted > 0
            ? Math.round(e.totalExecutionTime / e.tasksExecuted)
            : 0,
          temporary: e.temporary,
          cachedFunctions: e.cachedFunctions?.size || 0
        }))
      },

      config: {
        poolSize: config.poolSize,
        minThreads: config.minThreads,
        maxQueueSize: config.maxQueueSize,
        maxTemporaryWorkers: config.maxTemporaryWorkers,
        workerIdleTimeout: config.workerIdleTimeout,
        resourceLimits: config.resourceLimits,
        functionCacheSize: config.functionCacheSize,
        lowMemoryMode: config.lowMemoryMode
      },

      metrics: {
        totalTasksExecuted: metrics.totalTasksExecuted,
        totalTasksFailed: metrics.totalTasksFailed,
        totalRetries: metrics.totalRetries,
        temporaryWorkersCreated: metrics.temporaryWorkersCreated,
        activeTemporaryWorkers: metrics.activeTemporaryWorkers,
        temporaryWorkerExecutionTime: metrics.temporaryWorkerExecutionTime,
        temporaryWorkerTasks: metrics.temporaryWorkerTasks,
        affinityHits: metrics.affinityHits,
        affinityMisses: metrics.affinityMisses,
        affinityHitRate: (metrics.affinityHits + metrics.affinityMisses) > 0
          ? ((metrics.affinityHits / (metrics.affinityHits + metrics.affinityMisses)) * 100).toFixed(1) + '%'
          : '0%'
      }
    }) as Readonly<FullPoolStats>;
  }
};

// ============================================================================
// EXPORTS
// ============================================================================

export {
  AsyncThreadError,
  AbortError,
  TimeoutError,
  QueueFullError,
  WorkerError,
  noopLogger
};

// Re-export types
export type {
  Executor,
  StreamExecutor,
  ConfigureOptions,
  FullPoolStats,
  Priority,
  PoolType,
  Logger
};

// Default export for convenience
export default beeThreads;

