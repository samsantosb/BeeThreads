/**
 * @fileoverview TypeScript definitions for bee-threads.
 * 
 * Type-safe API with closure and params builders.
 * 
 * @module bee-threads
 */

// ============================================================================
// ERROR CLASSES
// ============================================================================

declare class AsyncThreadError extends Error {
  readonly code: string;
  constructor(message: string, code: string);
}

declare class AbortError extends AsyncThreadError {
  readonly name: 'AbortError';
  constructor(message?: string);
}

declare class TimeoutError extends AsyncThreadError {
  readonly name: 'TimeoutError';
  readonly timeout: number;
  constructor(ms: number);
}

declare class QueueFullError extends AsyncThreadError {
  readonly name: 'QueueFullError';
  readonly maxSize: number;
  constructor(maxSize: number);
}

declare class WorkerError extends AsyncThreadError {
  readonly name: 'WorkerError';
  readonly cause?: Error;
  constructor(message: string, originalError?: Error);
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

type Awaited<T> = T extends Promise<infer U> ? Awaited<U> : T;

type UnwrapYield<T> = T extends Promise<infer U> ? U : T;

// ============================================================================
// BEE() SIMPLE CURRIED API
// ============================================================================

/**
 * Options for the simple bee() API.
 */
interface BeeOptions<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Variables to inject into worker scope */
  context?: C;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Cancellation signal */
  signal?: AbortSignal;
  /** Transferable objects for zero-copy transfer */
  transfer?: Transferable[];
  /** Retry configuration */
  retry?: RetryConfig;
  /** Task priority: 'high', 'normal', or 'low' */
  priority?: 'high' | 'normal' | 'low';
  /** If true, never throws - returns result object instead */
  safe?: boolean;
}

/**
 * Options with safe mode enabled.
 */
interface BeeOptionsSafe<C extends Record<string, unknown> = Record<string, unknown>> extends BeeOptions<C> {
  safe: true;
}

/**
 * Simple curried API for bee-threads.
 * 
 * @example
 * // Simple
 * const result = await bee(x => x * 2)(21)
 * 
 * @example
 * // With context
 * const TAX = 0.2
 * const price = await bee(p => p * (1 + TAX))(100, { context: { TAX } })
 * 
 * @example
 * // Safe mode
 * const result = await bee(fn)(arg, { safe: true })
 * if (result.status === 'rejected') console.error(result.error)
 */
interface Bee {
  /**
   * Creates a curried worker executor for a function.
   * 
   * @param fn - The function to execute in a worker thread
   * @returns A function that accepts arguments and returns a Promise
   */
  <F extends (...args: any[]) => any>(fn: F): BeeExecutor<F>;
}

/**
 * The executor returned by bee(fn).
 * Call it with arguments to execute.
 */
interface BeeExecutor<F extends (...args: any[]) => any> {
  /**
   * Execute with no arguments.
   */
  (): Promise<Awaited<ReturnType<F>>>;
  
  /**
   * Execute with arguments only.
   */
  (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>>;
  
  /**
   * Execute with arguments and options (safe mode).
   */
  <C extends Record<string, unknown>>(...args: [...Parameters<F>, BeeOptionsSafe<C>]): Promise<ThreadResult<Awaited<ReturnType<F>>>>;
  
  /**
   * Execute with arguments and options.
   */
  <C extends Record<string, unknown>>(...args: [...Parameters<F>, BeeOptions<C>]): Promise<Awaited<ReturnType<F>>>;
}

// ============================================================================
// RESULT TYPES
// ============================================================================

interface FulfilledResult<T> {
  status: 'fulfilled';
  value: T;
}

interface RejectedResult {
  status: 'rejected';
  error: Error;
}

type ThreadResult<T> = FulfilledResult<T> | RejectedResult;

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

interface ResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
}

interface RetryConfig {
  enabled?: boolean;
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
}

interface PoolConfig {
  poolSize: number;
  minThreads: number;
  maxQueueSize: number;
  maxTemporaryWorkers: number;
  workerIdleTimeout: number;
  resourceLimits: ResourceLimits;
  retry: RetryConfig;
}

