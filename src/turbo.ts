/**
 * @fileoverview beeThreads.turbo - Parallel Array Processing
 * 
 * V8-OPTIMIZED: Raw for loops, monomorphic shapes, zero hidden class transitions
 * 
 * @example
 * ```typescript
 * // New syntax - array first, function in method
 * const squares = await beeThreads.turbo(numbers).map(x => x * x)
 * const evens = await beeThreads.turbo(numbers).filter(x => x % 2 === 0)
 * const sum = await beeThreads.turbo(numbers).reduce((a, b) => a + b, 0)
 * ```
 * 
 * @module bee-threads/turbo
 */

import { config } from './config';
import { requestWorker, releaseWorker, fastHash } from './pool';

// ============================================================================
// CONSTANTS (V8: const for inline caching)
// ============================================================================

const TURBO_THRESHOLD = 10_000;
const MIN_ITEMS_PER_WORKER = 1_000;

// ============================================================================
// TYPES
// ============================================================================

export interface TurboOptions {
  workers?: number;
  chunkSize?: number;
  force?: boolean;
  context?: Record<string, unknown>;
}

export interface TurboStats {
  totalItems: number;
  workersUsed: number;
  itemsPerWorker: number;
  usedSharedMemory: boolean;
  executionTime: number;
  speedupRatio: string;
}

export interface TurboResult<T> {
  data: T[];
  stats: TurboStats;
}

// Monomorphic message shape - all properties declared upfront
interface TurboWorkerMessage {
  type: 'turbo_map' | 'turbo_reduce' | 'turbo_filter';
  fn: string;
  startIndex: number;
  endIndex: number;
  workerId: number;
  totalWorkers: number;
  context: Record<string, unknown> | undefined;
  inputBuffer: SharedArrayBuffer | undefined;
  outputBuffer: SharedArrayBuffer | undefined;
  controlBuffer: SharedArrayBuffer | undefined;
  chunk: unknown[] | undefined;
  initialValue: unknown | undefined;
}

// Monomorphic response shape
interface TurboWorkerResponse {
  type: 'turbo_complete' | 'turbo_error';
  workerId: number;
  result: unknown[] | undefined;
  error: { name: string; message: string; stack: string | undefined } | undefined;
  itemsProcessed: number;
}

// ============================================================================
// TYPED ARRAY DETECTION (V8: for loop, no .some())
// ============================================================================

const TYPED_ARRAY_CONSTRUCTORS = [
  Float64Array, Float32Array,
  Int32Array, Int16Array, Int8Array,
  Uint32Array, Uint16Array, Uint8Array, Uint8ClampedArray
];

type NumericTypedArray = 
  | Float64Array | Float32Array
  | Int32Array | Int16Array | Int8Array
  | Uint32Array | Uint16Array | Uint8Array | Uint8ClampedArray;

function isTypedArray(value: unknown): value is NumericTypedArray {
  if (value === null || typeof value !== 'object') return false;
  const len = TYPED_ARRAY_CONSTRUCTORS.length;
  for (let i = 0; i < len; i++) {
    if (value instanceof TYPED_ARRAY_CONSTRUCTORS[i]) return true;
  }
  return false;
}


// ============================================================================
// TURBO EXECUTOR - NEW SYNTAX: turbo(arr).map(fn)
// ============================================================================

export interface TurboExecutor<TItem> {
  map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]>;
  mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>>;
  filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]>;
  reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult>;
}

/**
 * Creates a TurboExecutor for parallel array processing.
 * 
 * @param data - Array or TypedArray to process
 * @param options - Turbo execution options
 * @returns TurboExecutor with map, filter, reduce methods
 * 
 * @example
 * ```typescript
 * const squares = await beeThreads.turbo(numbers).map(x => x * x)
 * const evens = await beeThreads.turbo(numbers).filter(x => x % 2 === 0)
 * const sum = await beeThreads.turbo(numbers).reduce((a, b) => a + b, 0)
 * ```
 */
export function createTurboExecutor<TItem>(
  data: TItem[] | NumericTypedArray,
  options: TurboOptions = {}
): TurboExecutor<TItem> {
  // V8: Monomorphic object shape - all methods declared upfront
  const executor: TurboExecutor<TItem> = {
    map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]> {
      const fnString = fn.toString();
      return executeTurboMap<TResult>(fnString, data as unknown[], options);
    },

    mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>> {
      const fnString = fn.toString();
      const startTime = Date.now();
      return executeTurboMapWithStats<TResult>(fnString, data as unknown[], options, startTime);
    },

    filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]> {
      const fnString = fn.toString();
      return executeTurboFilter<TItem>(fnString, data as unknown[], options);
    },

    reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult> {
      const fnString = fn.toString();
      return executeTurboReduce<TResult>(fnString, data as unknown[], initialValue, options);
    }
  };

  return executor;
}

