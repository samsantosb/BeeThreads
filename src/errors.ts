/**
 * @fileoverview Custom error classes for bee-threads library.
 *
 * All errors extend AsyncThreadError which provides error codes
 * for programmatic error handling.
 *
 * Error Codes:
 * - ERR_ABORTED: Operation was cancelled via AbortSignal
 * - ERR_TIMEOUT: Worker exceeded timeout limit
 * - ERR_QUEUE_FULL: Task queue reached maximum capacity
 * - ERR_WORKER: Error occurred inside the worker thread
 * - ERR_SHUTDOWN: Pool is shutting down
 *
 * @module bee-threads/errors
 */

/** Error codes used by bee-threads errors */
export type ErrorCode =
  | 'ERR_ABORTED'
  | 'ERR_TIMEOUT'
  | 'ERR_QUEUE_FULL'
  | 'ERR_WORKER'
  | 'ERR_SHUTDOWN';

/**
 * Base error class for all bee-threads errors.
 * Provides a consistent error interface with error codes.
 *
 * @example
 * try {
 *   await beeThreads.run(fn)();
 * } catch (err) {
 *   if (err instanceof AsyncThreadError) {
 *     console.log(err.code); // 'ERR_WORKER', 'ERR_TIMEOUT', etc.
 *   }
 * }
 */
export class AsyncThreadError extends Error {
  /** Machine-readable error code */
  public readonly code: ErrorCode;

  /**
   * Creates a new AsyncThreadError.
   *
   * @param message - Human-readable error message
   * @param code - Machine-readable error code (e.g., 'ERR_TIMEOUT')
   */
  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = 'AsyncThreadError';
    this.code = code;

    // Maintains proper stack trace in V8 environments (Node.js)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when an operation is cancelled via AbortSignal.
 *
 * This error is thrown when:
 * - AbortController.abort() is called while task is running
 * - An already-aborted signal is passed to a task
 *
 * @example
 * const controller = new AbortController();
 * controller.abort();
 *
 * try {
 *   await beeThreads.run(fn).signal(controller.signal)();
 * } catch (err) {
 *   if (err instanceof AbortError) {
 *     console.log('Operation was cancelled');
 *   }
 * }
 */
export class AbortError extends AsyncThreadError {
  /**
   * Creates a new AbortError.
   *
   * @param message - Error message (default: 'Operation was aborted')
   */
  constructor(message: string = 'Operation was aborted') {
    super(message, 'ERR_ABORTED');
    this.name = 'AbortError';
  }
}

/**
 * Error thrown when a worker exceeds its timeout limit.
 *
 * This error is thrown when:
 * - A task running with withTimeout() exceeds the time limit
 * - The worker is forcefully terminated due to timeout
 *
 * @example
 * try {
 *   await beeThreads.withTimeout(1000)(slowFn)();
 * } catch (err) {
 *   if (err instanceof TimeoutError) {
 *     console.log(`Timed out after ${err.timeout}ms`);
 *   }
 * }
 */
export class TimeoutError extends AsyncThreadError {
  /** The timeout value in milliseconds */
  public readonly timeout: number;

  /**
   * Creates a new TimeoutError.
   *
   * @param ms - The timeout value that was exceeded (in milliseconds)
   */
  constructor(ms: number) {
    super(`Worker timed out after ${ms}ms`, 'ERR_TIMEOUT');
    this.name = 'TimeoutError';
    this.timeout = ms;
  }
}

/**
 * Error thrown when the task queue is full.
 *
 * This error is thrown when:
 * - All workers are busy
 * - All temporary workers are in use
 * - The queue has reached maxQueueSize
 *
 * @example
 * try {
 *   await beeThreads.run(fn)();
 * } catch (err) {
 *   if (err instanceof QueueFullError) {
 *     console.log(`Queue full: max ${err.maxSize} tasks`);
 *     // Consider increasing maxQueueSize or poolSize
 *   }
 * }
 */
export class QueueFullError extends AsyncThreadError {
  /** Maximum queue size configured */
  public readonly maxSize: number;

  /**
   * Creates a new QueueFullError.
   *
   * @param maxSize - The maximum queue size that was reached
   */
  constructor(maxSize: number) {
    super(`Task queue full (max ${maxSize})`, 'ERR_QUEUE_FULL');
    this.name = 'QueueFullError';
    this.maxSize = maxSize;
  }
}

/**
 * Error thrown when an error occurs inside the worker thread.
 *
 * This wraps errors from:
 * - Exceptions thrown by the user's function
 * - Worker process crashes
 * - Unexpected worker exits
 *
 * @example
 * try {
 *   await beeThreads.run(() => { throw new Error('oops'); })();
 * } catch (err) {
 *   if (err instanceof WorkerError) {
 *     console.log('Worker error:', err.message);
 *     if (err.cause) {
 *       console.log('Original error:', err.cause);
 *     }
 *   }
 * }
 */
export class WorkerError extends AsyncThreadError {
  /** The original error that caused this (if available) */
  public declare cause?: Error;

  /**
   * Creates a new WorkerError.
   *
   * @param message - Error message from the worker
   * @param originalError - The original error that caused this
   */
  constructor(message: string, originalError?: Error) {
    super(message, 'ERR_WORKER');
    this.name = 'WorkerError';

    // Store original error for debugging
    if (originalError) {
      this.cause = originalError;
      // Preserve original stack trace if available
      this.stack = originalError.stack || this.stack;
    }
  }
}

