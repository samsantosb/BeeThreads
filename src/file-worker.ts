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

// ============================================================================
// TYPES
// ============================================================================

/** Any function type for generic constraints */
type AnyFunction = (...args: any[]) => any;

type NumericTypedArray =
  | Float64Array | Float32Array
  | Int32Array | Int16Array | Int8Array
  | Uint32Array | Uint16Array | Uint8Array | Uint8ClampedArray;

type TypedArrayCtor<T extends NumericTypedArray = NumericTypedArray> = {
  new(buffer: ArrayBufferLike, byteOffset?: number, length?: number): T;
  BYTES_PER_ELEMENT: number;
  name: string;
};

const TYPED_ARRAY_CTORS: Record<string, TypedArrayCtor> = {
  Float64Array,
  Float32Array,
  Int32Array,
  Int16Array,
  Int8Array,
  Uint32Array,
  Uint16Array,
  Uint8Array,
  Uint8ClampedArray
};

function isTypedArray(value: unknown): value is NumericTypedArray {
  if (value === null || typeof value !== 'object') return false;
  const keys = Object.keys(TYPED_ARRAY_CTORS);
  for (let i = 0; i < keys.length; i++) {
    const ctor = TYPED_ARRAY_CTORS[keys[i]];
    if (value instanceof ctor) return true;
  }
  return false;
}

function getTypedArrayInfo(arr: NumericTypedArray): { ctor: TypedArrayCtor; typeName: string; bytes: number; length: number } {
  const typeName = arr.constructor.name;
  const ctor = TYPED_ARRAY_CTORS[typeName];
  return {
    ctor: ctor ?? Float64Array,
    typeName,
    bytes: (ctor ?? Float64Array).BYTES_PER_ELEMENT,
    length: arr.length
  };
}

/**
 * Internal worker pool entry tracking state.
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
    data: TItem[] | NumericTypedArray,
    options?: TurboWorkerOptions
  ): Promise<TItem[] | NumericTypedArray>;
}

// ============================================================================
// WORKER POOL (per file)
// ============================================================================

/** Worker pools indexed by absolute file path */
const workerPools = new Map<string, FileWorkerEntry[]>();

