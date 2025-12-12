/**
 * @fileoverview File-based worker execution for bee-threads.
 *
 * Enables running external worker files with full `require()` access,
 * database connections, and third-party module support.
 *
 * ## Features
 * - **Type-safe**: Full TypeScript inference for arguments and return types
 * - **Worker pooling**: Automatic pool management per file path
 * - **Turbo mode**: Parallel array processing across multiple workers
 * - **Error handling**: Proper error propagation with stack traces
 *
 * ## V8 Optimizations
 * - Monomorphic object shapes (stable property structure)
 * - Raw for loops instead of .find()/.filter()/.map()
 * - Pre-allocated arrays
 * - Avoid property addition after creation
 *
 * ## When to Use
 * Use file workers when your worker needs:
 * - Database connections (PostgreSQL, MongoDB, Redis)
 * - External npm modules (sharp, bcrypt, etc.)
 * - File system access
 * - Environment variables and config files
 *
 * @example Single Execution
 * ```typescript
 * // workers/hash-password.ts
 * import bcrypt from 'bcrypt';
 * export default async function(password: string): Promise<string> {
 *   return bcrypt.hash(password, 12);
 * }
 *
 * // main.ts
 * import type hashPassword from './workers/hash-password';
 * const hash = await beeThreads.worker<typeof hashPassword>('./workers/hash-password')('secret');
 * ```
 *
 * @example Turbo Mode (Parallel Arrays)
 * ```typescript
 * // workers/process-users.ts
 * import { db } from '../database';
 * export default async function(users: User[]): Promise<ProcessedUser[]> {
 *   return Promise.all(users.map(async u => ({
 *     ...u,
 *     score: await db.getScore(u.id)
 *   })));
 * }
 *
 * // main.ts - Process 10,000 users across 8 workers
 * const results = await beeThreads.worker('./workers/process-users').turbo(users, { workers: 8 });
 * ```
 *
 * @module bee-threads/file-worker
 */

import { Worker } from 'worker_threads';
import * as path from 'path';
import * as os from 'os';
import { 
  autoPack, 
  canAutoPack, 
  makeTransferable, 
  getTransferablesFromPacked,
  AUTOPACK_ARRAY_THRESHOLD,
  GENERIC_UNPACK_CODE,
  GENERIC_PACK_CODE,
  type TransferablePackedData
} from './autopack';

// ============================================================================
// TYPES
// ============================================================================

/** Any function type for generic constraints */
type AnyFunction = (...args: any[]) => any;

/**
 * Internal worker pool entry tracking state.
 * V8: All properties initialized upfront for stable shape.
 * @internal
 */
interface FileWorkerEntry {
  /** Node.js Worker instance */
  worker: Worker;
  /** Whether worker is currently processing a task */
  busy: boolean;
  /** Absolute path to the worker file */
  path: string;
}

/**
 * Options for turbo mode parallel processing.
 *
 * @example
 * ```typescript
 * await beeThreads.worker('./worker.ts').turbo(data, {
 *   workers: 8  // Use 8 parallel workers
 * });
 * ```
 */
export interface TurboWorkerOptions {
  /**
   * Number of workers to use for parallel processing.
   *
   * @default os.cpus().length - 1
   *
   * @remarks
   * - Higher values increase parallelism but also memory usage
   * - Each worker maintains its own module cache and DB connections
   * - Recommended: Start with default, increase if CPU-bound
   * 
   * **Performance Note:**
   * For maximum performance with arrays, consider using `beeThreads.turbo()`
   * which uses SharedArrayBuffer for TypedArrays. File workers are best
   * suited for tasks that need `require()`, database access, or external modules.
   */
  workers?: number;
}

/**
 * Type-safe executor for file-based workers.
 *
 * Returned by `beeThreads.worker()`. Can be called directly for single
 * execution or use `.turbo()` for parallel array processing.
 *
 * @typeParam T - The worker's default export function type
 *
 * @example Direct Call
 * ```typescript
 * const executor = beeThreads.worker<typeof myWorker>('./workers/my-worker');
 * const result = await executor(arg1, arg2);
 * ```
 *
 * @example Turbo Mode
 * ```typescript
 * const executor = beeThreads.worker('./workers/process-chunk');
 * const results = await executor.turbo(largeArray, { workers: 4 });
 * ```
 */
