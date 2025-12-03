/**
 * @fileoverview Stream executor for generator functions.
 *
 * Fluent API:
 * - `.usingParams(...args)` - set generator arguments
 * - `.setContext({...})` - inject closure variables
 * - `.execute()` - start streaming
 *
 * @module bee-threads/stream-executor
 */

import { Worker } from 'worker_threads';
import { requestWorker, releaseWorker } from './pool';
import { validateFunction } from './validation';
import { WorkerError } from './errors';
import type { GeneratorMessage, WorkerEntry, WorkerLogMessage } from './types';

// ============================================================================
// STREAM EXECUTOR TYPES
// ============================================================================

interface StreamExecutorState {
  fnString: string;
  context: Record<string, unknown> | null;
  args: unknown[];
  transfer: ArrayBuffer[];
}

export interface StreamExecutor<T = unknown> {
  usingParams(...params: unknown[]): StreamExecutor<T>;
  setContext(ctx: Record<string, unknown>): StreamExecutor<T>;
  transfer(list: ArrayBuffer[]): StreamExecutor<T>;
  execute(): ReadableStream<T> & { returnValue?: T };
}

// ============================================================================
// STREAM EXECUTOR FACTORY
// ============================================================================

/**
 * Creates a stream executor for generators.
 */
export function createStreamExecutor<T = unknown>(state: StreamExecutorState): StreamExecutor<T> {
  const { fnString, context, args, transfer } = state;

  const executor: StreamExecutor<T> = {
    /**
     * Sets generator arguments.
     */
    usingParams(...params: unknown[]): StreamExecutor<T> {
      return createStreamExecutor<T>({
        fnString,
        context,
        args: [...args, ...params],
        transfer
      });
    },

    /**
     * Injects closure variables.
     */
    setContext(ctx: Record<string, unknown>): StreamExecutor<T> {
      if (typeof ctx !== 'object' || ctx === null) {
        throw new TypeError('setContext() requires a non-null object');
      }
      return createStreamExecutor<T>({
        fnString,
        context: ctx,
        args,
        transfer
      });
    },

    /**
     * Specifies transferable objects for zero-copy transfer.
     */
    transfer(list: ArrayBuffer[]): StreamExecutor<T> {
      return createStreamExecutor<T>({
        fnString,
        context,
        args,
        transfer: list
      });
    },

    /**
     * Starts streaming the generator.
     */
    execute(): ReadableStream<T> & { returnValue?: T } {
      let streamWorker: Worker | null = null;
      let workerEntry: WorkerEntry | null = null;
      let isTemporary = false;
      let closed = false;
      let returnValue: T | undefined = undefined;

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
              if (msg.type === 'log') {
                const logMsg = msg as WorkerLogMessage;
                const logFn = (console as unknown as Record<string, Function>)[logMsg.level] || console.log;
                logFn('[worker]', ...logMsg.args);
                return;
              }

              switch (msg.type) {
                case 'yield':
                  controller.enqueue(msg.value as T);
                  break;
                case 'return':
                  returnValue = msg.value as T;
                  break;
                case 'end':
                  controller.close();
                  cleanup();
                  break;
                case 'error':
                  const err = new WorkerError(msg.error.message);
                  err.name = msg.error.name || 'Error';
                  if (msg.error.stack) err.stack = msg.error.stack;
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
              if (code !== 0) {
                controller.error(new WorkerError(`Worker exited with code ${code}`));
              }
              cleanup();
            });

            const message = { fn: fnString, args, context };
            transfer.length > 0
              ? streamWorker.postMessage(message, transfer)
              : streamWorker.postMessage(message);
          } catch (err) {
            controller.error(err);
            cleanup();
          }
        },

        cancel() {
          if (streamWorker && !closed) streamWorker.terminate();
          cleanup();
        }
      });

      Object.defineProperty(readable, 'returnValue', {
        get: () => returnValue
      });

      return readable as ReadableStream<T> & { returnValue?: T };
    }
  };

  return executor;
}

// ============================================================================
// STREAM RUNNER
// ============================================================================

/**
 * Creates a stream runner for a generator.
 */
export function stream<T = unknown>(genFn: Function): StreamExecutor<T> {
  validateFunction(genFn);
  return createStreamExecutor<T>({
    fnString: genFn.toString(),
    context: null,
    args: [],
    transfer: []
  });
}

