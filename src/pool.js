/**
 * @fileoverview Worker pool management for bee-threads.
 * 
 * ## Why This File Exists
 * 
 * Manages the lifecycle of worker threads:
 * - Creating workers with proper configuration
 * - Selecting the best worker for a task (load balancing)
 * - Returning workers to the pool after use
 * - Cleaning up idle workers to free resources
 * - Managing temporary overflow workers
 * 
 * ## Load Balancing Strategy
 * 
 * We use "least-used" selection: always pick the worker that has
 * executed the fewest tasks. This distributes load evenly and
 * prevents worker starvation.
 * 
 * ## Worker Types
 * 
 * 1. **Pooled Workers**: Reusable, stay alive between tasks
 * 2. **Temporary Workers**: Created when pool is full, terminated after use
 * 
 * @module bee-threads/pool
 * @internal
 */

'use strict';

const { Worker } = require('worker_threads');
const { SCRIPTS, config, pools, poolCounters, queues, metrics } = require('./config');
const { QueueFullError } = require('./errors');

// ============================================================================
// WORKER ENTRY MANAGEMENT
// ============================================================================

/**
 * Metadata for a pooled worker.
 * 
 * @typedef {Object} WorkerEntry
 * @property {Worker} worker - The Node.js Worker instance
 * @property {string} poolType - Which pool this belongs to
 * @property {boolean} busy - Currently executing a task?
 * @property {number} tasksExecuted - Lifetime task count
 * @property {number} totalExecutionTime - Cumulative time (ms)
 * @property {number} failureCount - Failed task count
 * @property {number} createdAt - Creation timestamp
 * @property {number} lastUsedAt - Last activity timestamp
 * @property {NodeJS.Timeout|null} idleTimer - Cleanup timer
 * @property {Set<string>} functionHashes - Hashes of functions executed (for affinity)
 * @internal
 */

// ============================================================================
// FUNCTION AFFINITY TRACKING
// ============================================================================

/**
 * Creates a fast hash for function affinity tracking.
 * 
 * Uses a simple but effective hash algorithm (djb2) that's fast enough
 * for real-time use while providing reasonable collision resistance.
 * 
 * @param {string} str - String to hash
 * @returns {string} Hash string
 * @internal
 */
function fastHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Creates a new worker with tracking metadata.
 * 
 * ## Why Track All This?
 * 
 * - `tasksExecuted`: For load balancing (pick least-used)
 * - `failureCount`: For health monitoring
 * - `totalExecutionTime`: For performance analysis
 * - `lastUsedAt`: For idle detection
 * - `idleTimer`: For automatic cleanup
 * 
 * @param {string} script - Path to worker script
 * @param {string} poolType - 'normal' or 'generator'
 * @returns {WorkerEntry} New worker with metadata
 * @internal
 */