// ============================================================================
// CORE EXECUTION - V8 OPTIMIZED
// ============================================================================

async function executeTurboMap<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions
): Promise<T[]> {
  const result = await executeTurboMapWithStats<T>(fnString, data, options, Date.now());
  return result.data;
}

async function executeTurboMapWithStats<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;
  const isTyped = isTypedArray(data);

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    return fallbackSingleExecution<T>(fnString, data, options, startTime);
  }

  // Calculate workers (V8: simple math, no method chains)
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const actualWorkers = numWorkers > 1 ? numWorkers : 1;
  const chunkSize = options.chunkSize !== undefined ? options.chunkSize : Math.ceil(dataLength / actualWorkers);

  // TypedArray path - SharedArrayBuffer
  if (isTyped) {
    return executeTurboTypedArray<T>(fnString, data as NumericTypedArray, actualWorkers, chunkSize, options, startTime);
  }

  // Regular array path
  return executeTurboRegularArray<T>(fnString, data, actualWorkers, chunkSize, options, startTime);
}

// ============================================================================
// TYPED ARRAY EXECUTION - SHARED MEMORY
// ============================================================================

async function executeTurboTypedArray<T>(
  fnString: string,
  data: NumericTypedArray,
  numWorkers: number,
  chunkSize: number,
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;

  // Create SharedArrayBuffers (V8: direct construction)
  const inputBuffer = new SharedArrayBuffer(dataLength * 8);
  const outputBuffer = new SharedArrayBuffer(dataLength * 8);
  const controlBuffer = new SharedArrayBuffer(4);

  // Copy input data (V8: raw for loop)
  const inputView = new Float64Array(inputBuffer);
  for (let i = 0; i < dataLength; i++) {
    inputView[i] = data[i];
  }

  const outputView = new Float64Array(outputBuffer);
  const controlView = new Int32Array(controlBuffer);
  Atomics.store(controlView, 0, 0);

  // Dispatch to workers (V8: pre-allocated array)
  const promises: Promise<void>[] = new Array(numWorkers);
  let workerCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const actualEnd = end < dataLength ? end : dataLength;

    if (start >= dataLength) break;

    // V8: Monomorphic message shape
    const message: TurboWorkerMessage = {
      type: 'turbo_map',
      fn: fnString,
      startIndex: start,
      endIndex: actualEnd,
      workerId: i,
      totalWorkers: numWorkers,
      context: options.context,
      inputBuffer: inputBuffer,
      outputBuffer: outputBuffer,
      controlBuffer: controlBuffer,
      chunk: undefined,
      initialValue: undefined
    };

    promises[i] = executeWorkerTurbo(fnString, message);
    workerCount++;
  }

  // Wait for completion (V8: slice to actual size)
  await Promise.all(promises.slice(0, workerCount));

  // Build result (V8: pre-allocated array)
  const result: T[] = new Array(dataLength);
  for (let i = 0; i < dataLength; i++) {
    result[i] = outputView[i] as unknown as T;
  }

  const executionTime = Date.now() - startTime;
  const estimatedSingle = executionTime * workerCount * 0.8;

  // V8: Monomorphic stats shape
  const stats: TurboStats = {
    totalItems: dataLength,
    workersUsed: workerCount,
    itemsPerWorker: Math.ceil(dataLength / workerCount),
    usedSharedMemory: true,
    executionTime: executionTime,
    speedupRatio: (estimatedSingle / executionTime).toFixed(1) + 'x'
  };

  return { data: result, stats: stats };
}

// ============================================================================
// REGULAR ARRAY EXECUTION - CHUNK BASED
// ============================================================================

