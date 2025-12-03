/**
 * @fileoverview Executor builder for bee-threads.
 *
 * This module implements the fluent API builder pattern for task execution.
 * It decouples the user-facing API from the internal execution engine.
 *
 * @module bee-threads/executor
 * @internal
 */

import { config } from './config';
import { execute } from './execution';
import { validateFunction } from './validation';
import type { Priority, ExecutionOptions, RetryOptions } from './types';

// ============================================================================
// EXECUTOR TYPES
// ============================================================================

/** Internal state for an executor instance */
interface ExecutorState {
  fnString: string;
  options: ExecutionOptions;
  args: unknown[];
}

/** The chainable executor interface */
export interface Executor<T = unknown> {
  usingParams(...params: unknown[]): Executor<T>;
  setContext(context: Record<string, unknown>): Executor<T>;
  signal(abortSignal: AbortSignal): Executor<T>;
  transfer(list: ArrayBuffer[]): Executor<T>;
  retry(retryOptions?: RetryOptions): Executor<T>;
  priority(level: Priority): Executor<T>;
  execute(): Promise<T>;
}

// ============================================================================
// EXECUTOR FACTORY
// ============================================================================

/**
 * Creates an immutable, chainable executor.
 */
export function createExecutor<T = unknown>(state: ExecutorState): Executor<T> {
  const { fnString, options, args } = state;

  const executor: Executor<T> = {
    /**
     * Sets the arguments to pass to the function.
     */
    usingParams(...params: unknown[]): Executor<T> {
      return createExecutor<T>({
        fnString,
        options,
        args: [...args, ...params]
      });
    },

    /**
     * Injects external variables into the function's scope.
     */
    setContext(context: Record<string, unknown>): Executor<T> {
      if (typeof context !== 'object' || context === null) {
        throw new TypeError('setContext() requires a non-null object');
      }
      return createExecutor<T>({
        fnString,
        options: { ...options, context },
        args
      });
    },

    /**
     * Attaches an AbortSignal for cancellation support.
     */
    signal(abortSignal: AbortSignal): Executor<T> {
      return createExecutor<T>({
        fnString,
        options: { ...options, signal: abortSignal },
        args
      });
    },

    /**
     * Specifies transferable objects for zero-copy transfer.
     */
    transfer(list: ArrayBuffer[]): Executor<T> {
      return createExecutor<T>({
        fnString,
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
      return createExecutor<T>({
        fnString,
        options: { ...options, priority: level },
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
        { ...options, poolType: 'normal' }
      ) as Promise<T>;
    }
  };

  return executor;
}

// ============================================================================
// CURRIED RUNNER FACTORY
// ============================================================================

/**
 * Creates a runner function with preset base options.
 */
export function createCurriedRunner<T = unknown>(
  baseOptions: ExecutionOptions = {}
): (fn: Function) => Executor<T> {
  return function run(fn: Function): Executor<T> {
    validateFunction(fn);
    return createExecutor<T>({
      fnString: fn.toString(),
      options: baseOptions,
      args: []
    });
  };
}

