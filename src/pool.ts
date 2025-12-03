/**
 * @fileoverview Worker pool management for bee-threads.
 *
 * Manages the lifecycle of worker threads:
 * - Creating workers with proper configuration
 * - Selecting the best worker for a task (load balancing)
 * - Returning workers to the pool after use
 * - Cleaning up idle workers to free resources
 * - Managing temporary overflow workers
 *
 * @module bee-threads/pool
 * @internal
 */

import { Worker } from 'worker_threads';
import { SCRIPTS, config, pools, poolCounters, queues, metrics } from './config';
import { QueueFullError } from './errors';
import type {
  PoolType,
  Priority,
  WorkerEntry,
  WorkerInfo,
  QueuedTask,
  PriorityQueues
} from './types';

// ============================================================================
// EXTENDED WORKER TYPE
// ============================================================================

interface TemporaryWorker extends Worker {
  _temporary?: boolean;
  _startTime?: number;
}

// ============================================================================
// FUNCTION AFFINITY TRACKING
// ============================================================================

/**
 * Creates a fast hash for function affinity tracking.
 * Uses djb2 algorithm - fast and good distribution.
 */
export function fastHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Creates a new worker with tracking metadata.
 */
export function createWorkerEntry(script: string, poolType: PoolType): WorkerEntry {
  const cacheSize = config.lowMemoryMode ? 10 : config.functionCacheSize;

  const workerOptions: {
    workerData: { functionCacheSize: number; lowMemoryMode: boolean; debugMode: boolean };
    resourceLimits?: typeof config.resourceLimits;
  } = {
    workerData: {
      functionCacheSize: cacheSize,
      lowMemoryMode: config.lowMemoryMode,
      debugMode: config.debugMode
    }
  };

  if (config.resourceLimits) {
    workerOptions.resourceLimits = config.resourceLimits;
  }

  const worker = new Worker(script, workerOptions);

  // Don't block process exit
  worker.unref();

  const entry: WorkerEntry = {
    worker,
    busy: false,
    id: Date.now() + Math.random(),
    tasksExecuted: 0,
    totalExecutionTime: 0,
    failedTasks: 0,
    temporary: false,
    terminationTimer: null,
    cachedFunctions: new Set<string>()
  };

  // Auto-remove from pool on worker exit
  worker.on('exit', () => {
    const pool = pools[poolType];
    const idx = pool.indexOf(entry);
    if (idx !== -1) {
      pool.splice(idx, 1);
      entry.busy ? poolCounters[poolType].busy-- : poolCounters[poolType].idle--;
    }
  });

  poolCounters[poolType].idle++;
  return entry;
}

/**
 * Schedules automatic termination of idle workers.
 */
export function scheduleIdleTimeout(entry: WorkerEntry, poolType: PoolType): void {
  if (config.workerIdleTimeout <= 0) return;

  if (entry.terminationTimer) {
    clearTimeout(entry.terminationTimer);
  }

  entry.terminationTimer = setTimeout(() => {
    const pool = pools[poolType];
    const minToKeep = Math.max(1, config.minThreads);
    if (!entry.busy && pool.length > minToKeep) {
      entry.worker.terminate();
    }
  }, config.workerIdleTimeout);
}

/**
 * Pre-creates workers to have them ready before tasks arrive.
 */
export async function warmupPool(poolType: PoolType, count: number): Promise<void> {
  const pool = pools[poolType];
  const script = SCRIPTS[poolType];
  const toCreate = Math.min(count, config.poolSize) - pool.length;

  for (let i = 0; i < toCreate; i++) {
    const entry = createWorkerEntry(script, poolType);
    pool.push(entry);
  }
}

// ============================================================================
// WORKER ACQUISITION
// ============================================================================

interface GetWorkerResult {
  entry: WorkerEntry | null;
  worker: Worker;
  temporary: boolean;
  affinityHit?: boolean;
}

/**
 * Gets an available worker using affinity-aware load balancing.
 */
