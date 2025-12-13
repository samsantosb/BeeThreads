/**
 * @fileoverview beeThreads.turbo - Parallel Array Processing
 * 
 * V8-OPTIMIZED: Raw for loops, monomorphic shapes, zero hidden class transitions
 * Uses structuredClone for data transfer (V8 native, efficient for all data types)
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
import type { WorkerEntry, WorkerInfo } from './types';
import type { Worker } from 'worker_threads';

// ============================================================================
// CONSTANTS (V8: const for inline caching)
// ============================================================================

const TURBO_THRESHOLD = 10_000;
const MIN_ITEMS_PER_WORKER = 1_000;

// ============================================================================
// TYPES
// ============================================================================

export interface TurboOptions {
  /** Number of workers to use. Default: `os.cpus().length - 1` */
  workers?: number;
  /** Custom chunk size per worker. Default: auto-calculated */
  chunkSize?: number;
  /** Force parallel execution even for small arrays. Default: false */
  force?: boolean;
  /** Context variables to inject into worker function */
  context?: Record<string, unknown>;
}

export interface TurboStats {
  /** Total number of items processed */
  totalItems: number;
  /** Number of workers used */
  workersUsed: number;
  /** Average items per worker */
  itemsPerWorker: number;
  /** True if SharedArrayBuffer was used (TypedArrays) */
  usedSharedMemory: boolean;
  /** Total execution time in milliseconds */
  executionTime: number;
  /** Estimated speedup ratio vs single-threaded */
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
// TYPED ARRAY DETECTION - V8 OPTIMIZED
// ============================================================================

type NumericTypedArray = 
  | Float64Array | Float32Array
  | Int32Array | Int16Array | Int8Array
  | Uint32Array | Uint16Array | Uint8Array | Uint8ClampedArray;

/**
 * V8: ArrayBuffer.isView is fastest for TypedArray detection.
 * Excludes DataView via constructor name check.
 */
function isTypedArray(value: unknown): value is NumericTypedArray {
  // V8: Single call to native isView (C++ fast path)
  if (!ArrayBuffer.isView(value)) return false;
  // Exclude DataView (constructor.name[0] = 'D' = 68)
  return (value.constructor.name.charCodeAt(0) !== 68);
}


// ============================================================================
// TURBO EXECUTOR - NEW SYNTAX: turbo(arr).map(fn)
// ============================================================================

export interface TurboExecutor<TItem> {
  /** Set the number of workers to use. Returns a new executor. */
  setWorkers(count: number): TurboExecutor<TItem>;
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
    setWorkers(count: number): TurboExecutor<TItem> {
      if (!Number.isInteger(count) || count < 1) {
        throw new TypeError('setWorkers() requires a positive integer');
      }
      return createTurboExecutor<TItem>(data, { ...options, workers: count });
    },

    map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      return executeTurboMap<TResult>(fnString, fnHash, data as unknown[], options);
    },

    mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      const startTime = Date.now();
      return executeTurboMapWithStats<TResult>(fnString, fnHash, data as unknown[], options, startTime);
    },

    filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      return executeTurboFilter<TItem>(fnString, fnHash, data as unknown[], options);
    },

    reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      return executeTurboReduce<TResult>(fnString, fnHash, data as unknown[], initialValue, options);
    }
  };

  return executor;
}

// ============================================================================
// CORE EXECUTION - V8 OPTIMIZED
// ============================================================================

async function executeTurboMap<T>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  options: TurboOptions
): Promise<T[]> {
  const result = await executeTurboMapWithStats<T>(fnString, fnHash, data, options, Date.now());
  return result.data;
}

