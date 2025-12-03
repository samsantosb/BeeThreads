/**
 * @fileoverview Worker thread script for executing generator functions.
 *
 * This script handles generators and async generators, streaming
 * yielded values back to the main thread as they are produced.
 *
 * @module bee-threads/generator-worker
 */

import { parentPort, workerData } from 'worker_threads';
import { createFunctionCache } from './cache';
import type { WorkerMessage, SerializedError, FunctionCache } from './types';

// Type guard for parentPort
if (!parentPort) {
  throw new Error('This file must be run as a worker thread');
}

const port = parentPort;

// ============================================================================
// WORKER DATA TYPES
// ============================================================================

interface WorkerConfig {
  functionCacheSize?: number;
  lowMemoryMode?: boolean;
}

const workerConfig = (workerData as WorkerConfig) || {};

// ============================================================================
// GLOBAL ERROR HANDLERS - Prevent worker crash without response
// ============================================================================

process.on('uncaughtException', (err: Error) => {
  try {
    port.postMessage({
      type: 'error',
      error: {
        name: err.name || 'UncaughtException',
        message: err.message || String(err),
        stack: err.stack
      }
    });
  } catch {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason: unknown) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    port.postMessage({
      type: 'error',
      error: {
        name: err.name || 'UnhandledRejection',
        message: err.message || String(reason),
        stack: err.stack
      }
    });
  } catch {
    process.exit(1);
  }
});

// ============================================================================
// FUNCTION CACHE
// ============================================================================

const cacheSize = workerConfig.functionCacheSize || 100;
const fnCache: FunctionCache = createFunctionCache(cacheSize);

/** Expose cache for debugging */
(globalThis as Record<string, unknown>).BeeCache = fnCache;

// ============================================================================
// CONSOLE REDIRECTION
// ============================================================================

console.log = (...args: unknown[]): void => {
  port.postMessage({ type: 'log', level: 'log', args: args.map(String) });
};

console.warn = (...args: unknown[]): void => {
  port.postMessage({ type: 'log', level: 'warn', args: args.map(String) });
};

console.error = (...args: unknown[]): void => {
  port.postMessage({ type: 'log', level: 'error', args: args.map(String) });
};

console.info = (...args: unknown[]): void => {
  port.postMessage({ type: 'log', level: 'info', args: args.map(String) });
};

console.debug = (...args: unknown[]): void => {
  port.postMessage({ type: 'log', level: 'debug', args: args.map(String) });
};

// ============================================================================
// ERROR SERIALIZATION
// ============================================================================

function serializeError(e: unknown): SerializedError {
  if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
    const err = e as { name: string; message: string; stack?: string };
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (e instanceof Error) {
    return { name: e.name, message: e.message, stack: e.stack };
  }
  return { name: 'Error', message: String(e) };
}

// ============================================================================
// FUNCTION SOURCE VALIDATION (with caching)
// ============================================================================

const VALID_FUNCTION_PATTERNS: RegExp[] = [
  /^function\s*\*?\s*\w*\s*\(/,
  /^async\s+function\s*\*?\s*\w*\s*\(/,
  /^\(.*\)\s*=>/,
  /^\w+\s*=>/,
  /^async\s*\(.*\)\s*=>/,
  /^async\s+\w+\s*=>/,
  /^\(\s*\[/,
  /^\(\s*\{/,
];

const validatedSources = new Set<string>();
const MAX_VALIDATION_CACHE = 200;

function validateFunctionSource(src: unknown): asserts src is string {
  if (typeof src !== 'string') {
    throw new TypeError('Function source must be a string');
  }

  if (validatedSources.has(src)) {
    return;
  }

  const trimmed = src.trim();

  if (!VALID_FUNCTION_PATTERNS.some(p => p.test(trimmed))) {
    throw new TypeError('Invalid function source - does not appear to be a function');
  }

  if (validatedSources.size >= MAX_VALIDATION_CACHE) {
    const iterator = validatedSources.values();
    for (let i = 0; i < 50; i++) {
      const value = iterator.next().value;
      if (value) validatedSources.delete(value);
    }
  }
  validatedSources.add(src);
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

interface GeneratorLike {
  next(): IteratorResult<unknown, unknown>;
  return?(): IteratorResult<unknown, unknown>;
}

port.on('message', (message: WorkerMessage) => {
  const { fn: src, args, context } = message;

  try {
    validateFunctionSource(src);

    const fn = fnCache.getOrCompile(src, context);

    if (typeof fn !== 'function') {
      throw new TypeError('Evaluated source did not produce a function');
    }

    const gen = fn(...args) as GeneratorLike;

    if (!gen || typeof gen.next !== 'function') {
      throw new TypeError('Function must return a generator/iterator');
    }

    function step(next: IteratorResult<unknown, unknown>): void {
      if (next.done) {
        if (next.value !== undefined) {
          port.postMessage({ type: 'return', value: next.value });
        }
        port.postMessage({ type: 'end' });
        return;
      }

      const value = next.value;

      if (value && typeof value === 'object' && 'then' in value && typeof (value as Promise<unknown>).then === 'function') {
        (value as Promise<unknown>)
          .then(v => {
            port.postMessage({ type: 'yield', value: v });
            step(gen.next());
          })
          .catch(e => {
            port.postMessage({ type: 'error', error: serializeError(e) });
            try { gen.return?.(); } catch { /* ignore */ }
          });
      } else {
        port.postMessage({ type: 'yield', value });
        setImmediate(() => step(gen.next()));
      }
    }

    step(gen.next());
  } catch (e) {
    port.postMessage({ type: 'error', error: serializeError(e) });
  }
});

