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
 * ## V8 Optimizations Applied
 *
 * - Monomorphic object shapes (all properties declared upfront)
 * - Raw for loops instead of .forEach/.map
 * - Stable shapes (no property addition/deletion after creation)
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

// Note: Error shape is defined inline in createSerializedError for V8 monomorphism

/**
 * Creates a serialized error with optional debug info.
 * V8: Uses monomorphic object shape.
 */
function createSerializedError(err: Error, source?: string | null): SerializedError {
  // V8: Create object with stable shape - all properties declared upfront
  const serialized: SerializedError = {
    name: err.name || 'Error',
    message: err.message || String(err),
    stack: err.stack,
    _sourceCode: (DEBUG_MODE && source) ? source : undefined,
    cause: undefined,
    errors: undefined
  };
  
  // Copy custom error properties (code, statusCode, etc.)
  // V8: Use raw for loop
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
 * Converts args to strings without .map() overhead.
 * V8: Pre-allocated array, raw for loop.
 */
function argsToStrings(args: unknown[]): string[] {
  const len = args.length;
  const result = new Array<string>(len);
  for (let i = 0; i < len; i++) {
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
 * 
 * V8: Uses monomorphic object shape.
 */
function serializeError(e: unknown): SerializedError {
  // V8: Monomorphic object shape - all properties declared upfront
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
      const len = errArray.length;
      const serializedErrors = new Array(len);
      for (let j = 0; j < len; j++) {
        serializedErrors[j] = serializeError(errArray[j]);
      }
      serialized.errors = serializedErrors;
    }
    
    // Copy custom properties (like code, statusCode, etc.)
    // V8: Raw for loop
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
      const len = errArray.length;
      const serializedErrors = new Array(len);
      for (let j = 0; j < len; j++) {
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
const PATTERNS_LEN = VALID_FUNCTION_PATTERNS.length;

/** Cache of validated function sources */
const validatedSources = new Set<string>();
const MAX_VALIDATION_CACHE = 200;

/** Low memory mode flag from worker data */
const lowMemoryMode = workerConfig.lowMemoryMode || false;

/**
 * Validates source looks like a valid function (with caching).
 * V8: Raw for loop with early break.
 */
function validateFunctionSource(src: unknown): asserts src is string {
  if (typeof src !== 'string') {
    throw new TypeError('Function source must be a string');
  }

  // Fast path: already validated (skip in low memory mode)
  if (!lowMemoryMode && validatedSources.has(src)) {
    return;
  }

  // Only trim if needed (most functions don't have leading/trailing whitespace)
  const firstChar = src.charCodeAt(0);
  const trimmed = (firstChar === 32 || firstChar === 9 || firstChar === 10 || firstChar === 13)
    ? src.trim()
    : src;

  // V8: Manual loop with early return (faster than .some())
  let isValid = false;
  for (let i = 0; i < PATTERNS_LEN; i++) {
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
 * V8: Raw for loop.
 */
function applyCurried(fn: Function, args: unknown[]): unknown {
  // No args - just call the function
  const argsLen = args ? args.length : 0;
  if (argsLen === 0) {
    return fn();
  }

  // Try normal function call first (multi-arg)
  let result = fn(...args);

  // If result is still a function, we might have a curried function
  if (typeof result === 'function' && argsLen > 1) {
    // Try curried application
    result = fn;
    for (let i = 0; i < argsLen; i++) {
      if (typeof result !== 'function') break;
      result = (result as Function)(args[i]);
    }
  }

  return result;
}

// ============================================================================
// TURBO MODE HANDLER
// ============================================================================

// Pack types for serialization
type PackType = 'none' | 'number' | 'string' | 'object' | 'shared';

// Packed number array structure (V8: stable shape)
interface PackedNumberArray {
  readonly type: 0x01;
  readonly length: number;
  readonly data: Float64Array;
}

// Packed string array structure (V8: stable shape)
interface PackedStringArray {
  readonly type: 0x02;
  readonly length: number;
  readonly data: Uint8Array;
  readonly offsets: Uint32Array;
  readonly lengths: Uint32Array;
}

/**
 * Turbo message interface.
 * V8: Stable shape for all turbo messages.
 */
interface TurboMessage {
  type: 'turbo_map' | 'turbo_filter' | 'turbo_reduce';
  fn: string;
  chunk?: unknown;
  startIndex?: number;
  endIndex?: number;
  workerId: number;
  totalWorkers: number;
  context?: Record<string, unknown>;
  inputBuffer?: SharedArrayBuffer;
  outputBuffer?: SharedArrayBuffer;
  controlBuffer?: SharedArrayBuffer;
  initialValue?: unknown;
  /** Serialization type used */
  packType?: PackType;
  /** Packed object array data */
  packedData?: PackedData;
  /** Packed number array data */
  packedNumbers?: PackedNumberArray;
  /** Packed string array data */
  packedStrings?: PackedStringArray;
}

// ============================================================================
// AUTOPACK SUPPORT - Generic unpack for turbo mode
// ============================================================================

interface PackedSchema {
  numericFields: Array<{ name: string }>;
  stringFields: Array<{ name: string }>;
  booleanFields: Array<{ name: string }>;
}

interface PackedData {
  schema: PackedSchema;
  length: number;
  numbers: Float64Array;
  strings: Uint8Array;
  stringOffsets: Uint32Array;
  stringLengths: Uint16Array;
  booleans: Uint8Array;
}

/**
 * Unpacks AutoPack data back into objects.
 * Used by turbo mode when receiving packed data from main thread.
 */
function genericUnpack(packed: PackedData): Record<string, unknown>[] {
  const { schema, length, numbers, strings, stringOffsets, stringLengths, booleans } = packed;
  const { numericFields, stringFields, booleanFields } = schema;
  if (length === 0) return [];
  
  const result: Record<string, unknown>[] = new Array(length);
  const decoder = new TextDecoder();
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  for (let i = 0; i < length; i++) {
    const obj: Record<string, unknown> = {};
    for (let f = 0; f < numCount; f++) {
      obj[numericFields[f].name] = numbers[f * length + i];
    }
    for (let f = 0; f < strCount; f++) {
      const idx = f * length + i;
      const offset = stringOffsets[idx];
      const len = stringLengths[idx];
      obj[stringFields[f].name] = decoder.decode(strings.subarray(offset, offset + len));
    }
    for (let f = 0; f < boolCount; f++) {
      const bitIndex = f * length + i;
      obj[booleanFields[f].name] = (booleans[Math.floor(bitIndex / 8)] & (1 << (bitIndex % 8))) !== 0;
    }
    result[i] = obj;
  }
  return result;
}

/**
 * Unpacks number array from Float64Array.
 * V8: Loop unrolling 4x.
 */
function unpackNumbers(packed: PackedNumberArray): number[] {
  const len = packed.length;
  if (len === 0) return [];
  
  const data = packed.data;
  const result: number[] = new Array(len);
  
  // V8: Process in blocks of 4
  const blockEnd = len & ~3;
  let i = 0;
  
  for (; i < blockEnd; i += 4) {
    result[i] = data[i];
    result[i + 1] = data[i + 1];
    result[i + 2] = data[i + 2];
    result[i + 3] = data[i + 3];
  }
  
  for (; i < len; i++) {
    result[i] = data[i];
  }
  
  return result;
}

// V8: Cached decoder instance (avoid allocation per call)
const stringDecoder = new TextDecoder();

/**
 * Unpacks string array from packed format.
 * V8: Loop unrolling for 4x throughput.
 */
function unpackStrings(packed: PackedStringArray): string[] {
  const len = packed.length;
  if (len === 0) return [];
  
  const data = packed.data;
  const offsets = packed.offsets;
  const lengths = packed.lengths;
  const result: string[] = new Array(len);
  
  // V8: Process in blocks of 4
  const blockEnd = len & ~3;
  let i = 0;
  
  for (; i < blockEnd; i += 4) {
    const o0 = offsets[i];
    const o1 = offsets[i + 1];
    const o2 = offsets[i + 2];
    const o3 = offsets[i + 3];
    const l0 = lengths[i];
    const l1 = lengths[i + 1];
    const l2 = lengths[i + 2];
    const l3 = lengths[i + 3];
    
    result[i] = stringDecoder.decode(data.subarray(o0, o0 + l0));
    result[i + 1] = stringDecoder.decode(data.subarray(o1, o1 + l1));
    result[i + 2] = stringDecoder.decode(data.subarray(o2, o2 + l2));
    result[i + 3] = stringDecoder.decode(data.subarray(o3, o3 + l3));
  }
  
  // V8: Handle remainder
  for (; i < len; i++) {
    const o = offsets[i];
    result[i] = stringDecoder.decode(data.subarray(o, o + lengths[i]));
  }
  
  return result;
}

function isTurboMessage(msg: unknown): msg is TurboMessage {
  return msg !== null && typeof msg === 'object' && 'type' in msg &&
    ((msg as TurboMessage).type === 'turbo_map' || 
     (msg as TurboMessage).type === 'turbo_filter' || 
     (msg as TurboMessage).type === 'turbo_reduce');
}

/**
 * Handles turbo mode messages for parallel array processing.
 * V8: Raw for loops, pre-allocated arrays.
 */
function handleTurboMessage(message: TurboMessage): void {
  const { type, fn: fnSrc, chunk, startIndex, endIndex, context, inputBuffer, outputBuffer, controlBuffer: turboControl, initialValue } = message;

  try {
    // Compile the function
    const fn = fnCache.getOrCompile(fnSrc, context);

    if (typeof fn !== 'function') {
      throw new TypeError('Turbo function did not compile correctly');
    }

    // SharedArrayBuffer mode (for TypedArrays)
    if (inputBuffer && outputBuffer) {
      // Detect the TypedArray type from buffer size and indices
      const inputView = new Float64Array(inputBuffer);
      const outputView = new Float64Array(outputBuffer);
      const start = startIndex ?? 0;
      const end = endIndex ?? inputView.length;

      if (type === 'turbo_map') {
        // V8: Raw for loop - fastest iteration
        for (let i = start; i < end; i++) {
          outputView[i] = fn(inputView[i], i);
        }
      }

      // Signal completion via Atomics
      if (turboControl) {
        const cv = new Int32Array(turboControl);
        Atomics.add(cv, 0, 1);
        Atomics.notify(cv, 0);
      }

      port.postMessage({
        type: 'turbo_complete',
        workerId: message.workerId,
        itemsProcessed: end - start
      });
      return;
    }

    // Determine the chunk based on pack type
    let actualChunk: unknown[];
    const packType = message.packType || 'none';
    
    if (packType === 'number' && message.packedNumbers) {
      // Number array was packed
      actualChunk = unpackNumbers(message.packedNumbers);
    } else if (packType === 'string' && message.packedStrings) {
      // String array was packed
      actualChunk = unpackStrings(message.packedStrings);
    } else if (packType === 'object' && message.packedData) {
      // Object array was packed
      actualChunk = genericUnpack(message.packedData);
    } else if (chunk) {
      // Regular chunk (no packing)
      actualChunk = chunk as unknown[];
    } else {
      throw new Error('Turbo message missing chunk data');
    }
    
    const chunkLen = actualChunk.length;
    let result: unknown[];

    if (type === 'turbo_map') {
      result = new Array(chunkLen);
      for (let i = 0; i < chunkLen; i++) {
        result[i] = fn(actualChunk[i], i);
      }
    } else if (type === 'turbo_filter') {
      result = [];
      for (let i = 0; i < chunkLen; i++) {
        if (fn(actualChunk[i], i)) {
          result.push(actualChunk[i]);
        }
      }
    } else if (type === 'turbo_reduce') {
      let acc = initialValue;
      for (let i = 0; i < chunkLen; i++) {
        acc = fn(acc, actualChunk[i], i);
      }
      result = [acc];
    } else {
      throw new Error(`Unknown turbo type: ${type}`);
    }

    port.postMessage({
      type: 'turbo_complete',
      workerId: message.workerId,
      result: result,
      itemsProcessed: chunkLen
    });
    return;

  } catch (e) {
    port.postMessage({
      type: 'turbo_error',
      workerId: message.workerId,
      error: serializeError(e),
      itemsProcessed: 0
    });
  }
}

// ============================================================================
// MESSAGE PROCESSING
// ============================================================================

/**
 * Processes a single message from the main thread.
 * V8: Extracted for inlining and stable call site.
 */
function processMessage(message: WorkerMessage | TurboMessage): void {
  // Handle turbo messages
  if (isTurboMessage(message)) {
    handleTurboMessage(message);
    return;
  }

  const { fn: src, args, context } = message as WorkerMessage;
  
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
}

// ============================================================================
// MESSAGE LOOP - ATOMICS OPTIMIZED
// ============================================================================

// Start listening for messages
port.on('message', processMessage);
