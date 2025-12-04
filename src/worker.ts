/**
 * @fileoverview Worker thread for executing user functions.
 *
 * ## What This File Does
 *
 * This is the code that runs inside each worker thread. It:
 * 1. Receives function source + arguments + context from main thread
 * 2. Validates the function source (cached validation)
 * 3. Compiles using vm.Script with LRU caching
 * 4. Executes the function (handles async and curried)
 * 5. Sends result back to main thread
 *
 * @module bee-threads/worker
 */

import { parentPort, workerData } from 'worker_threads';
import { createFunctionCache } from './cache';
import { MessageType, LogLevel } from './types';
import type { WorkerMessage, SerializedError, FunctionCache } from './types';

// Type guard for parentPort (it's null in main thread)
if (!parentPort) {
  throw new Error('This file must be run as a worker thread');
}

const port = parentPort;

// ============================================================================
// WORKER DATA TYPES
// ============================================================================

interface WorkerConfig {
  functionCacheSize?: number;
  functionCacheTTL?: number;
  lowMemoryMode?: boolean;
  debugMode?: boolean;
}

const workerConfig = (workerData as WorkerConfig) || {};
const DEBUG_MODE = workerConfig.debugMode ?? false;

/** Current function being executed (for debug) */
let currentFnSource: string | null = null;

// ============================================================================
// GLOBAL ERROR HANDLERS - Prevent worker crash without response
// ============================================================================

/**
 * Creates a serialized error with optional debug info.
 */
function createSerializedError(err: Error, source?: string | null): SerializedError {
  const serialized: SerializedError = {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack
  };
  
  // Copy custom error properties (code, statusCode, etc.)
  for (const key of Object.keys(err)) {
    if (!['name', 'message', 'stack'].includes(key)) {
      const value = (err as unknown as Record<string, unknown>)[key];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
        (serialized as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  
  // Include source code in debug mode for easier debugging
  if (DEBUG_MODE && source) {
    serialized._sourceCode = source;
  }
  
  return serialized;
}

/**
 * Catches uncaught exceptions that would otherwise crash the worker.
 */
process.on('uncaughtException', (err: Error) => {
  try {
    port.postMessage({
      type: MessageType.ERROR,
      error: createSerializedError(err, currentFnSource)
    });
  } catch {
    // If we can't even send the message, exit gracefully
    process.exit(1);
  }
});

/**
 * Catches unhandled promise rejections.
 */
process.on('unhandledRejection', (reason: unknown) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    port.postMessage({
      type: MessageType.ERROR,
      error: createSerializedError(err, currentFnSource)
    });
  } catch {
    process.exit(1);
  }
});

// ============================================================================
// FUNCTION CACHE
// ============================================================================

const cacheSize = workerConfig.functionCacheSize || 100;
const cacheTTL = workerConfig.functionCacheTTL ?? 0;
const fnCache: FunctionCache = createFunctionCache(cacheSize, cacheTTL);

/** Expose cache for debugging via globalThis.BeeCache.stats() */
(globalThis as Record<string, unknown>).BeeCache = fnCache;

// ============================================================================
// CONSOLE REDIRECTION
// ============================================================================

/**
 * Redirects console.log/warn/error to main thread.
 */
console.log = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.LOG, args: args.map(String) });
};

console.warn = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.WARN, args: args.map(String) });
};

console.error = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.ERROR, args: args.map(String) });
};

console.info = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.INFO, args: args.map(String) });
};

console.debug = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.DEBUG, args: args.map(String) });
};

// ============================================================================
// ERROR SERIALIZATION
// ============================================================================

/**
 * Serializes error for transmission to main thread.
 *
 * ## Why We Check e.name Instead of instanceof
 *
 * Errors from vm.createContext() have a different Error class than
 * the main Node.js context. This means `e instanceof Error` returns
 * false even for real Error objects from the vm context.
 */
