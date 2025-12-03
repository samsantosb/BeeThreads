/**
 * @fileoverview Configuration and state management for bee-threads.
 *
 * ## Why This File Exists
 *
 * Centralizes all mutable state and configuration in one place.
 * This makes it easier to:
 * - Track what state exists
 * - Reset state for testing
 * - Understand the system's global state
 *
 * ## State Categories
 *
 * 1. **Configuration** (`config`) - User-configurable settings
 * 2. **Pools** (`pools`) - Active worker instances
 * 3. **Counters** (`poolCounters`) - O(1) access to pool state
 * 4. **Queues** (`queues`) - Pending tasks waiting for workers
 * 5. **Metrics** (`metrics`) - Execution statistics
 *
 * @module bee-threads/config
 * @internal
 */

import * as os from 'os';
import * as path from 'path';
import type {
  PoolConfig,
  WorkerEntry,
  PoolCounters,
  PriorityQueues,
  Metrics,
  PoolType
} from './types';

// ============================================================================
// WORKER SCRIPTS
// ============================================================================

/**
 * Paths to worker thread scripts.
 *
 * Two separate scripts exist because regular functions and generators
 * have different communication patterns with the main thread.
 *
 * @internal
 */
export const SCRIPTS: Record<PoolType, string> = {
  normal: path.join(__dirname, 'worker.js'),
  generator: path.join(__dirname, 'generator-worker.js')
};

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Global pool configuration.
 *
 * These values can be changed via `beeThreads.configure()`.
 * Changes affect new workers only (existing workers keep old config).
 *
 * @internal
 */
export const config: PoolConfig = {
  // Default to (CPU cores - 1) to leave one core for main thread
  // Minimum 2 to allow some parallelism even on single-core
  poolSize: Math.max(2, os.cpus().length - 1),

  // Minimum workers to keep alive (warm pool)
  // These workers are never terminated by idle timeout
  minThreads: 0,

  // Queue settings
  maxQueueSize: 1000,
  maxTemporaryWorkers: 10,

  // Worker lifecycle
  workerIdleTimeout: 30000, // 30 seconds

  // Function cache size per worker (for compiled functions)
  functionCacheSize: 100,

  /**
   * Low memory mode for memory-constrained environments.
   *
   * When enabled:
   * - Function cache size reduced to 10 (default: 100) → ~35-50% less memory
   * - Validation cache disabled → ~10-20% less memory
   * - Worker affinity tracking disabled → ~15-25% less memory
   *
   * Total reduction: ~60-80% less memory
   * Trade-off: Slower repeated executions (no caching benefits)
   *
   * Use cases: IoT devices, serverless functions, containers with memory limits
   */
  lowMemoryMode: false,

  // V8 resource limits for workers
  resourceLimits: {
    maxOldGenerationSizeMb: 512,
    maxYoungGenerationSizeMb: 128,
    codeRangeSizeMb: 64
  },

  // Retry defaults (disabled by default)
  retry: {
    enabled: false,
    maxAttempts: 3,
    baseDelay: 100,
    maxDelay: 5000,
    backoffFactor: 2
  },

  /**
   * Debug mode for development.
   * Auto-enabled when NODE_ENV !== 'production'.
   *
   * When enabled:
   * - Function source code included in error messages
   * - More verbose error logging in workers
   */
  debugMode: process.env.NODE_ENV !== 'production',

  /**
   * Logger for worker log forwarding.
   * Default: console
   * Set to null to disable logging.
   */
  logger: console as PoolConfig['logger']
};

// ============================================================================
// POOL STATE
// ============================================================================

/**
 * Worker pools organized by type.
 *
 * Separate pools for normal and generator workers because they
 * have different behaviors and message protocols.
 *
 * @internal
 */
export const pools: Record<PoolType, WorkerEntry[]> = {
  normal: [],
  generator: []
};

/**
 * Fast counters for O(1) pool state checks.
 *
 * ## Why This Exists
 *
 * Instead of iterating the pool array to count busy/idle workers,
 * we maintain separate counters. This makes `getWorker()` faster
 * for the common case of checking if idle workers exist.
 *
 * @internal
 */
export const poolCounters: Record<PoolType, PoolCounters> = {
  normal: { busy: 0, idle: 0 },
  generator: { busy: 0, idle: 0 }
};

/**
 * Task queues for when all workers are busy.
 *
 * Tasks are organized by priority (high, normal, low).
 * Within each priority, FIFO order ensures fairness.
 *
 * @internal
 */
export const queues: Record<PoolType, PriorityQueues> = {
  normal: { high: [], normal: [], low: [] },
  generator: { high: [], normal: [], low: [] }
};

/**
 * Global execution metrics.
 *
 * Used for monitoring and debugging.
 * Never reset automatically (reset by calling shutdown + reinitialize).
 *
 * @internal
 */
export const metrics: Metrics = {
  totalTasksExecuted: 0,
  totalTasksFailed: 0,
  totalRetries: 0,
  temporaryWorkersCreated: 0,
  activeTemporaryWorkers: 0,
  temporaryWorkerExecutionTime: 0,
  temporaryWorkerTasks: 0,
  // Affinity metrics
  affinityHits: 0,
  affinityMisses: 0
};

