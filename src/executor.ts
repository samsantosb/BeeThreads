/**
 * @fileoverview Fluent API builder for bee-threads.
 *
 * ## Why This File Exists
 *
 * Provides the chainable "builder" API that makes bee-threads ergonomic.
 * Implements the immutable builder pattern - each method returns a NEW
 * executor instance, allowing safe configuration reuse.
 *
 * ## What It Does
 *
 * - Creates chainable executor instances
 * - Validates inputs before execution (fail-fast)
 * - Accumulates configuration immutably
 * - Delegates actual execution to `execution.ts`
 *
 * ## Fluent API Methods
 *
 * - `.usingParams(...args)` - set function arguments
 * - `.setContext({...})` - inject closure variables
 * - `.signal(AbortSignal)` - enable cancellation
 * - `.transfer([...])` - zero-copy ArrayBuffer transfer
 * - `.retry({ maxAttempts, baseDelay })` - enable retry with backoff
 * - `.priority('high'|'normal'|'low')` - set queue priority
 * - `.execute()` - run the task
 *
 * ## Why Immutable?
 *
 * Immutable builders allow safe reuse:
 *
 * ```js
 * const base = beeThreads.run(fn).setContext({ API_KEY });
 * await base.usingParams(1).execute(); // Safe to reuse
 * await base.usingParams(2).execute(); // Same context, different params
 * ```
 *
 * @module bee-threads/executor
 * @internal
 */

import { config } from './config';
import { execute } from './execution';
import { fastHash } from './pool';
import { validateFunction, validateFunctionSize, validateContextSecurity } from './validation';
import type { Priority, ExecutionOptions, RetryOptions } from './types';

// ============================================================================
// EXECUTOR TYPES
// ============================================================================

/** Internal state for an executor instance */
interface ExecutorState {
  fnString: string;
  fnHash: string;
  options: ExecutionOptions;
  args: unknown[];
}

/** The chainable executor interface */
export interface Executor<T = unknown> {
  usingParams(...params: unknown[]): Executor<T>;
  setContext(context: Record<string, unknown>): Executor<T>;
  signal(abortSignal: AbortSignal): Executor<T>;
  transfer(list: ArrayBufferLike[]): Executor<T>;
  retry(retryOptions?: RetryOptions): Executor<T>;
  priority(level: Priority): Executor<T>;
  noCoalesce(): Executor<T>;
  /** Enable automatic Uint8Array to Buffer reconstruction for worker results */
  reconstructBuffers(): Executor<T>;
  execute(): Promise<T>;
}

// ============================================================================
// EXECUTOR FACTORY
// ============================================================================

/**
 * Creates an immutable, chainable executor.
 */