function serializeError(e: unknown): SerializedError {
  let serialized: SerializedError;
  
  // Check for error-like objects (has name and message properties)
  if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
    const err = e as Record<string, unknown>;
    serialized = { 
      name: String(err.name), 
      message: String(err.message), 
      stack: err.stack as string | undefined 
    };
    
    // Preserve Error.cause (ES2022) - serialize recursively
    if ('cause' in err && err.cause != null) {
      serialized.cause = serializeError(err.cause);
    }
    
    // Preserve AggregateError.errors - serialize each error
    if ('errors' in err && Array.isArray(err.errors)) {
      serialized.errors = err.errors.map(serializeError);
    }
    
    // Copy custom properties (like code, statusCode, etc.)
    for (const key of Object.keys(err)) {
      if (!['name', 'message', 'stack', 'cause', 'errors'].includes(key)) {
        const value = err[key];
        // Only copy serializable primitives
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          (serialized as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  // For non-error objects, try to get useful information
  else if (e instanceof Error) {
    serialized = { name: e.name, message: e.message, stack: e.stack };
    
    // Preserve cause
    if (e.cause != null) {
      serialized.cause = serializeError(e.cause);
    }
    
    // Preserve AggregateError.errors
    if (e instanceof AggregateError) {
      serialized.errors = e.errors.map(serializeError);
    }
    
    // Copy custom properties from Error instance
    for (const key of Object.keys(e)) {
      if (!['name', 'message', 'stack', 'cause', 'errors'].includes(key)) {
        const value = (e as unknown as Record<string, unknown>)[key];
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
          (serialized as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  else {
    serialized = { name: 'Error', message: String(e) };
  }
  
  // Include source code in debug mode (use _sourceCode to avoid conflict with error.code)
  if (DEBUG_MODE && currentFnSource) {
    serialized._sourceCode = currentFnSource;
  }
  
  return serialized;
}

// ============================================================================
// FUNCTION VALIDATION (with caching)
// ============================================================================

/** Pre-compiled regex patterns for function validation */
const VALID_FUNCTION_PATTERNS: RegExp[] = [
  /^function\s*\w*\s*\(/,
  /^async\s+function\s*\w*\s*\(/,
  /^\(.*\)\s*=>/,
  /^\w+\s*=>/,
  /^async\s*\(.*\)\s*=>/,
  /^async\s+\w+\s*=>/,
  /^\(\s*\[/,
  /^\(\s*\{/,
];

/** Cache of validated function sources */
const validatedSources = new Set<string>();
const MAX_VALIDATION_CACHE = 200;

/** Low memory mode flag from worker data */
const lowMemoryMode = workerConfig.lowMemoryMode || false;

/**
 * Validates source looks like a valid function (with caching).
 */
function validateFunctionSource(src: unknown): asserts src is string {
  if (typeof src !== 'string') {
    throw new TypeError('Function source must be a string');
  }

  // Fast path: already validated (skip in low memory mode)
  if (!lowMemoryMode && validatedSources.has(src)) {
    return;
  }

  const trimmed = src.trim();

  if (!VALID_FUNCTION_PATTERNS.some(p => p.test(trimmed))) {
    throw new TypeError('Invalid function source');
  }

  // Cache this validation result (skip in low memory mode)
  if (!lowMemoryMode) {
    if (validatedSources.size >= MAX_VALIDATION_CACHE) {
      validatedSources.clear();
    }
    validatedSources.add(src);
  }
}

// ============================================================================
// CURRIED FUNCTION SUPPORT
// ============================================================================

/**
 * Applies arguments to a function, handling curried functions.
 */
function applyCurried(fn: Function, args: unknown[]): unknown {
  // No args - just call the function
  if (!args || args.length === 0) {
    return fn();
  }

  // Try normal function call first (multi-arg)
  let result = fn(...args);

  // If result is still a function, we might have a curried function
  if (typeof result === 'function' && args.length > 1) {
    // Try curried application
    result = fn;
    for (const arg of args) {
      if (typeof result !== 'function') break;
      result = (result as Function)(arg);
    }
  }

  return result;
}

// ============================================================================
// MESSAGE HANDLER
// ============================================================================

port.on('message', (message: WorkerMessage) => {
  const { fn: src, args, context } = message;
  
  // Store current function source for debug error messages
  currentFnSource = src;
  
  try {
    validateFunctionSource(src);

    // Get compiled function from cache (or compile and cache it)
    const fn = fnCache.getOrCompile(src, context);

    if (typeof fn !== 'function') {
      throw new TypeError('Evaluated source did not produce a function');
    }

    // Apply arguments (handles curried functions)
    const ret = applyCurried(fn, args);

    // Handle async results
    if (ret && ret instanceof Promise) {
      ret
        .then(v => {
          port.postMessage({ type: MessageType.SUCCESS, value: v });
        })
        .catch(e => {
          port.postMessage({ type: MessageType.ERROR, error: serializeError(e) });
        })
        .finally(() => {
          currentFnSource = null;
        });
    } else {
      port.postMessage({ type: MessageType.SUCCESS, value: ret });
      currentFnSource = null;
    }
  } catch (e) {
    port.postMessage({ type: MessageType.ERROR, error: serializeError(e) });
    currentFnSource = null;
  }
});