export interface FileWorkerExecutor<T extends AnyFunction> {
  /**
   * Execute the worker function with the given arguments.
   *
   * @param args - Arguments to pass to the worker function
   * @returns Promise resolving to the worker's return value
   *
   * @example
   * ```typescript
   * // workers/add.ts
   * export default function(a: number, b: number): number {
   *   return a + b;
   * }
   *
   * // main.ts
   * const sum = await beeThreads.worker<typeof add>('./workers/add')(10, 20); // 30
   * ```
   */
  (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>>;

  /**
   * Process an array in parallel across multiple workers (turbo mode).
   *
   * The worker function must accept an array and return an array.
   * The input array is split into chunks, each chunk processed by a
   * separate worker, then results are merged maintaining original order.
   *
   * @typeParam TItem - Type of array elements
   * @param data - Array to process in parallel
   * @param options - Turbo mode options (workers count)
   * @returns Promise resolving to the processed array
   *
   * @remarks
   * **How it works:**
   * 1. Array split into N chunks (one per worker)
   * 2. Each worker processes its chunk in parallel
   * 3. Results merged in original order
   *
   * **Performance:**
   * - Best for CPU-bound operations with external dependencies
   * - Overhead: ~1-5ms per worker for chunk transfer
   * - Recommended minimum: 100+ items per worker
   *
   * @example
   * ```typescript
   * // workers/transform-chunk.ts
   * import { heavyTransform } from '../utils';
   * export default async function(items: Item[]): Promise<TransformedItem[]> {
   *   return items.map(item => heavyTransform(item));
   * }
   *
   * // main.ts
   * const results = await beeThreads
   *   .worker('./workers/transform-chunk')
   *   .turbo(items, { workers: 8 });
   * ```
   */
  turbo<TItem>(
    data: TItem[],
    options?: TurboWorkerOptions
  ): Promise<TItem[]>;
}

// ============================================================================
// WORKER POOL (per file)
// ============================================================================

/** Worker pools indexed by absolute file path */
const workerPools = new Map<string, FileWorkerEntry[]>();

/** Default max workers = CPU cores - 1 (leave one for main thread) */
const cpuCount = os.cpus().length;
const DEFAULT_MAX_WORKERS = cpuCount > 2 ? cpuCount - 1 : 2;

/**
 * Resolves a file path to an absolute path.
 * @internal
 */
function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
}

/**
 * Creates a new worker thread for the given file path.
 *
 * The worker code:
 * 1. Requires the user's worker file
 * 2. Extracts the default export (or module.exports)
 * 3. Listens for messages and executes the handler
 * 4. Supports both normal calls and turbo chunk processing
 *
 * @internal
 */
function createWorker(absPath: string): Worker {
  // Escape backslashes for Windows paths
  const escapedPath = absPath.replace(/\\/g, '\\\\');
  
  const workerCode = `
    const { parentPort } = require('worker_threads');
    const fn = require('${escapedPath}');
    const handler = fn.default || fn;
    
    // AutoPack support for large arrays
    ${GENERIC_UNPACK_CODE}
    ${GENERIC_PACK_CODE}
    
    parentPort.on('message', async (msg) => {
      const id = msg.id;
      const args = msg.args;
      const isTurboChunk = msg.isTurboChunk;
      const isPacked = msg.isPacked;
      
      try {
        let result;
        if (isTurboChunk) {
          // Unpack if data was sent packed
          const chunk = isPacked ? genericUnpack(args[0]) : args[0];
          result = await handler(chunk);
          
          // Pack result back if input was packed and result is array
          if (isPacked && Array.isArray(result) && result.length > 0 && typeof result[0] === 'object') {
            const packed = genericPack(result);
            parentPort.postMessage({ id: id, success: true, result: packed, isPacked: true });
            return;
          }
        } else {
          result = await handler(...args);
        }
        parentPort.postMessage({ id: id, success: true, result: result });
      } catch (error) {
        parentPort.postMessage({ 
          id: id, 
          success: false, 
          error: { 
            message: error.message, 
            name: error.name,
            stack: error.stack 
          }
        });
      }
    });
  `;

  return new Worker(workerCode, { eval: true });
}