async function executeTurboRegularArray<T>(
  fnString: string,
  data: unknown[],
  numWorkers: number,
  chunkSize: number,
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;

  // Build chunks (V8: pre-allocated, raw for loop)
  const maxChunks = Math.ceil(dataLength / chunkSize);
  const chunks: unknown[][] = new Array(maxChunks);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const actualEnd = end < dataLength ? end : dataLength;

    if (start >= dataLength) break;

    // V8: slice is optimized, but we track bounds manually
    chunks[i] = data.slice(start, actualEnd);
    chunkCount++;
  }

  // Fail-fast state
  let aborted = false;
  let firstError: Error | null = null;
  const cleanupFns: Array<() => void> = new Array(chunkCount);
  let cleanupCount = 0;

  // Dispatch workers (V8: pre-allocated promises)
  const promises: Promise<T[]>[] = new Array(chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    const chunk = chunks[i];
    const workerId = i;

    promises[i] = executeWorkerTurboChunk<T>(
      fnString,
      chunk,
      workerId,
      chunkCount,
      options.context,
      () => aborted,
      (cleanup: () => void) => { cleanupFns[cleanupCount++] = cleanup; }
    ).catch((err: Error) => {
      if (!aborted) {
        aborted = true;
        firstError = err;
      }
      throw err;
    });
  }

  // Wait for all
  let chunkResults: T[][];
  try {
    chunkResults = await Promise.all(promises);
  } catch (err) {
    // Cleanup (V8: raw for loop)
    for (let i = 0; i < cleanupCount; i++) {
      try { cleanupFns[i](); } catch { /* ignore */ }
    }
    throw firstError !== null ? firstError : err;
  }

  // Merge results (V8: calculate total size first, then fill)
  let totalSize = 0;
  for (let i = 0; i < chunkCount; i++) {
    totalSize += chunkResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  let idx = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunkResult = chunkResults[i];
    const chunkLen = chunkResult.length;
    for (let j = 0; j < chunkLen; j++) {
      result[idx++] = chunkResult[j];
    }
  }

  const executionTime = Date.now() - startTime;
  const estimatedSingle = executionTime * chunkCount * 0.7;

  const stats: TurboStats = {
    totalItems: dataLength,
    workersUsed: chunkCount,
    itemsPerWorker: Math.ceil(dataLength / chunkCount),
    usedSharedMemory: false,
    executionTime: executionTime,
    speedupRatio: (estimatedSingle / executionTime).toFixed(1) + 'x'
  };

  return { data: result, stats: stats };
}

// ============================================================================
// FILTER EXECUTION
// ============================================================================

async function executeTurboFilter<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions
): Promise<T[]> {
  const dataLength = data.length;

  // Small array fallback (V8: inline function creation)
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    const result: T[] = [];
    for (let i = 0; i < dataLength; i++) {
      if (fn(data[i], i)) {
        result.push(data[i] as T);
      }
    }
    return result;
  }

  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const chunkSize = Math.ceil(dataLength / numWorkers);

  // Build chunks
  const chunks: unknown[][] = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const actualEnd = end < dataLength ? end : dataLength;
    if (start >= dataLength) break;
    chunks[i] = data.slice(start, actualEnd);
    chunkCount++;
  }

  // Execute in parallel
  const promises: Promise<unknown[]>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    promises[i] = executeWorkerTurboFilterChunk(fnString, chunks[i], i, chunkCount, options.context);
  }

  const chunkResults = await Promise.all(promises);

  // Merge (V8: calculate size first)
  let totalSize = 0;
  for (let i = 0; i < chunkCount; i++) {
    totalSize += chunkResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  let idx = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunkResult = chunkResults[i];
    const chunkLen = chunkResult.length;
    for (let j = 0; j < chunkLen; j++) {
      result[idx++] = chunkResult[j] as T;
    }
  }

  return result;
}

// ============================================================================
// REDUCE EXECUTION
// ============================================================================

async function executeTurboReduce<R>(
  fnString: string,
  data: unknown[],
  initialValue: R,
  options: TurboOptions
): Promise<R> {
  const dataLength = data.length;

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    let acc = initialValue;
    for (let i = 0; i < dataLength; i++) {
      acc = fn(acc, data[i], i);
    }
    return acc;
  }

  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const chunkSize = Math.ceil(dataLength / numWorkers);

  // Build chunks
  const chunks: unknown[][] = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    const end = start + chunkSize;
    const actualEnd = end < dataLength ? end : dataLength;
    if (start >= dataLength) break;
    chunks[i] = data.slice(start, actualEnd);
    chunkCount++;
  }

  // Phase 1: Parallel reduction per chunk
  const promises: Promise<R>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    promises[i] = executeWorkerTurboReduceChunk<R>(fnString, chunks[i], initialValue, i, chunkCount, options.context);
  }

  const chunkResults = await Promise.all(promises);

  // Phase 2: Final reduction (V8: raw for loop)
  const fn = new Function('return ' + fnString)();
  let result = initialValue;
  for (let i = 0; i < chunkCount; i++) {
    result = fn(result, chunkResults[i]);
  }

  return result;
}