export function createExecutor<T = unknown>(state: ExecutorState): Executor<T> {
  const { fnString, fnHash, options, args } = state;

  const executor: Executor<T> = {
    /**
     * Sets the arguments to pass to the function.
     */
    usingParams(...params: unknown[]): Executor<T> {
      return createExecutor<T>({
        fnString,
        fnHash,
        options,
        args: args.length > 0 ? args.concat(params) : params
      });
    },

    /**
     * Injects external variables into the function's scope.
     * Functions are automatically serialized and reconstructed in the worker.
     * 
     * @example
     * ```typescript
     * import { helper } from './utils';
     * 
     * await bee((data) => data.map(helper))
     *   .setContext({ helper })  // Functions work now!
     *   (myArray);
     * ```
     */
    setContext(context: Record<string, unknown>): Executor<T> {
      if (typeof context !== 'object' || context === null) {
        throw new TypeError('setContext() requires a non-null object');
      }
      
      // Security: Block prototype pollution attacks
      if (config.security.blockPrototypePollution) {
        validateContextSecurity(context);
      }
      
      // Serialize functions automatically
      const serializedContext: Record<string, unknown> = {};
      const contextKeys = Object.keys(context);
      for (let i = 0, len = contextKeys.length; i < len; i++) {
        const key = contextKeys[i];
        const value = context[key];
        if (typeof value === 'function') {
          // Serialize function with special prefix for reconstruction
          serializedContext[key] = `__BEE_FN__:${value.toString()}`;
        } else if (typeof value === 'symbol') {
          throw new TypeError(
            `setContext() key "${key}" contains a Symbol which cannot be serialized.`
          );
        } else {
          serializedContext[key] = value;
        }
      }
      return createExecutor<T>({
        fnString,
        fnHash,
        options: { ...options, context: serializedContext },
        args
      });
    },

    /**
     * Attaches an AbortSignal for cancellation support.
     */
    signal(abortSignal: AbortSignal): Executor<T> {
      return createExecutor<T>({
        fnString,
        fnHash,
        options: { ...options, signal: abortSignal },
        args
      });
    },

    /**
     * Specifies transferable objects for zero-copy transfer.
     */
    transfer(list: ArrayBufferLike[]): Executor<T> {
      return createExecutor<T>({
        fnString,
        fnHash,
        options: { ...options, transfer: list },
        args
      });
    },

    /**
     * Enables automatic retry with exponential backoff.
     */
    retry(retryOptions: RetryOptions = {}): Executor<T> {
      const mergedRetry = {
        enabled: true,
        maxAttempts: retryOptions.maxAttempts ?? config.retry.maxAttempts,
        baseDelay: retryOptions.baseDelay ?? config.retry.baseDelay,
        maxDelay: retryOptions.maxDelay ?? config.retry.maxDelay,
        backoffFactor: retryOptions.backoffFactor ?? config.retry.backoffFactor,
      };
      return createExecutor<T>({
        fnString,
        fnHash,
        options: {
          ...options,
          retry: mergedRetry
        } as ExecutionOptions & { retry: typeof mergedRetry },
        args
      });
    },

    /**
     * Sets the task priority for queue ordering.
     */
    priority(level: Priority): Executor<T> {
      // O(1) lookup instead of array.includes()
      if (level !== 'high' && level !== 'normal' && level !== 'low') {
        throw new TypeError(`Invalid priority "${level}". Use: high, normal, low`);
      }
      return createExecutor<T>({
        fnString,
        fnHash,
        options: { ...options, priority: level },
        args
      });
    },

    /**
     * Disables request coalescing for this execution.
     * Use for non-deterministic functions that should always execute separately.
     * 
     * Note: Coalescing is automatically disabled for functions containing
     * Date.now, Math.random, crypto.randomUUID, etc.
     * 
     * @example
     * await beeThreads.run(() => fetchLatestData()).noCoalesce().execute();
     */
    noCoalesce(): Executor<T> {
      return createExecutor<T>({
        fnString,
        fnHash,
        options: { ...options, skipCoalescing: true },
        args
      });
    },

    /**
     * Enables automatic Uint8Array to Buffer reconstruction.
     * Use when your function returns Buffer (e.g., Sharp, fs, crypto).
     * 
     * The Structured Clone Algorithm used by postMessage converts Buffer to Uint8Array.
     * This option recursively converts them back to Buffer.
     * 
     * @example
     * const buffer = await beeThreads
     *   .run((img) => require('sharp')(img).resize(100).toBuffer())
     *   .usingParams(imageBuffer)
     *   .reconstructBuffers()
     *   .execute();
     * console.log(Buffer.isBuffer(buffer)); // true
     */
    reconstructBuffers(): Executor<T> {
      return createExecutor<T>({
        fnString,
        fnHash,
        options: { ...options, reconstructBuffers: true },
        args
      });
    },

    /**
     * Executes the function in a worker thread.
     */
    execute(): Promise<T> {
      return execute<T>(
        { toString: () => fnString },
        args,
        { ...options, poolType: 'normal' },
        fnHash
      ) as Promise<T>;
    }
  };

  return executor;
}

// ============================================================================
// CURRIED RUNNER FACTORY
// ============================================================================

/** Any callable function type */
type AnyFunction = (...args: any[]) => any;

/**
 * Creates a runner function with preset base options.
 * Type inference extracts ReturnType from the function automatically.
 */
export function createCurriedRunner(
  baseOptions: ExecutionOptions = {}
): <T extends AnyFunction>(fn: T) => Executor<ReturnType<T>> {
  return function run<T extends AnyFunction>(fn: T): Executor<ReturnType<T>> {
    validateFunction(fn);
    
    const fnString = fn.toString();
    
    // Security: Validate function size (DoS prevention)
    validateFunctionSize(fnString, config.security.maxFunctionSize);
    
    // Compute hash once at executor creation (not at execute time)
    const fnHash = fastHash(fnString);
    
    return createExecutor<ReturnType<T>>({
      fnString,
      fnHash,
      options: baseOptions,
      args: []
    });
  };
}

