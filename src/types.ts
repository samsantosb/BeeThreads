/**
 * @fileoverview Type definitions for bee-threads.
 * @module bee-threads/types
 */

import type { Worker } from 'worker_threads';

// ============================================================================
// POOL TYPES
// ============================================================================

/** Type of worker pool */
export type PoolType = 'normal' | 'generator';

/** Task priority levels */
export type Priority = 'high' | 'normal' | 'low';

// ============================================================================
// CONFIGURATION
// ============================================================================

/** V8 resource limits for workers */
export interface ResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
}

/** Retry configuration */
export interface RetryConfig {
  enabled: boolean;
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffFactor: number;
}

/** Global pool configuration */
export interface PoolConfig {
  poolSize: number;
  minThreads: number;
  maxQueueSize: number;
  maxTemporaryWorkers: number;
  workerIdleTimeout: number;
  functionCacheSize: number;
  lowMemoryMode: boolean;
  resourceLimits: ResourceLimits;
  retry: RetryConfig;
  /**
   * Debug mode - when enabled:
   * - Includes function source code in error messages
   * - More verbose error logging
   * - Useful for development, disable in production
   */
  debugMode: boolean;
  /**
   * Logger instance for worker log forwarding.
   * null = logging disabled
   */
  logger: Logger | null;
}

/** User-configurable options (all optional) */
export interface ConfigureOptions {
  poolSize?: number;
  minThreads?: number;
  maxQueueSize?: number;
  maxTemporaryWorkers?: number;
  workerIdleTimeout?: number;
  functionCacheSize?: number;
  lowMemoryMode?: boolean;
  resourceLimits?: ResourceLimits;
  /**
   * Debug mode - includes function source in errors for easier debugging.
   * Auto-enabled when NODE_ENV !== 'production'
   */
  debugMode?: boolean;
  /**
   * Custom logger instance (Pino, Winston, console, etc).
   * Set to null to disable worker log forwarding.
   * @default console
   */
  logger?: Logger | null;
}

// ============================================================================
// WORKER TYPES
// ============================================================================

/** Worker entry in the pool */
export interface WorkerEntry {
  worker: Worker;
  busy: boolean;
  id: number;
  tasksExecuted: number;
  failedTasks: number;
  totalExecutionTime: number;
  temporary: boolean;
  terminationTimer: ReturnType<typeof setTimeout> | null;
  cachedFunctions: Set<string>;
}

/** Worker info returned by pool operations */
export interface WorkerInfo {
  worker: Worker;
  entry: WorkerEntry;
  temporary: boolean;
}

// ============================================================================
// TASK TYPES
// ============================================================================

/** Task waiting in queue */
export interface QueuedTask {
  fnString: string;
  args: unknown[];
  context: Record<string, unknown> | null;
  transfer: ArrayBuffer[];
  resolve: (info: WorkerInfo) => void;
  reject: (error: Error) => void;
  priority: Priority;
}

/** Queues organized by priority */
export interface PriorityQueues {
  high: QueuedTask[];
  normal: QueuedTask[];
  low: QueuedTask[];
}

// ============================================================================
// EXECUTION TYPES
// ============================================================================

/** Options for task execution */
export interface ExecutionOptions {
  safe?: boolean;
  timeout?: number | null;
  poolType?: PoolType;
  transfer?: ArrayBuffer[];
  signal?: AbortSignal | null;
  context?: Record<string, unknown> | null;
  priority?: Priority;
}

/** Retry options for executor */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

// ============================================================================
// MESSAGE TYPES (Worker Communication)
// ============================================================================

/**
 * Message type constants for worker communication.
 * Using const object instead of enum for better tree-shaking and runtime performance.
 */
export const MessageType = {
  /** Successful task completion */
  SUCCESS: 'success',
  /** Task error */
  ERROR: 'error',
  /** Console log forwarding */
  LOG: 'log',
  /** Generator yield */
  YIELD: 'yield',
  /** Generator return value */
  RETURN: 'return',
  /** Generator/stream end */
  END: 'end',
} as const;

/** Message type union */
export type MessageTypeValue = typeof MessageType[keyof typeof MessageType];

/** Log levels for console forwarding */
export const LogLevel = {
  LOG: 'log',
  WARN: 'warn',
  ERROR: 'error',
  INFO: 'info',
  DEBUG: 'debug',
} as const;

export type LogLevelValue = typeof LogLevel[keyof typeof LogLevel];

/** Message sent to worker */
export interface WorkerMessage {
  fn: string;
  args: unknown[];
  context?: Record<string, unknown> | null;
}

/** Serialized error for cross-thread transmission */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** Original function code (only in debug mode) */
  code?: string;
}

/** Successful result from worker */
export interface WorkerSuccessResponse {
  type: typeof MessageType.SUCCESS;
  value: unknown;
}

/** Error result from worker */
export interface WorkerErrorResponse {
  type: typeof MessageType.ERROR;
  error: SerializedError;
}

/** Log message from worker */
export interface WorkerLogMessage {
  type: typeof MessageType.LOG;
  level: LogLevelValue;
  args: string[];
}