export function getWorker(poolType: PoolType, fnHash: string | null = null): GetWorkerResult | null {
  const pool = pools[poolType];
  const script = SCRIPTS[poolType];
  const counters = poolCounters[poolType];

  // Strategy 1: Find idle worker with affinity match
  if (fnHash && counters.idle > 0) {
    for (const entry of pool) {
      if (!entry.busy && entry.cachedFunctions.has(fnHash)) {
        entry.busy = true;
        counters.busy++;
        counters.idle--;
        if (entry.terminationTimer) {
          clearTimeout(entry.terminationTimer);
        }
        metrics.affinityHits++;
        return { entry, worker: entry.worker, temporary: false, affinityHit: true };
      }
    }
    metrics.affinityMisses++;
  }

  // Strategy 2: Find idle worker with fewest tasks
  if (counters.idle > 0) {
    let selected: WorkerEntry | null = null;
    let minTasks = Infinity;

    for (const entry of pool) {
      if (!entry.busy) {
        if (entry.tasksExecuted === 0) {
          selected = entry;
          break;
        }
        if (entry.tasksExecuted < minTasks) {
          minTasks = entry.tasksExecuted;
          selected = entry;
        }
      }
    }

    if (selected) {
      selected.busy = true;
      counters.busy++;
      counters.idle--;
      if (selected.terminationTimer) {
        clearTimeout(selected.terminationTimer);
      }
      return { entry: selected, worker: selected.worker, temporary: false, affinityHit: false };
    }
  }

  // Strategy 3: Create new pooled worker
  if (pool.length < config.poolSize) {
    const entry = createWorkerEntry(script, poolType);
    entry.busy = true;
    counters.idle--;
    counters.busy++;
    pool.push(entry);
    return { entry, worker: entry.worker, temporary: false };
  }

  // Strategy 4: Create temporary worker
  if (metrics.activeTemporaryWorkers < config.maxTemporaryWorkers) {
    const workerOptions: {
      workerData: { functionCacheSize: number; lowMemoryMode: boolean; debugMode: boolean };
      resourceLimits?: typeof config.resourceLimits;
    } = {
      workerData: { 
        functionCacheSize: config.functionCacheSize,
        lowMemoryMode: config.lowMemoryMode,
        debugMode: config.debugMode
      }
    };
    if (config.resourceLimits) {
      workerOptions.resourceLimits = config.resourceLimits;
    }
    const tempWorker: TemporaryWorker = new Worker(script, workerOptions);

    tempWorker.unref();
    tempWorker._temporary = true;
    tempWorker._startTime = Date.now();
    metrics.temporaryWorkersCreated++;
    metrics.activeTemporaryWorkers++;
    return { entry: null, worker: tempWorker, temporary: true };
  }

  // Must queue
  return null;
}

/**
 * Returns a worker to the pool after task completion.
 */
export function releaseWorker(
  entry: WorkerEntry | null,
  worker: Worker,
  temporary: boolean,
  poolType: PoolType,
  executionTime: number = 0,
  failed: boolean = false,
  fnHash: string | null = null
): void {
  if (temporary) {
    metrics.activeTemporaryWorkers--;
    metrics.temporaryWorkerTasks++;
    metrics.temporaryWorkerExecutionTime += executionTime;
    worker.terminate();
    return;
  }

  if (!entry) return;

  const counters = poolCounters[poolType];

  // Update stats
  entry.tasksExecuted++;
  entry.totalExecutionTime += executionTime;
  if (failed) entry.failedTasks++;

  // Track function for affinity
  if (fnHash && !config.lowMemoryMode) {
    if (entry.cachedFunctions.size >= 50) {
      entry.cachedFunctions.clear();
    }
    entry.cachedFunctions.add(fnHash);
  }

  // Check for queued tasks
  const queue = queues[poolType];
  const nextTask = dequeueTask(queue);
  if (nextTask && entry.busy) {
    if (entry.terminationTimer) {
      clearTimeout(entry.terminationTimer);
    }
    nextTask.resolve({ entry, worker: entry.worker, temporary: false });
  } else {
    entry.busy = false;
    counters.busy--;
    counters.idle++;
    scheduleIdleTimeout(entry, poolType);
  }
}

/**
 * Gets total queue length across all priorities.
 */
export function getQueueLength(queue: PriorityQueues): number {
  return queue.high.length + queue.normal.length + queue.low.length;
}

/**
 * Dequeues the highest priority task.
 */
export function dequeueTask(queue: PriorityQueues): QueuedTask | null {
  if (queue.high.length > 0) return queue.high.shift()!;
  if (queue.normal.length > 0) return queue.normal.shift()!;
  if (queue.low.length > 0) return queue.low.shift()!;
  return null;
}

/**
 * Requests a worker, queueing if none available.
 */
export function requestWorker(
  poolType: PoolType,
  priority: Priority = 'normal',
  fnHash: string | null = null
): Promise<WorkerInfo> {
  const result = getWorker(poolType, fnHash);
  if (result) {
    return Promise.resolve({
      worker: result.worker,
      entry: result.entry!,
      temporary: result.temporary
    });
  }

  const queue = queues[poolType];
  if (getQueueLength(queue) >= config.maxQueueSize) {
    return Promise.reject(new QueueFullError(config.maxQueueSize));
  }

  const validPriorities: Priority[] = ['high', 'normal', 'low'];
  const queuePriority = validPriorities.includes(priority) ? priority : 'normal';

  return new Promise((resolve, reject) => {
    const task: QueuedTask = {
      fnString: '',
      args: [],
      context: null,
      transfer: [],
      resolve: (info: WorkerInfo) => resolve(info),
      reject,
      priority: queuePriority
    };
    queue[queuePriority].push(task);
  });
}