interface ConfigureOptions {
  poolSize?: number;
  minThreads?: number;
  maxQueueSize?: number;
  maxTemporaryWorkers?: number;
  workerIdleTimeout?: number;
  resourceLimits?: ResourceLimits;
  retry?: RetryConfig;
}

/**
 * Task priority levels for queue ordering.
 */
type Priority = 'high' | 'normal' | 'low';

interface QueueByPriority {
  high: number;
  normal: number;
  low: number;
}

// ============================================================================
// STATS TYPES
// ============================================================================

interface WorkerStats {
  busy: boolean;
  tasksExecuted: number;
  failureCount: number;
  avgExecutionTime: number;
  uptime: number;
}

interface PoolTypeStats {
  size: number;
  busy: number;
  idle: number;
  queueLength: number;
  queueByPriority: QueueByPriority;
  workers: WorkerStats[];
}

interface GlobalMetrics {
  totalTasksExecuted: number;
  totalTasksFailed: number;
  totalRetries: number;
  temporaryWorkersCreated: number;
  activeTemporaryWorkers: number;
  temporaryWorkerTasks: number;
  avgTemporaryWorkerTime: number;
}

interface PoolStats {
  maxSize: number;
  normal: PoolTypeStats;
  generator: PoolTypeStats;
  metrics: GlobalMetrics;
  config: PoolConfig;
}

// ============================================================================
// TRANSFERABLE TYPE
// ============================================================================

type Transferable = ArrayBuffer | MessagePort | ImageBitmap | OffscreenCanvas;

// ============================================================================
// TYPE-SAFE EXECUTOR BUILDER
// ============================================================================

/**
 * Marker types for tracking what's been configured.
 * Used for compile-time checking.
 */
type Unconfigured = { readonly _brand: 'unconfigured' };
type Configured<T> = T;

/**
 * Base executor with no closure or params configured.
 * Function signature is not yet type-safe.
 */
interface ExecutorBase<
  TReturn,
  TSafe extends boolean,
  TClosure = Unconfigured,
  TParams extends any[] = Unconfigured extends any[] ? any[] : any[]
> {
  /**
   * Defines closure variables to inject into the function scope.
   * 
   * @template C - Type of closure object
   * @param closure - Object with variables to inject
   * @returns Executor with typed closure
   * 
   * @example
   * const multiplier = 10;
   * const prefix = 'Result: ';
   * 
   * await beeThreads
   *   .run((x: number, ctx: { multiplier: number; prefix: string }) => 
   *     ctx.prefix + (x * ctx.multiplier))
   *   .usingClosure({ multiplier, prefix })
   *   .usingParams(5)
   *   .execute();
   * // => 'Result: 50'
   */
  usingClosure<C extends Record<string, any>>(
    closure: C
  ): ExecutorWithClosure<TReturn, TSafe, C, TParams>;

  /**
   * Pre-binds arguments to the function (partial application).
   * 
   * @template P - Tuple type of parameters
   * @param args - Arguments to bind
   * @returns Executor with typed params
   * 
   * @example
   * await beeThreads
   *   .run((a: number, b: number) => a + b)
   *   .usingParams(10, 20)
   *   .execute();
   * // => 30
   */
  usingParams<P extends any[]>(
    ...args: P
  ): ExecutorWithParams<TReturn, TSafe, TClosure, P>;

  /**
   * Attaches an AbortSignal for cancellation.
   */
  signal(signal: AbortSignal): ExecutorBase<TReturn, TSafe, TClosure, TParams>;

  /**
   * Specifies transferable objects for zero-copy transfer.
   */
  transfer(list: Transferable[]): ExecutorBase<TReturn, TSafe, TClosure, TParams>;

  /**
   * Enables retry with exponential backoff.
   */
  retry(options?: RetryConfig): ExecutorBase<TReturn, TSafe, TClosure, TParams>;

  /**
   * Sets task priority for queue ordering.
   * Higher priority tasks are processed before lower priority tasks.
   */
  priority(level: Priority): ExecutorBase<TReturn, TSafe, TClosure, TParams>;

  /**
   * Direct invocation with arguments.
   * Only type-safe when params are not pre-bound.
   */
  <A extends any[]>(...args: A): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;

  /**
   * Explicit execution (no additional args).
   */
  execute(): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;
}