/** Default max workers = CPU cores - 1 (leave one for main thread) */
const DEFAULT_MAX_WORKERS = Math.max(2, os.cpus().length - 1);

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
  const workerCode = `
    const { parentPort } = require('worker_threads');
    const fn = require('${absPath.replace(/\\/g, '\\\\')}');
    const handler = fn.default || fn;

    const TYPED_ARRAY_CTORS = {
      Float64Array,
      Float32Array,
      Int32Array,
      Int16Array,
      Int8Array,
      Uint32Array,
      Uint16Array,
      Uint8Array,
      Uint8ClampedArray
    };

    function reviveTypedArray(arg) {
      if (!arg || !arg.__beeTurboSAB) return arg;
      const Ctor = TYPED_ARRAY_CTORS[arg.type];
      if (!Ctor) return arg;
      return new Ctor(arg.buffer, arg.byteOffset, arg.length);
    }

    function copyToSharedOutput(result, sabMeta) {
      if (!sabMeta || !sabMeta.output || !sabMeta.type) return false;
      const Ctor = TYPED_ARRAY_CTORS[sabMeta.type];
      if (!Ctor) return false;
      const view = new Ctor(sabMeta.output.buffer, sabMeta.output.byteOffset, sabMeta.output.length);
      const len = Math.min(view.length, Array.isArray(result) ? result.length : result?.length ?? 0);
      for (let i = 0; i < len; i++) {
        view[i] = result[i];
      }
      return true;
    }
    
    parentPort.on('message', async ({ id, args, isTurboChunk, sabMeta }) => {
      try {
        let result;
        if (isTurboChunk) {
          const revived = reviveTypedArray(args[0]);
          result = await handler(revived);
          if (args[0] && args[0].__beeTurboSAB && copyToSharedOutput(result, sabMeta)) {
            parentPort.postMessage({ id, success: true, usedShared: true });
            return;
          }
        } else {
          result = await handler(...args);
        }
        parentPort.postMessage({ id, success: true, result });
      } catch (error) {
        parentPort.postMessage({ 
          id, 
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

  // Ensure we have enough workers
  while (pool.length < count) {
    const worker = createWorker(absPath);
    pool.push({ worker, busy: false, path: absPath });
  }

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

  // Find idle worker
  const idle = pool.find(w => !w.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }

  // Create new worker if under default limit
  if (pool.length < DEFAULT_MAX_WORKERS) {
    const worker = createWorker(absPath);
    const entry: FileWorkerEntry = { worker, busy: true, path: absPath };
    pool.push(entry);
    return entry;
  }

  // All workers busy, use first (will queue)
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
 * Executes a single call on a worker and returns the result.
 * Handles message correlation and error propagation.
 * @internal
 */
function executeOnWorker<T>(
  entry: FileWorkerEntry,
  args: unknown[],
  isTurboChunk: boolean = false,
  sabMeta?: { type?: string; output?: { buffer: SharedArrayBuffer; byteOffset: number; length: number } }
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++messageId;

    const handler = (msg: { id: number; success: boolean; result?: any; error?: any; usedShared?: boolean }) => {
      if (msg.id !== id) return;

      entry.worker.off('message', handler);
      releaseWorker(entry);

      if (msg.success) {
        resolve(msg.result as T);
      } else {
        const error = new Error(msg.error?.message || 'Worker error');
        error.name = msg.error?.name || 'WorkerError';
        if (msg.error?.stack) error.stack = msg.error.stack;
        reject(error);
      }
    };

    entry.worker.on('message', handler);
    entry.worker.postMessage({ id, args, isTurboChunk, sabMeta });
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
  const executor = ((...args: Parameters<T>): Promise<Awaited<ReturnType<T>>> => {
    const entry = getWorker(absPath);
    return executeOnWorker(entry, args, false);
  }) as FileWorkerExecutor<T>;

  // Add turbo method
  executor.turbo = async <TItem>(
    data: TItem[] | NumericTypedArray,
    options: TurboWorkerOptions = {}
  ): Promise<TItem[] | NumericTypedArray> => {
    const numWorkers = options.workers ?? DEFAULT_MAX_WORKERS;
    const dataLength = data.length;

    // Small array optimization: single worker for tiny arrays
    if (dataLength <= numWorkers) {
      const entry = getWorker(absPath);
      return executeOnWorker(entry, [data], true);
    }

    // TypedArray path: use SharedArrayBuffer for zero-copy chunks
    if (isTypedArray(data)) {
      const { ctor, typeName, bytes, length } = getTypedArrayInfo(data);
      const inputBuffer = new SharedArrayBuffer(length * bytes);
      const outputBuffer = new SharedArrayBuffer(length * bytes);
      const inputView = new ctor(inputBuffer);
      inputView.set(data as NumericTypedArray);

      const workers = getWorkersForTurbo(absPath, numWorkers);
      const chunkSize = Math.ceil(dataLength / numWorkers);
      const promises: Promise<void>[] = [];

      for (let i = 0; i < numWorkers; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, dataLength);
        if (start >= dataLength) break;

        const entry = workers[i];
        entry.busy = true;

        const chunkDescriptor = {
          __beeTurboSAB: true,
          buffer: inputBuffer,
          byteOffset: start * bytes,
          length: end - start,
          type: typeName
        };

        const sabMeta = {
          type: typeName,
          output: {
            buffer: outputBuffer,
            byteOffset: start * bytes,
            length: end - start
          }
        };

        promises.push(executeOnWorker<void>(entry, [chunkDescriptor], true, sabMeta));
      }

      await Promise.all(promises);
      const outputView = new ctor(outputBuffer);
      return outputView as unknown as NumericTypedArray;
    }

    // Get workers for parallel processing
    const workers = getWorkersForTurbo(absPath, numWorkers);
    const chunkSize = Math.ceil(dataLength / numWorkers);

    // Create chunks and execute in parallel
    const promises: Promise<TItem[]>[] = [];

    for (let i = 0; i < numWorkers; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, dataLength);

      if (start >= dataLength) break;

      const chunk = data.slice(start, end);
      const entry = workers[i];
      entry.busy = true;

      promises.push(executeOnWorker<TItem[]>(entry, [chunk], true));
    }

    // Wait for all workers and merge results
    const results = await Promise.all(promises);

    // Flatten results maintaining original order
    const merged: TItem[] = [];
    for (const chunk of results) {
      for (const item of chunk) {
        merged.push(item);
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
  const promises: Promise<number>[] = [];

  for (const pool of workerPools.values()) {
    for (const entry of pool) {
      promises.push(entry.worker.terminate());
    }
  }

  await Promise.all(promises);
  workerPools.clear();
}
