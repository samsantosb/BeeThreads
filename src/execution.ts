/**
 * @fileoverview Core execution engine for bee-threads.
 *
 * ## Why This File Exists
 *
 * This is the heart of task execution. It orchestrates the entire lifecycle
 * of a task from worker acquisition to result delivery. Separating this
 * logic allows the public API (`executor.ts`) to remain clean and focused
 * on the builder pattern.
 *
 * ## What It Does
 *
 * 1. Acquires a worker from the pool (with affinity preference)
 * 2. Sends the task to the worker via postMessage
 * 3. Handles responses, errors, and timeouts
 * 4. Releases the worker back to the pool
 * 5. Tracks metrics for monitoring
 * 6. Implements retry with exponential backoff
 *
 * ## Critical Implementation Details
 *
 * ### Race Condition Prevention (v3.1.2+)
 *
 * The `settled` flag must be set BEFORE calling `worker.terminate()`.
 * This prevents a race condition where the async 'exit' event could
 * fire before our timeout/abort handler completes.
 *
 * ### Error Reconstruction
 *
 * Errors are serialized in workers and reconstructed here. Custom
 * properties (code, statusCode, etc.) are preserved. Error.cause
 * and AggregateError.errors are recursively reconstructed.
 *
 * @module bee-threads/execution
 */

import { config, metrics } from './config';
import { requestWorker, releaseWorker, fastHash } from './pool';
import { sleep, calculateBackoff, reconstructBuffers } from './utils';
import { AbortError, TimeoutError, WorkerError } from './errors';
import { MessageType } from './types';
import { coalesce } from './coalescing';
import type {
  ExecutionOptions,
  WorkerResponseCompat,
  WorkerSuccessResponse,
  WorkerErrorResponse,
  WorkerLogMessage,
  RetryConfig,
  SafeResult
} from './types';

// ============================================================================
// SINGLE EXECUTION
// ============================================================================

/**
 * Executes a function once in a worker thread (no retry).
 * 
 * @param fn - Function to execute
 * @param args - Arguments to pass to the function
 * @param options - Execution options
 * @param precomputedHash - Pre-computed function hash (optional, avoids recomputation)
 */