/** Worker response types (discriminated union) */
export type WorkerResponse = 
  | WorkerSuccessResponse 
  | WorkerErrorResponse 
  | WorkerLogMessage;

// Legacy support - will be removed in v4
/** @deprecated Use WorkerSuccessResponse with type field instead */
export interface LegacySuccessResponse {
  ok: true;
  value: unknown;
}

/** @deprecated Use WorkerErrorResponse with type field instead */
export interface LegacyErrorResponse {
  ok: false;
  error: SerializedError;
}

/** Combined response type for backwards compatibility */
export type WorkerResponseCompat = 
  | WorkerSuccessResponse 
  | WorkerErrorResponse 
  | WorkerLogMessage
  | LegacySuccessResponse
  | LegacyErrorResponse;

// ============================================================================
// GENERATOR/STREAM TYPES
// ============================================================================

/** Generator yield message */
export interface GeneratorYieldMessage {
  type: typeof MessageType.YIELD;
  value: unknown;
}

/** Generator return message */
export interface GeneratorReturnMessage {
  type: typeof MessageType.RETURN;
  value: unknown;
}

/** Generator end message */
export interface GeneratorEndMessage {
  type: typeof MessageType.END;
}

/** Generator error message */
export interface GeneratorErrorMessage {
  type: typeof MessageType.ERROR;
  error: SerializedError;
}

/** All generator message types (discriminated union) */
export type GeneratorMessage =
  | GeneratorYieldMessage
  | GeneratorReturnMessage
  | GeneratorEndMessage
  | GeneratorErrorMessage
  | WorkerLogMessage;

// ============================================================================
// METRICS TYPES
// ============================================================================

/** Global execution metrics */
export interface Metrics {
  totalTasksExecuted: number;
  totalTasksFailed: number;
  totalRetries: number;
  temporaryWorkersCreated: number;
  activeTemporaryWorkers: number;
  temporaryWorkerExecutionTime: number;
  temporaryWorkerTasks: number;
  affinityHits: number;
  affinityMisses: number;
}

/** Pool counters */
export interface PoolCounters {
  busy: number;
  idle: number;
}

// ============================================================================
// STATS TYPES
// ============================================================================

/** Individual worker stats */
export interface WorkerStats {
  id: number;
  busy: boolean;
  tasksExecuted: number;
  failedTasks: number;
  avgExecutionTime: number;
  temporary: boolean;
  cachedFunctions: number;
}

/** Queue stats by priority */
export interface QueueByPriority {
  high: number;
  normal: number;
  low: number;
}

/** Pool-specific stats */
export interface PoolStats {
  size: number;
  busy: number;
  idle: number;
  queued: number;
  queueByPriority: QueueByPriority;
  workers: WorkerStats[];
}

/** Complete pool statistics */
export interface FullPoolStats {
  maxSize: number;
  normal: PoolStats;
  generator: PoolStats;
  config: {
    poolSize: number;
    minThreads: number;
    maxQueueSize: number;
    maxTemporaryWorkers: number;
    workerIdleTimeout: number;
    resourceLimits: ResourceLimits;
    functionCacheSize: number;
    lowMemoryMode: boolean;
  };
  metrics: Metrics & {
    affinityHitRate: string;
  };
}

// ============================================================================
// FUNCTION TYPES
// ============================================================================

/** Any function that can be run in a worker */
export type WorkerFunction<TArgs extends unknown[] = unknown[], TReturn = unknown> = (
  ...args: TArgs
) => TReturn;

/** Async function for workers */
export type AsyncWorkerFunction<TArgs extends unknown[] = unknown[], TReturn = unknown> = (
  ...args: TArgs
) => Promise<TReturn>;

/** Generator function for streaming */
export type GeneratorWorkerFunction<TArgs extends unknown[] = unknown[], TYield = unknown, TReturn = unknown> = (
  ...args: TArgs
) => Generator<TYield, TReturn, unknown>;

// ============================================================================
// CACHE TYPES
// ============================================================================

/** LRU Cache interface */
export interface LRUCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  has(key: string): boolean;
  clear(): void;
  size(): number;
  stats(): { size: number; maxSize: number };
}

/** Function cache stats */
export interface FunctionCacheStats {
  hits: number;
  misses: number;
  hitRate: string;
  size: number;
  maxSize: number;
}

/** Function cache interface */
export interface FunctionCache {
  getOrCompile(fnString: string, context?: Record<string, unknown> | null): Function;
  clear(): void;
  stats(): FunctionCacheStats;
}

// ============================================================================
// LOGGER TYPES
// ============================================================================

/**
 * Logger interface - compatible with Pino, Winston, console, etc.
 * 
 * @example
 * // Use default (console)
 * beeThreads.configure({ logger: console });
 * 
 * // Use Pino
 * import pino from 'pino';
 * beeThreads.configure({ logger: pino() });
 * 
 * // Use Winston
 * import winston from 'winston';
 * beeThreads.configure({ logger: winston.createLogger({...}) });
 * 
 * // Disable logging
 * beeThreads.configure({ logger: null });
 */
export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/** Noop logger for disabling logs */
export const noopLogger: Logger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  info: () => {},
  debug: () => {},
};

