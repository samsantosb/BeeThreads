/**
 * @fileoverview Core execution engine for bee-threads.
 * 
 * Handles task execution lifecycle:
 * - Worker communication
 * - Timeout handling
 * - Abort signal support
 * - Retry with backoff
 * - Metrics tracking
 * 
 * @module bee-threads/execution
 */

'use strict';

const { config, metrics } = require('./config');
const { requestWorker, releaseWorker, fastHash } = require('./pool');
const { sleep, calculateBackoff } = require('./utils');
const { AbortError, TimeoutError, WorkerError } = require('./errors');

// ============================================================================
// SINGLE EXECUTION
// ============================================================================

/**
 * @typedef {Object} ExecutionOptions
 * @property {boolean} safe - Return result wrapper instead of throwing
 * @property {number|null} timeout - Execution timeout (ms)
 * @property {string} poolType - Worker pool type ('normal' | 'generator')
 * @property {Transferable[]} transfer - Zero-copy transferables
 * @property {AbortSignal|null} signal - Cancellation signal
 * @property {Object|null} context - Closure variable injection
 * @property {Object|null} retry - Retry configuration
 */

/**
 * Executes a function once in a worker (no retry).
 * 
 * @param {Function} fn - Function to execute (will be stringified)
 * @param {Array} args - Function arguments
 * @param {ExecutionOptions} options - Execution options
 * @returns {Promise<*>} Execution result
 */
async function executeOnce(fn, args, { 
  safe = false, 
  timeout = null, 
  poolType = 'normal', 
  transfer = [], 
  signal = null,
  context = null,
  priority = 'normal'
} = {}) {
  const startTime = Date.now();
  const fnString = fn.toString();
  
  // Compute hash for worker affinity (routes same function to same worker)
  const fnHash = fastHash(fnString);
  
  // ─────────────────────────────────────────────────────────────────────────
  // Pre-execution checks
  // ─────────────────────────────────────────────────────────────────────────
  if (signal?.aborted) {
    const err = new AbortError(signal.reason?.message);
    if (safe) return { status: 'rejected', error: err };
    throw err;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Acquire worker (with affinity preference)
  // ─────────────────────────────────────────────────────────────────────────
  let workerInfo;
  try {
    workerInfo = await requestWorker(poolType, priority, fnHash);
  } catch (err) {
    if (safe) return { status: 'rejected', error: err };
    throw err;
  }

  const { entry, worker, temporary } = workerInfo;

  // ─────────────────────────────────────────────────────────────────────────
  // Execute in worker
  // ─────────────────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let abortHandler;

    /**
     * Cleanup - removes listeners and releases worker.
     */
    const cleanup = (executionTime, failed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      releaseWorker(entry, worker, temporary, executionTime, failed, fnHash);
    };

    /**
     * Settles the promise with success or failure.
     */
    const settle = (isSuccess, value) => {
      if (settled) return;
      cleanup(Date.now() - startTime, !isSuccess);
      
      // Update metrics
      isSuccess ? metrics.totalTasksExecuted++ : metrics.totalTasksFailed++;
      
      // Handle safe mode
      if (safe) {
        resolve(isSuccess ? { status: 'fulfilled', value } : { status: 'rejected', error: value });
      } else {
        isSuccess ? resolve(value) : reject(value);
      }
    };

    // Worker message handler
    const onMessage = (msg) => {
      // Handle console logs from worker
      if (msg.type === 'log') {
        const logFn = console[msg.level] || console.log;
        logFn('[worker]', ...msg.args);
        return;
      }
      
      if (msg.ok) {
        settle(true, msg.value);
      } else {
        const err = new WorkerError(msg.error.message);
        err.name = msg.error.name || 'Error';
        if (msg.error.stack) err.stack = msg.error.stack;
        settle(false, err);
      }
    };

    // Worker error handler
    const onError = (err) => settle(false, new WorkerError(err.message, err));
    
    // Worker exit handler
    const onExit = (code) => {
      if (!settled && code !== 0) settle(false, new WorkerError(`Worker exited with code ${code}`));
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Setup abort signal handler
    // ─────────────────────────────────────────────────────────────────────────
    if (signal) {
      abortHandler = () => {
        worker.terminate();
        settle(false, new AbortError(signal.reason?.message));
      };
      signal.addEventListener('abort', abortHandler);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup timeout
    // ─────────────────────────────────────────────────────────────────────────
    if (timeout) {
      timer = setTimeout(() => {
        worker.terminate();
        settle(false, new TimeoutError(timeout));
      }, timeout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Attach listeners and send task
    // ─────────────────────────────────────────────────────────────────────────
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);

    const message = { fn: fnString, args, context };
    transfer?.length > 0 ? worker.postMessage(message, transfer) : worker.postMessage(message);
  });
}

// ============================================================================
// EXECUTION WITH RETRY
// ============================================================================

/**
 * Executes a function with optional retry logic.
 * 
 * @param {Function} fn - Function to execute
 * @param {Array} args - Function arguments
 * @param {ExecutionOptions} options - Execution options
 * @returns {Promise<*>} Execution result
 */
async function execute(fn, args, options = {}) {
  const { retry: retryOpts = config.retry, safe = false } = options;
  
  // No retry enabled - execute once
  if (!retryOpts?.enabled) {
    return executeOnce(fn, args, options);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Retry loop with exponential backoff
  // ─────────────────────────────────────────────────────────────────────────
  const { maxAttempts, baseDelay, maxDelay, backoffFactor } = retryOpts;
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await executeOnce(fn, args, { ...options, safe: false });
      return safe ? { status: 'fulfilled', value: result } : result;
    } catch (err) {
      lastError = err;
      
      // Never retry abort or timeout - these are intentional
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

module.exports = {
  executeOnce,
  execute
};

