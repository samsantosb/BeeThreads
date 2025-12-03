/**
 * @fileoverview Core execution engine for bee-threads.
 *
 * This is the heart of task execution. It orchestrates:
 * 1. Acquiring a worker from the pool (with affinity preference)
 * 2. Sending the task to the worker
 * 3. Handling responses, errors, and timeouts
 * 4. Releasing the worker back to the pool
 * 5. Tracking metrics for monitoring
 *
 * @module bee-threads/execution
 */

import { Worker } from 'worker_threads';
import { config, metrics } from './config';
import { requestWorker, releaseWorker, fastHash } from './pool';
import { sleep, calculateBackoff } from './utils';
import { AbortError, TimeoutError, WorkerError } from './errors';
import { MessageType } from './types';
import type {
  PoolType,
  Priority,
  ExecutionOptions,
  WorkerResponseCompat,
  WorkerSuccessResponse,
  WorkerErrorResponse,
  WorkerLogMessage,
  WorkerEntry,
  RetryConfig,
  LogLevelValue
} from './types';

// ============================================================================
// RESULT TYPES
// ============================================================================

interface SafeResult<T> {
  status: 'fulfilled' | 'rejected';
  value?: T;
  error?: Error;
}

// ============================================================================
// SINGLE EXECUTION
// ============================================================================

/**
 * Executes a function once in a worker thread (no retry).
 */
export async function executeOnce<T = unknown>(
  fn: Function | { toString(): string },
  args: unknown[],
  options: ExecutionOptions = {}
): Promise<T | SafeResult<T>> {
  const {
    safe = false,
    timeout = null,
    poolType = 'normal',
    transfer = [],
    signal = null,
    context = null,
    priority = 'normal'
  } = options;

  const startTime = Date.now();
  const fnString = fn.toString();

  // Compute hash for worker affinity
  const fnHash = fastHash(fnString);

  // Pre-execution checks
  if (signal?.aborted) {
    const err = new AbortError((signal.reason as Error)?.message);
    if (safe) return { status: 'rejected', error: err };
    throw err;
  }

  // Acquire worker
  let workerInfo;
  try {
    workerInfo = await requestWorker(poolType, priority, fnHash);
  } catch (err) {
    if (safe) return { status: 'rejected', error: err as Error };
    throw err;
  }

  const { entry, worker, temporary } = workerInfo;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const cleanup = (executionTime: number, failed: boolean = false): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      releaseWorker(entry, worker, temporary, poolType, executionTime, failed, fnHash);
    };

    const settle = (isSuccess: boolean, value: unknown): void => {
      if (settled) return;
      cleanup(Date.now() - startTime, !isSuccess);

      // Update metrics
      isSuccess ? metrics.totalTasksExecuted++ : metrics.totalTasksFailed++;

      // Handle safe mode
      if (safe) {
        resolve(
          isSuccess
            ? { status: 'fulfilled', value: value as T }
            : { status: 'rejected', error: value as Error }
        );
      } else {
        isSuccess ? resolve(value as T) : reject(value);
      }
    };

    const onMessage = (msg: WorkerResponseCompat): void => {
      // Handle console logs from worker
      if ('type' in msg && msg.type === MessageType.LOG) {
        const logMsg = msg as WorkerLogMessage;
        // Use configured logger (or skip if null)
        if (config.logger) {
          const logFn = config.logger[logMsg.level as keyof typeof config.logger] as ((...args: unknown[]) => void) | undefined;
          if (typeof logFn === 'function') {
            logFn('[worker]', ...logMsg.args);
          } else {
            config.logger.log('[worker]', ...logMsg.args);
          }
        }
        return;
      }

      // New format: type-based discriminated union
      if ('type' in msg) {
        if (msg.type === MessageType.SUCCESS) {
          settle(true, (msg as WorkerSuccessResponse).value);
        } else if (msg.type === MessageType.ERROR) {
          const errMsg = msg as WorkerErrorResponse;
          const err = new WorkerError(errMsg.error.message);
          err.name = errMsg.error.name || 'Error';
          if (errMsg.error.stack) err.stack = errMsg.error.stack;
          // Log code dump in debug mode
          if (config.debugMode && errMsg.error.code && config.logger) {
            config.logger.error('[bee-threads] Failed function:\n', errMsg.error.code);
          }
          settle(false, err);
        }
        return;
      }

      // Legacy format: ok-based (backwards compatibility)
      if ('ok' in msg) {
        if (msg.ok) {
          settle(true, msg.value);
        } else {
          const err = new WorkerError(msg.error.message);
          err.name = msg.error.name || 'Error';
          if (msg.error.stack) err.stack = msg.error.stack;
          settle(false, err);
        }
      }
    };

    const onError = (err: Error): void => {
      settle(false, new WorkerError(err.message, err));
    };

    const onExit = (code: number): void => {
      if (!settled && code !== 0) {
        settle(false, new WorkerError(`Worker exited with code ${code}`));
      }
    };

    // Setup abort signal handler
    if (signal) {
      abortHandler = (): void => {
        worker.terminate();
        settle(false, new AbortError((signal.reason as Error)?.message));
      };
      signal.addEventListener('abort', abortHandler);
    }

    // Setup timeout
    if (timeout) {
      timer = setTimeout(() => {
        worker.terminate();
        settle(false, new TimeoutError(timeout));
      }, timeout);
    }

    // Attach listeners and send task
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    const message = { fn: fnString, args, context };
    transfer.length > 0 ? worker.postMessage(message, transfer) : worker.postMessage(message);
  });
}

// ============================================================================
// EXECUTION WITH RETRY
// ============================================================================

/**
 * Executes a function with optional retry logic and exponential backoff.
 */
export async function execute<T = unknown>(
  fn: Function | { toString(): string },
  args: unknown[],
  options: ExecutionOptions & { retry?: RetryConfig } = {}
): Promise<T | SafeResult<T>> {
  const { retry: retryOpts = config.retry, safe = false } = options;

  // No retry enabled - execute once
  if (!retryOpts?.enabled) {
    return executeOnce<T>(fn, args, options);
  }

  const { maxAttempts, baseDelay, maxDelay, backoffFactor } = retryOpts;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await executeOnce<T>(fn, args, { ...options, safe: false });
      return safe ? { status: 'fulfilled', value: result as T } : (result as T);
    } catch (err) {
      lastError = err as Error;

      // Never retry abort or timeout
      if (err instanceof AbortError || err instanceof TimeoutError) break;

      // Wait before next attempt (except last)
      if (attempt < maxAttempts - 1) {
        metrics.totalRetries++;
        await sleep(calculateBackoff(attempt, baseDelay, maxDelay, backoffFactor));
      }
    }
  }

  // All attempts failed
  if (safe) return { status: 'rejected', error: lastError };
  throw lastError;
}