/**
 * Executor with closure configured.
 */
interface ExecutorWithClosure<
  TReturn,
  TSafe extends boolean,
  TClosure extends Record<string, any>,
  TParams extends any[]
> {
  /**
   * Pre-binds arguments after closure is set.
   */
  usingParams<P extends any[]>(
    ...args: P
  ): ExecutorComplete<TReturn, TSafe, TClosure, P>;

  signal(signal: AbortSignal): ExecutorWithClosure<TReturn, TSafe, TClosure, TParams>;
  transfer(list: Transferable[]): ExecutorWithClosure<TReturn, TSafe, TClosure, TParams>;
  retry(options?: RetryConfig): ExecutorWithClosure<TReturn, TSafe, TClosure, TParams>;
  priority(level: Priority): ExecutorWithClosure<TReturn, TSafe, TClosure, TParams>;

  <A extends any[]>(...args: A): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;

  execute(): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;
}

/**
 * Executor with params configured.
 */
interface ExecutorWithParams<
  TReturn,
  TSafe extends boolean,
  TClosure,
  TParams extends any[]
> {
  /**
   * Sets closure after params are set.
   */
  usingClosure<C extends Record<string, any>>(
    closure: C
  ): ExecutorComplete<TReturn, TSafe, C, TParams>;

  signal(signal: AbortSignal): ExecutorWithParams<TReturn, TSafe, TClosure, TParams>;
  transfer(list: Transferable[]): ExecutorWithParams<TReturn, TSafe, TClosure, TParams>;
  retry(options?: RetryConfig): ExecutorWithParams<TReturn, TSafe, TClosure, TParams>;
  priority(level: Priority): ExecutorWithParams<TReturn, TSafe, TClosure, TParams>;

  /**
   * Append more arguments.
   */
  <A extends any[]>(...args: A): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;

  execute(): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;
}

/**
 * Fully configured executor with both closure and params.
 */
interface ExecutorComplete<
  TReturn,
  TSafe extends boolean,
  TClosure extends Record<string, any>,
  TParams extends any[]
> {
  signal(signal: AbortSignal): ExecutorComplete<TReturn, TSafe, TClosure, TParams>;
  transfer(list: Transferable[]): ExecutorComplete<TReturn, TSafe, TClosure, TParams>;
  retry(options?: RetryConfig): ExecutorComplete<TReturn, TSafe, TClosure, TParams>;
  priority(level: Priority): ExecutorComplete<TReturn, TSafe, TClosure, TParams>;

  /**
   * Append additional arguments.
   */
  <A extends any[]>(...args: A): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;

  /**
   * Execute with pre-bound params.
   */
  execute(): TSafe extends true 
    ? Promise<ThreadResult<TReturn>> 
    : Promise<TReturn>;
}

// ============================================================================
// STREAM EXECUTOR BUILDER (TYPE-SAFE)
// ============================================================================

interface ReadableStreamWithReturn<T, R = any> extends ReadableStream<T> {
  readonly returnValue: R | undefined;
}

/**
 * Stream executor base.
 */
interface StreamExecutorBase<TYield, TReturn> {
  /**
   * Defines closure variables for generator.
   */
  usingClosure<C extends Record<string, any>>(
    closure: C
  ): StreamExecutorWithClosure<TYield, TReturn, C>;

  /**
   * Direct invocation.
   */
  <A extends any[]>(...args: A): ReadableStreamWithReturn<TYield, TReturn>;
}

/**
 * Stream executor with closure configured.
 */
interface StreamExecutorWithClosure<
  TYield,
  TReturn,
  TClosure extends Record<string, any>
> {
  /**
   * Invoke with arguments.
   */
  <A extends any[]>(...args: A): ReadableStreamWithReturn<TYield, TReturn>;
}

// ============================================================================
// CURRIED RUNNERS
// ============================================================================

/**
 * Creates an executor from a function.
 * 
 * @example
 * // Simple (no closure)
 * const result = await beeThreads.run((a, b) => a + b)(1, 2);
 * 
 * // With closure (type-safe)
 * const factor = 10;
 * const result = await beeThreads
 *   .run((x: number, ctx: { factor: number }) => x * ctx.factor)
 *   .usingClosure({ factor })
 *   .usingParams(5)
 *   .execute();
 */
