/**
 * @fileoverview Stream executor for generator functions.
 *
 * ## Why This File Exists
 *
 * Regular functions return a single value, but generators can yield
 * multiple values over time. This file enables streaming those values
 * back to the main thread as they're produced, rather than waiting
 * for all results at once.
 *
 * ## What It Does
 *
 * - Creates a `ReadableStream` from generator functions
 * - Streams yielded values as they're produced (memory efficient)
 * - Captures the return value for access after completion
 * - Handles async generators (yields that return Promises)
 * - Supports cancellation via stream.cancel()
 *
 * ## Fluent API
 *
 * - `.usingParams(...args)` - set generator arguments
 * - `.setContext({...})` - inject closure variables
 * - `.transfer([...])` - zero-copy ArrayBuffer transfer
 * - `.execute()` - start streaming
 *
 * ## Example
 *
 * ```js
 * const stream = beeThreads
 *   .stream(function* (n) {
 *     for (let i = 1; i <= n; i++) yield i * i;
 *     return 'done';
 *   })
 *   .usingParams(5)
 *   .execute();
 *
 * for await (const value of stream) {
 *   console.log(value); // 1, 4, 9, 16, 25
 * }
 * console.log(stream.returnValue); // 'done'
 * ```
 *
 * @module bee-threads/stream-executor
 */

import { Worker } from 'worker_threads';
import { config } from './config';
import { requestWorker, releaseWorker } from './pool';
import { validateFunction } from './validation';
import { reconstructBuffers } from './utils';
import { WorkerError } from './errors';
import { MessageType } from './types';
import type { GeneratorMessage, WorkerEntry, WorkerLogMessage } from './types';

// ============================================================================
// STREAM EXECUTOR TYPES
// ============================================================================

interface StreamExecutorState {
  fnString: string;
  context: Record<string, unknown> | null;
  args: unknown[];
  transfer: ArrayBufferLike[];
  shouldReconstructBuffers: boolean;
}

/** Stream result type - ReadableStream that is also async iterable */
export type StreamResult<T> = ReadableStream<T> & AsyncIterable<T> & { returnValue?: T };

export interface StreamExecutor<T = unknown> {
  usingParams(...params: unknown[]): StreamExecutor<T>;
  setContext(ctx: Record<string, unknown>): StreamExecutor<T>;
  transfer(list: ArrayBufferLike[]): StreamExecutor<T>;
  /** Enable automatic Uint8Array to Buffer reconstruction for yielded/returned values */
  reconstructBuffers(): StreamExecutor<T>;
  execute(): StreamResult<T>;
}

// ============================================================================
// STREAM EXECUTOR FACTORY
// ============================================================================

/**
 * Creates a stream executor for generators.
 */