async function executeTurboMapWithStats<T>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;
  const isTyped = isTypedArray(data);

  // Small array fallback
  if (!options.force && dataLength < TURBO_THRESHOLD) {
    return fallbackSingleExecution<T>(fnString, fnHash, data, options, startTime);
  }

  // Calculate workers (V8: simple math, no method chains)
  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const actualWorkers = numWorkers > 1 ? numWorkers : 1;
  const chunkSize = options.chunkSize !== undefined ? options.chunkSize : Math.ceil(dataLength / actualWorkers);

  // TypedArray path - SharedArrayBuffer
  if (isTyped) {
    return executeTurboTypedArray<T>(fnString, fnHash, data as NumericTypedArray, actualWorkers, chunkSize, options, startTime);
  }

  // Regular array path (with AutoPack support)
  return executeTurboRegularArray<T>(fnString, fnHash, data, actualWorkers, chunkSize, options, startTime);
}

// ============================================================================
// TYPED ARRAY EXECUTION - SHARED MEMORY
// ============================================================================

async function executeTurboTypedArray<T>(
  fnString: string,
  fnHash: string,
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

    promises[i] = executeWorkerTurbo(fnHash, message);
    workerCount++;
  }

  // Wait for completion (no slice - use length check)
  if (workerCount === numWorkers) {
    await Promise.all(promises);
  } else {
    await Promise.all(promises.slice(0, workerCount));
  }

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
// REGULAR ARRAY EXECUTION - STRUCTUREDCLONE
// ============================================================================