/**
 * Gets or creates workers for turbo mode processing.
 * Ensures the pool has at least `count` workers available.
 * @internal
 */
function getWorkersForTurbo(filePath: string, count: number): FileWorkerEntry[] {
  const absPath = resolvePath(filePath);

  let pool = workerPools.get(absPath);
  if (!pool) {
    pool = [];
    workerPools.set(absPath, pool);
  }

  // V8: Raw for loop to create missing workers
  const currentLen = pool.length;
  for (let i = currentLen; i < count; i++) {
    const worker = createWorker(absPath);
    // V8: Monomorphic entry shape - all properties initialized
    const entry: FileWorkerEntry = {
      worker: worker,
      busy: false,
      path: absPath
    };
    pool.push(entry);
  }

  // Return first `count` workers
  // V8: slice is efficient here as it's O(count)
  return pool.slice(0, count);
}

/**
 * Gets or creates a single worker from the pool.
 * Returns an idle worker if available, otherwise creates a new one.
 * @internal
 */
function getWorker(filePath: string): FileWorkerEntry {
  const absPath = resolvePath(filePath);

  let pool = workerPools.get(absPath);
  if (!pool) {
    pool = [];
    workerPools.set(absPath, pool);
  }

  // V8: Raw for loop instead of .find()
  const poolLen = pool.length;
  for (let i = 0; i < poolLen; i++) {
    const entry = pool[i];
    if (!entry.busy) {
      entry.busy = true;
      return entry;
    }
  }

  // Create new worker if under default limit
  if (poolLen < DEFAULT_MAX_WORKERS) {
    const worker = createWorker(absPath);
    // V8: Monomorphic entry shape
    const entry: FileWorkerEntry = {
      worker: worker,
      busy: true,
      path: absPath
    };
    pool.push(entry);
    return entry;
  }

  // All workers busy, use first (will queue internally)
  const first = pool[0];
  first.busy = true;
  return first;
}

/**
 * Releases a worker back to the pool for reuse.
 * @internal
 */
function releaseWorker(entry: FileWorkerEntry): void {
  entry.busy = false;
}

// ============================================================================
// EXECUTION
// ============================================================================

/** Auto-incrementing message ID for correlating requests/responses */
let messageId = 0;

/**
 * Generic unpack for results from worker (main thread side).
 * This is a simplified version that works with TransferablePackedData.
 * @internal
 */
function genericUnpackResult<T>(packed: TransferablePackedData): T[] {
  const { schema, length, numbers, strings, stringOffsets, stringLengths, booleans } = packed;
  const { numericFields, stringFields, booleanFields } = schema;
  
  if (length === 0) return [];
  
  const result: T[] = new Array(length);
  const decoder = new TextDecoder();
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  for (let i = 0; i < length; i++) {
    const obj: Record<string, unknown> = {};
    
    // Numbers (column-oriented)
    for (let f = 0; f < numCount; f++) {
      obj[numericFields[f].name] = numbers[f * length + i];
    }
    
    // Strings
    for (let f = 0; f < strCount; f++) {
      const idx = f * length + i;
      const offset = stringOffsets[idx];
      const len = stringLengths[idx];
      obj[stringFields[f].name] = decoder.decode(strings.subarray(offset, offset + len));
    }
    
    // Booleans (bit-packed)
    for (let f = 0; f < boolCount; f++) {
      const bitIndex = f * length + i;
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      obj[booleanFields[f].name] = (booleans[byteIndex] & (1 << bitOffset)) !== 0;
    }
    
    result[i] = obj as T;
  }
  
  return result;
}

/**
 * Worker message response interface.
 * V8: Stable shape for type checking.
 */