export function createStreamExecutor<T = unknown>(state: StreamExecutorState): StreamExecutor<T> {
  const { fnString, context, args, transfer, shouldReconstructBuffers } = state;

  const executor: StreamExecutor<T> = {
    /**
     * Sets generator arguments.
     */
    usingParams(...params: unknown[]): StreamExecutor<T> {
      return createStreamExecutor<T>({
        fnString,
        context,
        args: args.length > 0 ? args.concat(params) : params,
        transfer,
        shouldReconstructBuffers
      });
    },

    /**
     * Injects closure variables.
     */
    setContext(ctx: Record<string, unknown>): StreamExecutor<T> {
      if (typeof ctx !== 'object' || ctx === null) {
        throw new TypeError('setContext() requires a non-null object');
      }
      // Validate that context doesn't contain non-serializable values
      const ctxKeys = Object.keys(ctx);
      for (let i = 0, len = ctxKeys.length; i < len; i++) {
        const key = ctxKeys[i];
        const value = ctx[key];
        if (typeof value === 'function') {
          throw new TypeError(
            `setContext() key "${key}" contains a function which cannot be serialized. ` +
            `Convert it to a string first: { ${key}: yourFn.toString() }`
          );
        }
        if (typeof value === 'symbol') {
          throw new TypeError(
            `setContext() key "${key}" contains a Symbol which cannot be serialized.`
          );
        }
      }
      return createStreamExecutor<T>({
        fnString,
        context: ctx,
        args,
        transfer,
        shouldReconstructBuffers
      });
    },

    /**
     * Specifies transferable objects for zero-copy transfer.
     */
    transfer(list: ArrayBufferLike[]): StreamExecutor<T> {
      return createStreamExecutor<T>({
        fnString,
        context,
        args,
        transfer: list,
        shouldReconstructBuffers
      });
    },

    /**
     * Enables automatic Uint8Array to Buffer reconstruction.
     * Use when your generator yields or returns Buffer values.
     * 
     * @example
     * const stream = beeThreads
     *   .stream(function* () {
     *     yield require('fs').readFileSync('file1.txt');
     *     yield require('fs').readFileSync('file2.txt');
     *   })
     *   .reconstructBuffers()
     *   .execute();
     */
    reconstructBuffers(): StreamExecutor<T> {
      return createStreamExecutor<T>({
        fnString,
        context,
        args,
        transfer,
        shouldReconstructBuffers: true
      });
    },

    /**
     * Starts streaming the generator.
     */
    execute(): StreamResult<T> {
      let streamWorker: Worker | null = null;
      let workerEntry: WorkerEntry | null = null;
      let isTemporary = false;
      let closed = false;
      let returnValue: T | undefined = undefined;
      
      // Flag to prevent race condition between cancel() terminate and onExit
      let isCancelled = false;

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (streamWorker) {
          streamWorker.removeAllListeners('message');
          streamWorker.removeAllListeners('error');
          streamWorker.removeAllListeners('exit');
          releaseWorker(workerEntry, streamWorker, isTemporary, 'generator');
        }
      };

      const readable = new ReadableStream<T>({
        async start(controller) {
          try {
            const workerInfo = await requestWorker('generator');
            workerEntry = workerInfo.entry;
            streamWorker = workerInfo.worker;
            isTemporary = workerInfo.temporary;

            streamWorker.on('message', (msg: GeneratorMessage) => {
              if (closed) return;

              // Handle console logs from worker
              if (msg.type === MessageType.LOG) {
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

              switch (msg.type) {
                case MessageType.YIELD: {
                  const rawValue = msg.value;
                  const value = shouldReconstructBuffers ? reconstructBuffers(rawValue) : rawValue;
                  controller.enqueue(value as T);
                  break;
                }
                case MessageType.RETURN: {
                  const rawValue = msg.value;
                  returnValue = (shouldReconstructBuffers ? reconstructBuffers(rawValue) : rawValue) as T;
                  break;
                }
                case MessageType.END:
                  controller.close();
                  cleanup();
                  break;
                case MessageType.ERROR:
                  // Helper to reconstruct error from serialized data
                  const reconstructError = (data: Record<string, unknown>): WorkerError => {
                    const e = new WorkerError(String(data.message || ''));
                    e.name = String(data.name || 'Error');
                    if (data.stack) e.stack = String(data.stack);
                    // Reconstruct cause recursively
                    if (data.cause && typeof data.cause === 'object') {
                      (e as unknown as Record<string, unknown>).cause = reconstructError(
                        data.cause as Record<string, unknown>
                      );
                    }
                    // Reconstruct AggregateError.errors
                    if (Array.isArray(data.errors)) {
                      const errArray = data.errors;
                      const reconstructedErrors = new Array(errArray.length);
                      for (let k = 0, klen = errArray.length; k < klen; k++) {
                        reconstructedErrors[k] = reconstructError(errArray[k] as Record<string, unknown>);
                      }
                      (e as unknown as Record<string, unknown>).errors = reconstructedErrors;
                    }
                    // Copy other custom properties
                    const dataKeys = Object.keys(data);
                    for (let j = 0, jlen = dataKeys.length; j < jlen; j++) {
                      const key = dataKeys[j];
                      if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== '_sourceCode' && key !== 'cause' && key !== 'errors') {
                        (e as unknown as Record<string, unknown>)[key] = data[key];
                      }
                    }
                    return e;
                  };
                  
                  const err = reconstructError(msg.error as unknown as Record<string, unknown>);
                  // Log code dump in debug mode
                  if (config.debugMode && msg.error._sourceCode && config.logger) {
                    config.logger.error('[bee-threads] Failed generator:\n', msg.error._sourceCode);
                  }
                  controller.error(err);
                  cleanup();
                  break;
              }
            });

            streamWorker.on('error', (err: Error) => {
              if (closed) return;
              controller.error(new WorkerError(err.message, err));
              cleanup();
            });

            streamWorker.on('exit', (code: number) => {
              if (closed) return;
              // Ignore exit if it was caused by intentional cancellation
              // This prevents race condition where terminate()'s async 'exit' event
              // could fire before cleanup() sets closed = true
              if (code !== 0 && !isCancelled) {
                controller.error(new WorkerError(`Worker exited with code ${code}`));
              }
              cleanup();
            });

            const message = { fn: fnString, args, context };
            // Cast needed: ArrayBufferLike includes SharedArrayBuffer which is already shared, not transferred
            transfer.length > 0
              ? streamWorker.postMessage(message, transfer as ArrayBuffer[])
              : streamWorker.postMessage(message);
          } catch (err) {
            controller.error(err);
            cleanup();
          }
        },

        cancel() {
          if (streamWorker && !closed) {
            isCancelled = true;  // Mark before terminate to prevent onExit race
            streamWorker.terminate();
          }
          cleanup();
        }
      });

      Object.defineProperty(readable, 'returnValue', {
        get: () => returnValue
      });

      // ReadableStream is async iterable in Node.js
      return readable as StreamResult<T>;
    }
  };

  return executor;
}

// ============================================================================
// STREAM RUNNER
// ============================================================================

/** Generator function type */
type GeneratorFunction<T = unknown> = (...args: any[]) => Generator<T, any, any> | AsyncGenerator<T, any, any>;

/** Extract yield type from generator */
type YieldType<T> = T extends (...args: any[]) => Generator<infer Y, any, any> ? Y :
                    T extends (...args: any[]) => AsyncGenerator<infer Y, any, any> ? Y : unknown;

/**
 * Creates a stream runner for a generator.
 * Type inference extracts yield type from the generator automatically.
 */
export function stream<T extends GeneratorFunction>(genFn: T): StreamExecutor<YieldType<T>> {
  validateFunction(genFn);
  return createStreamExecutor<YieldType<T>>({
    fnString: genFn.toString(),
    context: null,
    args: [],
    transfer: [],
    shouldReconstructBuffers: false
  });
}