interface CurriedRunner {
  <TReturn>(fn: (...args: any[]) => TReturn): ExecutorBase<Awaited<TReturn>, false>;
}

/**
 * Creates a safe executor (never throws).
 */
interface SafeCurriedRunner {
  <TReturn>(fn: (...args: any[]) => TReturn): ExecutorBase<Awaited<TReturn>, true>;
}

/**
 * Creates a stream executor from a generator.
 * 
 * @example
 * // Simple
 * const stream = beeThreads.stream(function* (n) {
 *   for (let i = 0; i < n; i++) yield i;
 * })(5);
 * 
 * // With closure
 * const multiplier = 2;
 * const stream = beeThreads
 *   .stream(function* (n: number, ctx: { multiplier: number }) {
 *     for (let i = 0; i < n; i++) yield i * ctx.multiplier;
 *   })
 *   .usingClosure({ multiplier })(5);
 */
interface StreamRunner {
  <TYield, TReturn = void>(
    genFn: (...args: any[]) => Generator<TYield | Promise<TYield>, TReturn, any>
  ): StreamExecutorBase<UnwrapYield<TYield>, TReturn>;

  <TYield, TReturn = void>(
    genFn: (...args: any[]) => AsyncGenerator<TYield, TReturn, any>
  ): StreamExecutorBase<TYield, TReturn>;
}

// ============================================================================
// MAIN API
// ============================================================================

/**
 * bee-threads main API interface.
 */
interface BeeThreads {
  /**
   * Runs a function in a worker thread.
   * 
   * @example
   * // Direct execution
   * await beeThreads.run((a, b) => a + b)(1, 2);
   * 
   * // With type-safe closure
   * await beeThreads
   *   .run((x: number, ctx: { factor: number }) => x * ctx.factor)
   *   .usingClosure({ factor: 10 })
   *   .usingParams(5)
   *   .execute();
   */
  run: CurriedRunner;

  /**
   * Runs a function in safe mode (never throws).
   * Returns `{ status, value, error }`.
   */
  safeRun: SafeCurriedRunner;

  /**
   * Creates a runner with timeout.
   */
  withTimeout(ms: number): CurriedRunner;

  /**
   * Creates a safe runner with timeout.
   */
  safeWithTimeout(ms: number): SafeCurriedRunner;

  /**
   * Streams values from a generator.
   * 
   * @example
   * const stream = beeThreads.stream(function* (n) {
   *   for (let i = 0; i < n; i++) yield i * i;
   * })(5);
   * 
   * for await (const value of stream) {
   *   console.log(value); // 0, 1, 4, 9, 16
   * }
   */
  stream: StreamRunner;

  /**
   * Configures pool settings.
   */
  configure(options: ConfigureOptions): void;

  /**
   * Pre-creates workers to eliminate cold-start latency.
   * @param count - Number of workers to create (default: minThreads)
   */
  warmup(count?: number): Promise<void>;

  /**
   * Gracefully shuts down all workers.
   */
  shutdown(): Promise<void>;

  /**
   * Returns current pool statistics.
   */
  getPoolStats(): Readonly<PoolStats>;
}

// ============================================================================
// EXPORTS
// ============================================================================

declare const beeThreads: BeeThreads;

declare const bee: Bee;

export { 
  bee,
  beeThreads,
  AbortError, 
  TimeoutError, 
  QueueFullError, 
  WorkerError,
  AsyncThreadError 
};

export type {
  Bee,
  BeeOptions,
  BeeOptionsSafe,
  BeeExecutor,
  BeeThreads,
  ThreadResult,
  FulfilledResult,
  RejectedResult,
  PoolStats,
  PoolConfig,
  ConfigureOptions,
  PoolTypeStats,
  WorkerStats,
  GlobalMetrics,
  ResourceLimits,
  RetryConfig,
  CurriedRunner,
  SafeCurriedRunner,
  StreamRunner,
  ExecutorBase,
  ExecutorWithClosure,
  ExecutorWithParams,
  ExecutorComplete,
  StreamExecutorBase,
  StreamExecutorWithClosure,
  ReadableStreamWithReturn,
  Transferable,
};