async function executeTurboRegularArray<T>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  numWorkers: number,
  chunkSize: number,
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
  const dataLength = data.length;
  
  // Calculate chunk boundaries (V8: pre-allocated, no slice yet)
  const chunkBounds: Array<{ start: number; end: number }> = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // OPTIMIZATION 1: Batch worker acquisition - get all workers at once
  const workerRequests: Promise<WorkerInfo>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Fail-fast state
  let aborted = false;
  let firstError: Error | null = null;

  // OPTIMIZATION 2: Direct dispatch with pre-acquired workers
  const promises: Promise<T[]>[] = new Array(chunkCount);

  for (let i = 0; i < chunkCount; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];

    promises[i] = executeTurboChunkDirect<T>(
      fnString,
      fnHash,
      chunk,
      i,
      chunkCount,
      options.context,
      entry,
      worker,
      temporary,
      () => aborted
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
    throw firstError !== null ? firstError : err;
  }

  // OPTIMIZATION 3: Merge with pre-calculated offsets
  let totalSize = 0;
  const offsets: number[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    offsets[i] = totalSize;
    totalSize += chunkResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  for (let i = 0; i < chunkCount; i++) {
    const chunkResult = chunkResults[i];
    const chunkLen = chunkResult.length;
    const offset = offsets[i];
    for (let j = 0; j < chunkLen; j++) {
      result[offset + j] = chunkResult[j];
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
  fnHash: string,
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

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Execute in parallel
  const promises: Promise<unknown[]>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    promises[i] = executeFilterChunkDirect(fnString, fnHash, chunk, i, chunkCount, options.context, entry, worker, temporary);
  }

  const chunkResults = await Promise.all(promises);

  // Merge results
  let totalSize = 0;
  for (let i = 0; i < chunkCount; i++) {
    totalSize += chunkResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  let offset = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunkResult = chunkResults[i];
    const chunkLen = chunkResult.length;
    for (let j = 0; j < chunkLen; j++) {
      result[offset++] = chunkResult[j] as T;
    }
  }

  return result;
}

// ============================================================================
// REDUCE EXECUTION
// ============================================================================

async function executeTurboReduce<R>(
  fnString: string,
  fnHash: string,
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

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(numWorkers);
  let chunkCount = 0;

  for (let i = 0; i < numWorkers; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  // Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  // Phase 1: Parallel reduction per chunk
  const promises: Promise<R>[] = new Array(chunkCount);
  for (let i = 0; i < chunkCount; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = data.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    promises[i] = executeReduceChunkDirect<R>(fnString, fnHash, chunk, initialValue, i, chunkCount, options.context, entry, worker, temporary);
  }

  const chunkResults = await Promise.all(promises);

  // Phase 2: Final reduction
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
  fnHash: string,
  message: TurboWorkerMessage
): Promise<void> {
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
      const msgType = msg.type;
      if (msgType === 'turbo_complete') {
        cleanup();
        resolve();
      } else if (msgType === 'turbo_error') {
        cleanup();
        const msgError = msg.error;
        const err = new Error(msgError !== undefined ? msgError.message : 'Turbo worker error');
        err.name = msgError !== undefined ? msgError.name : 'TurboError';
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

// Turbo chunk execution using structuredClone
function executeTurboChunkDirect<T>(
  fnString: string,
  fnHash: string,
  chunk: unknown[],
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  entry: WorkerEntry,
  worker: Worker,
  temporary: boolean,
  shouldAbort: () => boolean
): Promise<T[]> {
  if (shouldAbort()) {
    releaseWorker(entry, worker, temporary, 'normal', 0, false, fnHash);
    return Promise.reject(new Error('Turbo execution aborted'));
  }

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

// Filter chunk execution
function executeFilterChunkDirect(
  fnString: string,
  fnHash: string,
  chunk: unknown[],
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  entry: WorkerEntry,
  worker: Worker,
  temporary: boolean
): Promise<unknown[]> {
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

// Reduce chunk execution
function executeReduceChunkDirect<R>(
  fnString: string,
  fnHash: string,
  chunk: unknown[],
  initialValue: R,
  workerId: number,
  totalWorkers: number,
  context: Record<string, unknown> | undefined,
  entry: WorkerEntry,
  worker: Worker,
  temporary: boolean
): Promise<R> {
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
  fnHash: string,
  data: unknown[],
  options: TurboOptions,
  startTime: number
): Promise<TurboResult<T>> {
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
// MAX MODE - TURBO + MAIN THREAD PROCESSING
// ============================================================================

/**
 * Compiles function with context injection for main thread execution.
 */
function compileWithContext(fnString: string, context?: Record<string, unknown>): Function {
  if (!context || Object.keys(context).length === 0) {
    return new Function('return ' + fnString)();
  }
  
  const contextKeys = Object.keys(context);
  const contextValues = contextKeys.map(k => context[k]);
  
  const wrapperCode = `
    return function(${contextKeys.join(', ')}) {
      const fn = ${fnString};
      return fn;
    }
  `;
  
  const wrapper = new Function(wrapperCode)();
  return wrapper(...contextValues);
}

export interface MaxOptions extends TurboOptions {}

/**
 * @experimental
 * Creates a TurboExecutor that includes the main thread in processing.
 * Uses ALL available CPU cores including the main thread.
 * 
 * WARNING: Blocks the main thread during processing. Use only when:
 * - You need 100% CPU utilization
 * - No HTTP requests/events need to be handled
 * - The workload is pure computation
 */
export function createMaxExecutor<TItem>(
  data: TItem[] | NumericTypedArray,
  options: MaxOptions = {}
): TurboExecutor<TItem> {
  const executor: TurboExecutor<TItem> = {
    setWorkers(count: number): TurboExecutor<TItem> {
      if (!Number.isInteger(count) || count < 1) {
        throw new TypeError('setWorkers() requires a positive integer');
      }
      return createMaxExecutor<TItem>(data, { ...options, workers: count });
    },

    map<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TResult[]> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      return executeMaxMap<TResult>(fnString, fnHash, data as unknown[], options);
    },

    mapWithStats<TResult>(fn: (item: TItem, index: number) => TResult): Promise<TurboResult<TResult>> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      const startTime = Date.now();
      return executeMaxMapWithStats<TResult>(fnString, fnHash, data as unknown[], options, startTime);
    },

    filter(fn: (item: TItem, index: number) => boolean): Promise<TItem[]> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      return executeMaxFilter<TItem>(fnString, fnHash, data as unknown[], options);
    },

    reduce<TResult>(fn: (acc: TResult, item: TItem, index: number) => TResult, initialValue: TResult): Promise<TResult> {
      const fnString = fn.toString();
      const fnHash = fastHash(fnString);
      return executeMaxReduce<TResult>(fnString, fnHash, data as unknown[], initialValue, options);
    }
  };

  return executor;
}

// ============================================================================
// MAX EXECUTION - TURBO + MAIN THREAD
// ============================================================================

async function executeMaxMap<T>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  options: MaxOptions
): Promise<T[]> {
  const result = await executeMaxMapWithStats<T>(fnString, fnHash, data, options, Date.now());
  return result.data;
}

async function executeMaxMapWithStats<T>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  options: MaxOptions,
  startTime: number
): Promise<TurboResult<T>> {
  // Convert TypedArray to regular array (max() doesn't support SharedArrayBuffer path)
  const actualData = isTypedArray(data) ? Array.from(data) : data;
  const dataLength = actualData.length;

  if (!options.force && dataLength < TURBO_THRESHOLD) {
    return fallbackSingleExecution<T>(fnString, fnHash, actualData, options, startTime);
  }

  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  const actualWorkers = numWorkers > 1 ? numWorkers : 1;
  
  // Main thread gets a chunk too
  const totalThreads = actualWorkers + 1;
  const chunkSize = options.chunkSize !== undefined ? options.chunkSize : Math.ceil(dataLength / totalThreads);

  // Calculate chunk boundaries
  const chunkBounds: Array<{ start: number; end: number }> = new Array(totalThreads);
  let chunkCount = 0;

  for (let i = 0; i < totalThreads; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  const mainThreadChunkIndex = chunkCount - 1;
  const workerChunks = chunkCount - 1;

  // Batch worker acquisition
  const workerRequests: Promise<WorkerInfo>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }

  const workers = await Promise.all(workerRequests);

  // Dispatch to workers
  const workerPromises: Promise<T[]>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = actualData.slice(start, end);
    const { entry, worker, temporary } = workers[i];

    workerPromises[i] = executeTurboChunkDirect<T>(
      fnString,
      fnHash,
      chunk,
      i,
      chunkCount,
      options.context,
      entry,
      worker,
      temporary,
      () => false
    );
  }

  // Main thread processes its chunk while workers run
  const mainChunk = chunkBounds[mainThreadChunkIndex];
  const mainChunkData = actualData.slice(mainChunk.start, mainChunk.end);
  
  const fn = compileWithContext(fnString, options.context);
  
  const mainResult: T[] = new Array(mainChunkData.length);
  for (let i = 0; i < mainChunkData.length; i++) {
    mainResult[i] = fn(mainChunkData[i], mainChunk.start + i);
  }

  // Wait for all workers
  const workerResults = await Promise.all(workerPromises);

  // Merge results
  let totalSize = 0;
  const offsets: number[] = new Array(chunkCount);
  
  for (let i = 0; i < workerChunks; i++) {
    offsets[i] = totalSize;
    totalSize += workerResults[i].length;
  }
  offsets[mainThreadChunkIndex] = totalSize;
  totalSize += mainResult.length;

  const result: T[] = new Array(totalSize);
  
  for (let i = 0; i < workerChunks; i++) {
    const chunkResult = workerResults[i];
    const chunkLen = chunkResult.length;
    const offset = offsets[i];
    for (let j = 0; j < chunkLen; j++) {
      result[offset + j] = chunkResult[j];
    }
  }
  
  const offset = offsets[mainThreadChunkIndex];
  for (let j = 0; j < mainResult.length; j++) {
    result[offset + j] = mainResult[j];
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

async function executeMaxFilter<T>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  options: MaxOptions
): Promise<T[]> {
  // Convert TypedArray to regular array
  const actualData = isTypedArray(data) ? Array.from(data) : data;
  const dataLength = actualData.length;

  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    const result: T[] = [];
    for (let i = 0; i < dataLength; i++) {
      if (fn(actualData[i], i)) {
        result.push(actualData[i] as T);
      }
    }
    return result;
  }

  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  
  const totalThreads = numWorkers + 1;
  const chunkSize = Math.ceil(dataLength / totalThreads);

  const chunkBounds: Array<{ start: number; end: number }> = new Array(totalThreads);
  let chunkCount = 0;

  for (let i = 0; i < totalThreads; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  const mainThreadChunkIndex = chunkCount - 1;
  const workerChunks = chunkCount - 1;

  const workerRequests: Promise<WorkerInfo>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  const workerPromises: Promise<unknown[]>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = actualData.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    workerPromises[i] = executeFilterChunkDirect(fnString, fnHash, chunk, i, chunkCount, options.context, entry, worker, temporary);
  }

  // Main thread filter
  const mainChunk = chunkBounds[mainThreadChunkIndex];
  const fn = compileWithContext(fnString, options.context);
  const mainResult: T[] = [];
  for (let i = mainChunk.start; i < mainChunk.end; i++) {
    if (fn(actualData[i], i)) {
      mainResult.push(actualData[i] as T);
    }
  }

  const workerResults = await Promise.all(workerPromises);

  let totalSize = mainResult.length;
  for (let i = 0; i < workerChunks; i++) {
    totalSize += workerResults[i].length;
  }

  const result: T[] = new Array(totalSize);
  let offset = 0;
  
  for (let i = 0; i < workerChunks; i++) {
    const chunkResult = workerResults[i];
    const chunkLen = chunkResult.length;
    for (let j = 0; j < chunkLen; j++) {
      result[offset++] = chunkResult[j] as T;
    }
  }
  
  for (let j = 0; j < mainResult.length; j++) {
    result[offset++] = mainResult[j];
  }

  return result;
}

async function executeMaxReduce<R>(
  fnString: string,
  fnHash: string,
  data: unknown[],
  initialValue: R,
  options: MaxOptions
): Promise<R> {
  // Convert TypedArray to regular array
  const actualData = isTypedArray(data) ? Array.from(data) : data;
  const dataLength = actualData.length;

  if (!options.force && dataLength < TURBO_THRESHOLD) {
    const fn = new Function('return ' + fnString)();
    let acc = initialValue;
    for (let i = 0; i < dataLength; i++) {
      acc = fn(acc, actualData[i], i);
    }
    return acc;
  }

  const maxWorkers = options.workers !== undefined ? options.workers : config.poolSize;
  const calculatedWorkers = Math.ceil(dataLength / MIN_ITEMS_PER_WORKER);
  const numWorkers = calculatedWorkers < maxWorkers ? calculatedWorkers : maxWorkers;
  
  const totalThreads = numWorkers + 1;
  const chunkSize = Math.ceil(dataLength / totalThreads);

  const chunkBounds: Array<{ start: number; end: number }> = new Array(totalThreads);
  let chunkCount = 0;

  for (let i = 0; i < totalThreads; i++) {
    const start = i * chunkSize;
    if (start >= dataLength) break;
    const end = start + chunkSize;
    chunkBounds[i] = { start, end: end < dataLength ? end : dataLength };
    chunkCount++;
  }

  const mainThreadChunkIndex = chunkCount - 1;
  const workerChunks = chunkCount - 1;

  const workerRequests: Promise<WorkerInfo>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    workerRequests[i] = requestWorker('normal', 'high', fnHash);
  }
  const workers = await Promise.all(workerRequests);

  const workerPromises: Promise<R>[] = new Array(workerChunks);
  for (let i = 0; i < workerChunks; i++) {
    const { start, end } = chunkBounds[i];
    const chunk = actualData.slice(start, end);
    const { entry, worker, temporary } = workers[i];
    workerPromises[i] = executeReduceChunkDirect<R>(fnString, fnHash, chunk, initialValue, i, chunkCount, options.context, entry, worker, temporary);
  }

  // Main thread reduce
  const mainChunk = chunkBounds[mainThreadChunkIndex];
  const fn = compileWithContext(fnString, options.context);
  let mainAcc = initialValue;
  for (let i = mainChunk.start; i < mainChunk.end; i++) {
    mainAcc = fn(mainAcc, actualData[i], i);
  }

  const workerResults = await Promise.all(workerPromises);

  // Final reduction
  let result = initialValue;
  for (let i = 0; i < workerChunks; i++) {
    result = fn(result, workerResults[i]);
  }
  result = fn(result, mainAcc);

  return result;
}

// ============================================================================
// EXPORTS
// ============================================================================

export { TURBO_THRESHOLD, MIN_ITEMS_PER_WORKER };