// ============================================================================
// WORKER HELPERS - V8 OPTIMIZED
// ============================================================================

async function executeWorkerTurbo(
  fnString: string,
  message: TurboWorkerMessage
): Promise<void> {
  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'high', fnHash);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        resolve();
      } else if (msg.type === 'turbo_error') {
        cleanup();
        const err = new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error');
        err.name = msg.error !== undefined ? msg.error.name : 'TurboError';
        reject(err);
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage(message);
  });
}

async function executeWorkerTurboChunk<T>(
  fnString: string,
  chunk: unknown[],
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  shouldAbort: () => boolean,
  registerCleanup: (cleanup: () => void) => void
): Promise<T[]> {
  if (shouldAbort()) {
    throw new Error('Turbo execution aborted');
  }

  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'high', fnHash);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    registerCleanup(cleanup);

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (shouldAbort() && !settled) {
        cleanup();
        reject(new Error('Turbo execution aborted'));
        return;
      }

      if (msg.type === 'turbo_complete') {
        cleanup();
        resolve(msg.result as T[]);
      } else if (msg.type === 'turbo_error') {
        cleanup();
        const err = new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error');
        err.name = msg.error !== undefined ? msg.error.name : 'TurboWorkerError';
        reject(err);
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    // V8: Monomorphic message
    const message: TurboWorkerMessage = {
      type: 'turbo_map',
      fn: fnString,
      startIndex: 0,
      endIndex: 0,
      workerId: workerId,
      totalWorkers: totalWorkers,
      context: context,
      inputBuffer: undefined,
      outputBuffer: undefined,
      controlBuffer: undefined,
      chunk: chunk,
      initialValue: undefined
    };

    worker.postMessage(message);
  });
}

async function executeWorkerTurboFilterChunk(
  fnString: string,
  chunk: unknown[],
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined
): Promise<unknown[]> {
  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'high', fnHash);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        resolve(msg.result !== undefined ? msg.result : []);
      } else if (msg.type === 'turbo_error') {
        cleanup();
        reject(new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    worker.postMessage({
      type: 'turbo_filter',
      fn: fnString,
      chunk: chunk,
      workerId: workerId,
      totalWorkers: totalWorkers,
      context: context
    });
  });
}

async function executeWorkerTurboReduceChunk<R>(
  fnString: string,
  chunk: unknown[],
  initialValue: R,
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined
): Promise<R> {
  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'high', fnHash);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - startTime, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        const result = msg.result;
        resolve(result !== undefined && result.length > 0 ? result[0] as R : initialValue);
      } else if (msg.type === 'turbo_error') {
        cleanup();
        reject(new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    worker.postMessage({
      type: 'turbo_reduce',
      fn: fnString,
      chunk: chunk,
      initialValue: initialValue,
      workerId: workerId,
      totalWorkers: totalWorkers,
      context: context
    });
  });
}

// ============================================================================
// FALLBACK - SINGLE WORKER
// ============================================================================

async function fallbackSingleExecution<T>(
  fnString: string,
  data: unknown[],
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const fnHash = fastHash(fnString);
  const { entry, worker, temporary } = await requestWorker('normal', 'normal', fnHash);
  const dataLength = data.length;

  return new Promise((resolve, reject) => {
    const execStart = Date.now();
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      releaseWorker(entry, worker, temporary, 'normal', Date.now() - execStart, false, fnHash);
    };

    const onMessage = (msg: TurboWorkerResponse): void => {
      if (msg.type === 'turbo_complete') {
        cleanup();
        const executionTime = Date.now() - startTime;
        const stats: TurboStats = {
          totalItems: dataLength,
          workersUsed: 1,
          itemsPerWorker: dataLength,
          usedSharedMemory: false,
          executionTime: executionTime,
          speedupRatio: '1.0x'
        };
        resolve({ data: msg.result as T[], stats: stats });
      } else if (msg.type === 'turbo_error') {
        cleanup();
        reject(new Error(msg.error !== undefined ? msg.error.message : 'Turbo worker error'));
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);

    const chunk = isTypedArray(data) ? Array.from(data) : data;
    worker.postMessage({
      type: 'turbo_map',
      fn: fnString,
      chunk: chunk,
      workerId: 0,
      totalWorkers: 1,
      context: options.context
    });
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export { TURBO_THRESHOLD, MIN_ITEMS_PER_WORKER };