function createWorkerEntry(script, poolType) {
  const workerOptions = config.resourceLimits 
    ? { resourceLimits: config.resourceLimits } 
    : {};
  
  const worker = new Worker(script, workerOptions);
  
  // Don't block process exit - workers shouldn't keep Node.js alive
  worker.unref();
  
  const entry = {
    worker,
    poolType,
    busy: false,
    tasksExecuted: 0,
    totalExecutionTime: 0,
    failureCount: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    idleTimer: null,
    functionHashes: new Set() // Track functions for affinity
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
 * 
 * ## Why This Exists
 * 
 * Workers consume memory even when idle. If a burst of traffic
 * creates many workers, we don't want them sitting around forever.
 * This schedules cleanup after `workerIdleTimeout` ms of inactivity.
 * 
 * Respects `minThreads` - never terminates workers if pool would
 * drop below the minimum. Always keeps at least 1 worker alive
 * to avoid cold-start latency.
 * 
 * @param {WorkerEntry} entry - Worker to schedule cleanup for
 * @internal
 */
function scheduleIdleTimeout(entry) {
  if (config.workerIdleTimeout <= 0) return;
  
  clearTimeout(entry.idleTimer);
  
  entry.idleTimer = setTimeout(() => {
    const pool = pools[entry.poolType];
    // Keep at least minThreads workers (minimum 1)
    const minToKeep = Math.max(1, config.minThreads);
    if (!entry.busy && pool.length > minToKeep) {
      entry.worker.terminate();
    }
  }, config.workerIdleTimeout);
}

/**
 * Pre-creates workers to have them ready before tasks arrive.
 * 
 * ## Why This Exists
 * 
 * Cold-start latency: Creating a worker takes time (~50-100ms).
 * By warming up workers at startup, the first tasks execute
 * immediately without waiting for worker creation.
 * 
 * @param {string} poolType - 'normal' or 'generator'
 * @param {number} count - Number of workers to create
 * @returns {Promise<void>} Resolves when all workers are ready
 * @internal
 */
async function warmupPool(poolType, count) {
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

/**
 * Gets an available worker using affinity-aware load balancing.
 * 
 * ## Selection Strategy (in order)
 * 
 * 1. **Affinity match** - Idle worker that already has this function cached/optimized
 * 2. **Idle worker with fewest tasks** - Best case for new functions
 * 3. **Create new pooled worker** - If under poolSize limit
 * 4. **Create temporary worker** - Overflow handling
 * 5. **Return null** - Must queue the task
 * 
 * ## Why Affinity?
 * 
 * V8's TurboFan JIT compiler optimizes hot functions after several calls.
 * By routing the same function to the same worker, we benefit from:
 * - Already compiled and cached function (avoids eval)
 * - V8 optimized machine code (TurboFan)
 * - Better CPU cache locality
 * 
 * @param {string} poolType - 'normal' or 'generator'
 * @param {string} [fnHash] - Optional function hash for affinity matching
 * @returns {Object|null} Worker info or null if must queue
 * @internal
 */
function getWorker(poolType, fnHash = null) {
  const pool = pools[poolType];
  const script = SCRIPTS[poolType];
  const counters = poolCounters[poolType];
  
  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 1: Find idle worker with affinity match (V8 hot path)
  // ─────────────────────────────────────────────────────────────────────────
  if (fnHash && counters.idle > 0) {
    for (const entry of pool) {
      if (!entry.busy && entry.functionHashes.has(fnHash)) {
        entry.busy = true;
        entry.lastUsedAt = Date.now();
        counters.busy++;
        counters.idle--;
        clearTimeout(entry.idleTimer);
        metrics.affinityHits++;
        return { entry, worker: entry.worker, temporary: false, affinityHit: true };
      }
    }
    // Affinity miss - function hash provided but no worker had it cached
    metrics.affinityMisses++;
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 2: Find idle worker with fewest tasks
  // ─────────────────────────────────────────────────────────────────────────
  if (counters.idle > 0) {
    let selected = null;
    let minTasks = Infinity;
    
    for (const entry of pool) {
      if (!entry.busy) {
        // Early exit: can't do better than 0 tasks
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
      selected.lastUsedAt = Date.now();
      counters.busy++;
      counters.idle--;
      clearTimeout(selected.idleTimer);
      return { entry: selected, worker: selected.worker, temporary: false, affinityHit: false };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 2: Create new pooled worker
  // ─────────────────────────────────────────────────────────────────────────
  if (pool.length < config.poolSize) {
    const entry = createWorkerEntry(script, poolType);
    entry.busy = true;
    counters.idle--;  // Was counted as idle in createWorkerEntry
    counters.busy++;
    pool.push(entry);
    return { entry, worker: entry.worker, temporary: false };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 3: Create temporary worker
  // ─────────────────────────────────────────────────────────────────────────
  if (metrics.activeTemporaryWorkers < config.maxTemporaryWorkers) {
    const workerOptions = config.resourceLimits 
      ? { resourceLimits: config.resourceLimits } 
      : {};
    const tempWorker = new Worker(script, workerOptions);
    
    // Don't block process exit
    tempWorker.unref();
    
    tempWorker._temporary = true;
    tempWorker._startTime = Date.now();
    metrics.temporaryWorkersCreated++;
    metrics.activeTemporaryWorkers++;
    return { entry: null, worker: tempWorker, temporary: true };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STRATEGY 4: Must queue
  // ─────────────────────────────────────────────────────────────────────────
  return null;
}

/**
 * Returns a worker to the pool after task completion.
 * 
 * ## What Happens
 * 
 * For pooled workers:
 * 1. Update execution statistics
 * 2. Track function hash for affinity (V8 optimization)
 * 3. If tasks are queued, assign the next one immediately
 * 4. Otherwise, mark idle and schedule cleanup timer
 * 
 * For temporary workers:
 * 1. Update metrics
 * 2. Terminate immediately
 * 
 * @param {WorkerEntry|null} entry - Worker entry (null for temporary)
 * @param {Worker} worker - Worker instance
 * @param {boolean} temporary - Is this a temporary worker?
 * @param {number} [executionTime=0] - Task duration in ms
 * @param {boolean} [failed=false] - Did the task fail?
 * @param {string} [fnHash=null] - Function hash for affinity tracking
 * @internal
 */
function releaseWorker(entry, worker, temporary, executionTime = 0, failed = false, fnHash = null) {
  if (temporary) {
    metrics.activeTemporaryWorkers--;
    metrics.temporaryWorkerTasks++;
    metrics.temporaryWorkerExecutionTime += executionTime;
    worker.terminate();
    return;
  }

  if (!entry) return;

  const counters = poolCounters[entry.poolType];
  
  // Update stats
  entry.tasksExecuted++;
  entry.totalExecutionTime += executionTime;
  entry.lastUsedAt = Date.now();
  if (failed) entry.failureCount++;
  
  // Track function for affinity (limit to 50 hashes per worker to bound memory)
  if (fnHash) {
    if (entry.functionHashes.size >= 50) {
      // Remove oldest (first) entry when at limit
      const oldest = entry.functionHashes.values().next().value;
      entry.functionHashes.delete(oldest);
    }
    entry.functionHashes.add(fnHash);
  }
  
  // Check for queued tasks (priority order: high > normal > low)
  const queue = queues[entry.poolType];
  const nextTask = dequeueTask(queue);
  if (nextTask && entry.busy) {
    // Immediately handle next task (no idle period)
    clearTimeout(entry.idleTimer);
    nextTask.resolve({ entry, worker: entry.worker, temporary: false });
  } else {
    // Mark as idle
    entry.busy = false;
    counters.busy--;
    counters.idle++;
    scheduleIdleTimeout(entry);
  }
}

/**
 * Requests a worker, queueing if none available.
 * 
 * ## Why Async?
 * 
 * If no workers are available, we add the task to a queue
 * and return a Promise that resolves when a worker is free.
 * This allows callers to `await` without knowing whether
 * they got an immediate worker or had to wait.
 * 
 * @param {string} poolType - 'normal' or 'generator'
 * @returns {Promise<Object>} Resolves with worker info
 * @throws {QueueFullError} If queue is at capacity
 * @internal
 */
/**
 * Gets total queue length across all priorities.
 * 
 * @param {Object} queue - Priority queue object
 * @returns {number} Total tasks in queue
 * @internal
 */
function getQueueLength(queue) {
  return queue.high.length + queue.normal.length + queue.low.length;
}

/**
 * Dequeues the highest priority task.
 * 
 * Priority order: high > normal > low
 * 
 * @param {Object} queue - Priority queue object
 * @returns {Object|null} Next task or null
 * @internal
 */
function dequeueTask(queue) {
  if (queue.high.length > 0) return queue.high.shift();
  if (queue.normal.length > 0) return queue.normal.shift();
  if (queue.low.length > 0) return queue.low.shift();
  return null;
}

/**
 * Requests a worker, queueing if none available.
 * 
 * ## Why Async?
 * 
 * If no workers are available, we add the task to a queue
 * and return a Promise that resolves when a worker is free.
 * This allows callers to `await` without knowing whether
 * they got an immediate worker or had to wait.
 * 
 * @param {string} poolType - 'normal' or 'generator'
 * @param {string} [priority='normal'] - Task priority: 'high', 'normal', 'low'
 * @param {string} [fnHash=null] - Function hash for affinity matching
 * @returns {Promise<Object>} Resolves with worker info
 * @throws {QueueFullError} If queue is at capacity
 * @internal
 */
function requestWorker(poolType, priority = 'normal', fnHash = null) {
  const result = getWorker(poolType, fnHash);
  if (result) return Promise.resolve(result);

  const queue = queues[poolType];
  if (getQueueLength(queue) >= config.maxQueueSize) {
    return Promise.reject(new QueueFullError(config.maxQueueSize));
  }

  // Validate priority
  const validPriorities = ['high', 'normal', 'low'];
  const queuePriority = validPriorities.includes(priority) ? priority : 'normal';

  return new Promise((resolve, reject) => {
    queue[queuePriority].push({ resolve, reject, queuedAt: Date.now(), fnHash });
  });
}

module.exports = {
  createWorkerEntry,
  scheduleIdleTimeout,
  getWorker,
  releaseWorker,
  requestWorker,
  warmupPool,
  getQueueLength,
  dequeueTask,
  fastHash
};