export async function executeOnce<T = unknown>(
  fn: Function | { toString(): string },
  args: unknown[],
  options: ExecutionOptions = {},
  precomputedHash?: string
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

  // Use pre-computed hash or compute now
  const fnHash = precomputedHash ?? fastHash(fnString);

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

      // Helper to reconstruct error from serialized data
      const reconstructError = (errorData: Record<string, unknown>): WorkerError => {
        const err = new WorkerError(String(errorData.message || ''));
        err.name = String(errorData.name || 'Error');
        if (errorData.stack) err.stack = String(errorData.stack);
        
        // Reconstruct cause recursively (ES2022)
        if (errorData.cause && typeof errorData.cause === 'object') {
          (err as unknown as Record<string, unknown>).cause = reconstructError(
            errorData.cause as Record<string, unknown>
          );
        }
        
        // Reconstruct AggregateError.errors
        if (Array.isArray(errorData.errors)) {
          const errArray = errorData.errors;
          const reconstructedErrors = new Array(errArray.length);
          for (let j = 0, jlen = errArray.length; j < jlen; j++) {
            reconstructedErrors[j] = reconstructError(errArray[j] as Record<string, unknown>);
          }
          (err as unknown as Record<string, unknown>).errors = reconstructedErrors;
        }
        
        // Copy other custom properties (code, statusCode, etc.)
        const errorDataKeys = Object.keys(errorData);
        for (let i = 0, len = errorDataKeys.length; i < len; i++) {
          const key = errorDataKeys[i];
          if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== '_sourceCode' && key !== 'cause' && key !== 'errors') {
            (err as unknown as Record<string, unknown>)[key] = errorData[key];
          }
        }
        
        return err;
      };

      // New format: type-based discriminated union
      if ('type' in msg) {
        if (msg.type === MessageType.SUCCESS) {
          const rawValue = (msg as WorkerSuccessResponse).value;
          const value = options.reconstructBuffers ? reconstructBuffers(rawValue) : rawValue;
          settle(true, value);
        } else if (msg.type === MessageType.ERROR) {
          const errMsg = msg as WorkerErrorResponse;
          const err = reconstructError(errMsg.error as unknown as Record<string, unknown>);
          // Log code dump in debug mode
          if (config.debugMode && errMsg.error._sourceCode && config.logger) {
            config.logger.error('[bee-threads] Failed function:\n', errMsg.error._sourceCode);
          }
          settle(false, err);
        }
        return;
      }

      // Legacy format: ok-based (backwards compatibility)
      if ('ok' in msg) {
        if (msg.ok) {
          const rawValue = msg.value;
          const value = options.reconstructBuffers ? reconstructBuffers(rawValue) : rawValue;
          settle(true, value);
        } else {
          const err = reconstructError(msg.error as unknown as Record<string, unknown>);
          settle(false, err);
        }
      }
    };

    const onError = (err: Error): void => {
      settle(false, new WorkerError(err.message, err));
    };

    const onExit = (code: number): void => {
      // settled is checked first - timeout/abort handlers set it before terminate()
      // This prevents race condition where terminate()'s async 'exit' event
      // could beat the settle() call
      if (!settled && code !== 0) {
        settle(false, new WorkerError(`Worker exited with code ${code}`));
      }
    };

    // Setup abort signal handler
    if (signal) {
      abortHandler = (): void => {
        if (settled) return;
        // CRITICAL: Set settled FIRST to prevent any race condition
        // This ensures onExit cannot run even if terminate() triggers exit synchronously
        settled = true;
        
        if (timer) clearTimeout(timer);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
        
        worker.terminate();
        
        // Release worker with terminated=true to remove from pool
        releaseWorker(entry, worker, temporary, poolType, Date.now() - startTime, true, fnHash, true);
        metrics.totalTasksFailed++;
        
        if (safe) {
          resolve({ status: 'rejected', error: new AbortError((signal.reason as Error)?.message) });
        } else {
          reject(new AbortError((signal.reason as Error)?.message));
        }
      };
      signal.addEventListener('abort', abortHandler);
    }

    // Setup timeout
    if (timeout) {
      timer = setTimeout(() => {
        if (settled) return;
        // CRITICAL: Set settled FIRST to prevent any race condition
        // This ensures onExit cannot run even if terminate() triggers exit synchronously
        settled = true;
        
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
        worker.removeListener('message', onMessage);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
        
        worker.terminate();
        
        // Release worker with terminated=true to remove from pool
        releaseWorker(entry, worker, temporary, poolType, Date.now() - startTime, true, fnHash, true);
        metrics.totalTasksFailed++;
        
        if (safe) {
          resolve({ status: 'rejected', error: new TimeoutError(timeout) });
        } else {
          reject(new TimeoutError(timeout));
        }
      }, timeout);
    }

    // Attach listeners and send task
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    // V8: Monomorphic message shape
    const message = { fn: fnString, args: args, context: context };
    // Cast needed: ArrayBufferLike includes SharedArrayBuffer which is already shared, not transferred
    if (transfer.length > 0) {
      worker.postMessage(message, transfer as ArrayBuffer[]);
    } else {
      worker.postMessage(message);
    }
  });
}

// ============================================================================
// EXECUTION WITH RETRY
// ============================================================================

/**
 * Executes a function with optional retry logic and exponential backoff.
 * 
 * @param fn - Function to execute
 * @param args - Arguments to pass to the function
 * @param options - Execution options
 * @param precomputedHash - Pre-computed function hash (optional, avoids recomputation)
 */
export async function execute<T = unknown>(
  fn: Function | { toString(): string },
  args: unknown[],
  options: ExecutionOptions & { retry?: RetryConfig } = {},
  precomputedHash?: string
): Promise<T | SafeResult<T>> {
  const { retry: retryOpts = config.retry, safe = false, context = null, skipCoalescing = false } = options;
  const fnString = fn.toString();
  
  // Use pre-computed hash or compute now (fallback for direct execute() calls)
  const fnHash = precomputedHash ?? fastHash(fnString);

  // Wrap execution in coalescing to deduplicate identical concurrent requests
  // Note: Coalescing is skipped for requests with AbortSignal (each needs its own lifecycle)
  const shouldCoalesce = !options.signal;

  const executeWithRetry = async (): Promise<T | SafeResult<T>> => {
    // No retry enabled - execute once
    if (!retryOpts?.enabled) {
      return executeOnce<T>(fn, args, options, fnHash);
    }

    const { maxAttempts, baseDelay, maxDelay, backoffFactor } = retryOpts;
    let lastError: Error | undefined;

    for (let attempt = 0, len = maxAttempts; attempt < len; attempt++) {
      try {
        const result = await executeOnce<T>(fn, args, { ...options, safe: false }, fnHash);
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

    // All attempts failed (lastError is guaranteed to be set if we reach here)
    const finalError = lastError ?? new Error('All retry attempts failed');
    if (safe) return { status: 'rejected', error: finalError };
    throw finalError;
  };

  // Apply coalescing if appropriate
  if (shouldCoalesce) {
    return await coalesce<T | SafeResult<T>>(
      fnString,
      args,
      context,
      executeWithRetry,
      skipCoalescing,
      fnHash
    );
  }

  return await executeWithRetry();
}