interface WorkerResponse {
  id: number;
  success: boolean;
  result?: unknown;
  error?: {
    message: string;
    name: string;
    stack?: string;
  };
}

/**
 * Worker response with optional packed flag
 */
interface WorkerResponseWithPack extends WorkerResponse {
  isPacked?: boolean;
}

/**
 * Executes a single call on a worker and returns the result.
 * Handles message correlation and error propagation.
 * @internal
 */
function executeOnWorker<T>(
  entry: FileWorkerEntry,
  args: unknown[],
  isTurboChunk: boolean = false,
  isPacked: boolean = false,
  transferables?: ArrayBuffer[]
): Promise<{ result: T; isPacked: boolean }> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;
    const worker = entry.worker;

    const handler = (msg: WorkerResponseWithPack): void => {
      // Only process messages for this request
      if (msg.id !== id) return;

      worker.off('message', handler);
      releaseWorker(entry);

      if (msg.success) {
        resolve({ result: msg.result as T, isPacked: msg.isPacked || false });
      } else {
        const msgError = msg.error;
        const error = new Error(msgError?.message || 'Worker error');
        error.name = msgError?.name || 'WorkerError';
        if (msgError?.stack) error.stack = msgError.stack;
        reject(error);
      }
    };

    worker.on('message', handler);
    
    // V8: Monomorphic message shape
    const message = { id: id, args: args, isTurboChunk: isTurboChunk, isPacked: isPacked };
    
    if (transferables && transferables.length > 0) {
      worker.postMessage(message, transferables);
    } else {
      worker.postMessage(message);
    }
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Creates a type-safe file worker executor.
 *
 * Use this when your worker needs access to `require()`, database
 * connections, or external modules that aren't available in inline workers.
 *
 * @typeParam T - The worker's default export function type (for type inference)
 * @param filePath - Path to the worker file (relative or absolute)
 * @returns A callable executor with `.turbo()` method
 *
 * @remarks
 * **Worker File Requirements:**
 * - Must export a default function (ESM) or `module.exports` (CJS)
 * - Function can be sync or async
 * - For turbo mode: must accept array and return array
 *
 * **Type Safety:**
 * ```typescript
 * // Get full type inference by importing the worker type
 * import type myWorker from './workers/my-worker';
 * const result = await beeThreads.worker<typeof myWorker>('./workers/my-worker')(args);
 * ```
 *
 * **Pool Behavior:**
 * - Workers are pooled per file path
 * - Max pool size: `os.cpus().length - 1`
 * - Workers are reused across calls
 * - Call `beeThreads.shutdown()` to terminate all workers
 *
 * @example Single Execution
 * ```typescript
 * // workers/find-user.ts
 * import { db } from '../database';
 * export default async function(id: number): Promise<User | null> {
 *   return db.query('SELECT * FROM users WHERE id = ?', [id]);
 * }
 *
 * // main.ts
 * import type findUser from './workers/find-user';
 * const user = await beeThreads.worker<typeof findUser>('./workers/find-user')(123);
 * ```
 *
 * @example Turbo Mode
 * ```typescript
 * // workers/process-batch.ts
 * import { redis } from '../cache';
 * export default async function(ids: number[]): Promise<CachedData[]> {
 *   return Promise.all(ids.map(id => redis.get(`data:${id}`)));
 * }
 *
 * // main.ts - Process 10,000 IDs across 8 workers
 * const results = await beeThreads
 *   .worker('./workers/process-batch')
 *   .turbo(ids, { workers: 8 });
 * ```
 */
