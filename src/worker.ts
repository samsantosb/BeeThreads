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
  // Monomorphic object shape - all properties declared upfront to avoid hidden class transitions
  const serialized: SerializedError = {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack,
    _sourceCode: (DEBUG_MODE && source) ? source : undefined,
    cause: undefined,
    errors: undefined
  };
  
  // Copy custom error properties (code, statusCode, etc.)
  const errKeys = Object.keys(err);
  for (let i = 0, len = errKeys.length; i < len; i++) {
    const key = errKeys[i];
    if (key !== 'name' && key !== 'message' && key !== 'stack') {
      const value = (err as unknown as Record<string, unknown>)[key];
      if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        (serialized as unknown as Record<string, unknown>)[key] = value;
      }
    }
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
// Helper to convert args to strings without .map() overhead
function argsToStrings(args: unknown[]): string[] {
  const result = new Array<string>(args.length);
  for (let i = 0, len = args.length; i < len; i++) {
    result[i] = String(args[i]);
  }
  return result;
}

console.log = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.LOG, args: argsToStrings(args) });
};

console.warn = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.WARN, args: argsToStrings(args) });
};

console.error = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.ERROR, args: argsToStrings(args) });
};

console.info = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.INFO, args: argsToStrings(args) });
};

console.debug = (...args: unknown[]): void => {
  port.postMessage({ type: MessageType.LOG, level: LogLevel.DEBUG, args: argsToStrings(args) });
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
  // Monomorphic object shape - all properties declared upfront
  const serialized: SerializedError = {
    name: 'Error',
    message: '',
    stack: undefined,
    _sourceCode: (DEBUG_MODE && currentFnSource) ? currentFnSource : undefined,
    cause: undefined,
    errors: undefined
  };
  
  // Check for error-like objects (has name and message properties)
  if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
    const err = e as Record<string, unknown>;
    serialized.name = String(err.name);
    serialized.message = String(err.message);
    serialized.stack = err.stack as string | undefined;
    
    // Preserve Error.cause (ES2022) - serialize recursively
    if ('cause' in err && err.cause != null) {
      serialized.cause = serializeError(err.cause);
    }
    
    // Preserve AggregateError.errors - serialize each error
    if ('errors' in err && Array.isArray(err.errors)) {
      const errArray = err.errors;
      const serializedErrors = new Array(errArray.length);
      for (let j = 0, jlen = errArray.length; j < jlen; j++) {
        serializedErrors[j] = serializeError(errArray[j]);
      }
      serialized.errors = serializedErrors;
    }
    
    // Copy custom properties (like code, statusCode, etc.)
    const errObjKeys = Object.keys(err);
    for (let i = 0, len = errObjKeys.length; i < len; i++) {
      const key = errObjKeys[i];
      if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause' && key !== 'errors') {
        const value = err[key];
        // Only copy serializable primitives
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          (serialized as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  // For non-error objects, try to get useful information
  else if (e instanceof Error) {
    serialized.name = e.name;
    serialized.message = e.message;
    serialized.stack = e.stack;
    
    // Preserve cause
    if (e.cause != null) {
      serialized.cause = serializeError(e.cause);
    }
    
    // Preserve AggregateError.errors
    if (e instanceof AggregateError) {
      const errArray = e.errors;
      const serializedErrors = new Array(errArray.length);
      for (let j = 0, jlen = errArray.length; j < jlen; j++) {
        serializedErrors[j] = serializeError(errArray[j]);
      }
      serialized.errors = serializedErrors;
    }
    
    // Copy custom properties from Error instance
    const errorKeys = Object.keys(e);
    for (let i = 0, len = errorKeys.length; i < len; i++) {
      const key = errorKeys[i];
      if (key !== 'name' && key !== 'message' && key !== 'stack' && key !== 'cause' && key !== 'errors') {
        const value = (e as unknown as Record<string, unknown>)[key];
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          (serialized as unknown as Record<string, unknown>)[key] = value;
        }
      }
    }
  }
  else {
    serialized.message = String(e);
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

  // Manual loop with early return (faster than .some())
  let isValid = false;
  for (let i = 0, len = VALID_FUNCTION_PATTERNS.length; i < len; i++) {
    if (VALID_FUNCTION_PATTERNS[i].test(trimmed)) {
      isValid = true;
      break;
    }
  }
  if (!isValid) {
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
    for (let i = 0, len = args.length; i < len; i++) {
      if (typeof result !== 'function') break;
      result = (result as Function)(args[i]);
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
    if (ret && typeof ret === 'object' && 'then' in ret && typeof (ret as Promise<unknown>).then === 'function') {
      (ret as Promise<unknown>)
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