export function createFileWorker<T extends AnyFunction>(
  filePath: string
): FileWorkerExecutor<T> {
  const absPath = resolvePath(filePath);

  // Create callable function
  const executor = (async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    const entry = getWorker(absPath);
    const { result } = await executeOnWorker<Awaited<ReturnType<T>>>(entry, args, false);
    return result;
  }) as FileWorkerExecutor<T>;

  // Add turbo method
  executor.turbo = async <TItem>(
    data: TItem[],
    options: TurboWorkerOptions = {}
  ): Promise<TItem[]> => {
    const numWorkers = options.workers !== undefined ? options.workers : DEFAULT_MAX_WORKERS;
    const dataLength = data.length;
    
    // Determine if AutoPack should be used based on array size
    // AutoPack is beneficial for large arrays of objects (100K+)
    const useAutoPack = dataLength >= AUTOPACK_ARRAY_THRESHOLD && 
                        canAutoPack(data as unknown[]);

    // Small array optimization: single worker for tiny arrays
    if (dataLength <= numWorkers) {
      const entry = getWorker(absPath);
      const { result } = await executeOnWorker<TItem[]>(entry, [data], true, false);
      return result;
    }

    // Get workers for parallel processing
    const workers = getWorkersForTurbo(absPath, numWorkers);
    const chunkSize = Math.ceil(dataLength / numWorkers);

    // V8: Pre-allocated promises array
    const promises: Promise<{ result: TItem[] | TransferablePackedData; isPacked: boolean }>[] = new Array(numWorkers);
    let promiseCount = 0;

    // V8: Raw for loop
    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      if (start >= dataLength) break;

      const end = start + chunkSize;
      const actualEnd = end < dataLength ? end : dataLength;
      const chunk = data.slice(start, actualEnd);
      const entry = workers[i];
      entry.busy = true;

      if (useAutoPack) {
        // Pack chunk for faster transfer
        const packed = autoPack(chunk as Record<string, unknown>[]);
        const transferable = makeTransferable(packed);
        const buffers = getTransferablesFromPacked(transferable);
        promises[promiseCount] = executeOnWorker<TItem[] | TransferablePackedData>(
          entry, [transferable], true, true, buffers
        );
      } else {
        promises[promiseCount] = executeOnWorker<TItem[]>(entry, [chunk], true, false);
      }
      promiseCount++;
    }

    // Wait for all workers (avoid slice when array is full)
    const rawResults = promiseCount === numWorkers 
      ? await Promise.all(promises)
      : await Promise.all(promises.slice(0, promiseCount));

    // Process results (unpack if needed)
    const results: TItem[][] = new Array(promiseCount);
    for (let i = 0; i < promiseCount; i++) {
      const { result, isPacked } = rawResults[i];
      if (isPacked && result && typeof result === 'object' && 'schema' in result) {
        // Unpack result from worker
        results[i] = genericUnpackResult(result as TransferablePackedData) as TItem[];
      } else {
        results[i] = result as TItem[];
      }
    }

    // V8: Pre-calculate total size for merged array
    let totalSize = 0;
    for (let i = 0; i < promiseCount; i++) {
      totalSize += results[i].length;
    }

    // V8: Pre-allocated merged array with raw for loops
    const merged: TItem[] = new Array(totalSize);
    let offset = 0;
    for (let i = 0; i < promiseCount; i++) {
      const chunk = results[i];
      const chunkLen = chunk.length;
      for (let j = 0; j < chunkLen; j++) {
        merged[offset++] = chunk[j];
      }
    }

    return merged;
  };

  return executor;
}

/**
 * Terminates all file workers and clears the worker pools.
 *
 * Called automatically by `beeThreads.shutdown()`.
 *
 * @returns Promise that resolves when all workers are terminated
 *
 * @example
 * ```typescript
 * // Graceful shutdown
 * await beeThreads.shutdown(); // Also terminates file workers
 *
 * // Or directly
 * import { terminateFileWorkers } from 'bee-threads';
 * await terminateFileWorkers();
 * ```
 */
export async function terminateFileWorkers(): Promise<void> {
  // V8: Pre-count total workers
  let totalWorkers = 0;
  for (const pool of workerPools.values()) {
    totalWorkers += pool.length;
  }

  // V8: Pre-allocated promises array
  const promises: Promise<number>[] = new Array(totalWorkers);
  let idx = 0;

  for (const pool of workerPools.values()) {
    const poolLen = pool.length;
    for (let i = 0; i < poolLen; i++) {
      promises[idx++] = pool[i].worker.terminate();
    }
  }

  await Promise.all(promises);
  workerPools.clear();
}
