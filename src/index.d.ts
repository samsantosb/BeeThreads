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
 * Closures object for bee() simple API.
 * Pass external variables to the worker.
 */
interface BeeClosures<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Variables to inject into worker scope */
  beeClosures: C;
}

/**
 * Simple curried API for bee-threads.
 * 
 * Minimal syntax - only supports params and closures.
 * For advanced features (timeout, retry, etc), use beeThreads.
 * 
 * @example
 * // No params
 * await bee(() => 42)
 * 
 * @example
 * // With params
 * await bee(x => x * 2)(21)
 * 
 * @example
 * // Curried
 * await bee((a, b, c) => a + b + c)(1)(2)(3)
 * 
 * @example
 * // With closures
 * const TAX = 0.2
 * await bee(p => p * (1 + TAX))(100)({ beeClosures: { TAX } })
 */
interface Bee {
  /**
   * Creates a curried worker executor for a function.
   * 
   * @param fn - The function to execute in a worker thread
   * @returns A thenable curried function
   */
  <F extends (...args: any[]) => any>(fn: F): BeeCurry<F, []>;
}

/**
 * Curried executor returned by bee(fn).
 * Must be called with () to execute when no params.
 */
interface BeeCurry<F extends (...args: any[]) => any, AccArgs extends any[]> {
  /**
   * Execute with no more arguments.
   */
  (): Promise<Awaited<ReturnType<F>>>;
  
  /**
   * Execute with closures.
   */
  <C extends Record<string, unknown>>(closures: BeeClosures<C>): Promise<Awaited<ReturnType<F>>>;
  
  /**
   * Add more arguments (continues currying, returns thenable).
   */
  <Args extends any[]>(...args: Args): BeeCurryThenable<F, [...AccArgs, ...Args]>;
}

/**
 * Curried executor with arguments (thenable).
 * Can be awaited or called with more arguments.
 */
interface BeeCurryThenable<F extends (...args: any[]) => any, AccArgs extends any[]> extends PromiseLike<Awaited<ReturnType<F>>> {
  /**
   * Execute with no more arguments.
   */
  (): Promise<Awaited<ReturnType<F>>>;
  
  /**
   * Execute with closures.
   */
  <C extends Record<string, unknown>>(closures: BeeClosures<C>): Promise<Awaited<ReturnType<F>>>;
  
  /**
   * Add more arguments (continues currying).
   */
  <Args extends any[]>(...args: Args): BeeCurryThenable<F, [...AccArgs, ...Args]>;
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
  /** Number of functions cached in this worker for affinity */
  cachedFunctions: number;
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
  /** Number of times a worker with cached function was found (affinity hit) */
  affinityHits: number;
  /** Number of times no worker with cached function was found */
  affinityMisses: number;
  /** Affinity hit rate as percentage string (e.g. "75.3%") */
  affinityHitRate: string;
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
   * Injects external variables into the function scope.
   * 
   * @template C - Type of context object
   * @param context - Object with variables to inject
   * @returns Executor with typed context
   * 
   * @example
   * const multiplier = 10;
   * const prefix = 'Result: ';
   * 
   * await beeThreads
   *   .run((x) => prefix + (x * multiplier))
   *   .setContext({ multiplier, prefix })
   *   .usingParams(5)
   *   .execute();
   * // => 'Result: 50'
   */
  setContext<C extends Record<string, any>>(
    context: C
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
   * Sets context after params are set.
   */
  setContext<C extends Record<string, any>>(
    context: C
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
   * Injects context variables for generator.
   */
  setContext<C extends Record<string, any>>(
    context: C
  ): StreamExecutorWithClosure<TYield, TReturn, C>;

  /**
   * Pre-binds arguments.
   */
  usingParams<P extends any[]>(...args: P): StreamExecutorBase<TYield, TReturn>;

  /**
   * Direct invocation.
   */
  <A extends any[]>(...args: A): ReadableStreamWithReturn<TYield, TReturn>;

  /**
   * Execute the stream.
   */
  execute(): ReadableStreamWithReturn<TYield, TReturn>;
}

/**
 * Stream executor with context configured.
 */
interface StreamExecutorWithClosure<
  TYield,
  TReturn,
  TClosure extends Record<string, any>
> {
  /**
   * Pre-binds arguments.
   */
  usingParams<P extends any[]>(...args: P): StreamExecutorWithClosure<TYield, TReturn, TClosure>;

  /**
   * Invoke with arguments.
   */
  <A extends any[]>(...args: A): ReadableStreamWithReturn<TYield, TReturn>;

  /**
   * Execute the stream.
   */
  execute(): ReadableStreamWithReturn<TYield, TReturn>;
}

// ============================================================================
// CURRIED RUNNERS
// ============================================================================

/**
 * Creates an executor from a function.
 * 
 * @example
 * // Simple
 * const result = await beeThreads.run((a, b) => a + b)(1, 2);
 * 
 * // With context (external variables)
 * const factor = 10;
 * const result = await beeThreads
 *   .run((x) => x * factor)
 *   .setContext({ factor })
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
 * }).usingParams(5).execute();
 * 
 * // With context
 * const multiplier = 2;
 * const stream = beeThreads
 *   .stream(function* (n) {
 *     for (let i = 0; i < n; i++) yield i * multiplier;
 *   })
 *   .setContext({ multiplier })
 *   .usingParams(5)
 *   .execute();
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
   * // With context (external variables)
   * const factor = 10;
   * await beeThreads
   *   .run((x) => x * factor)
   *   .setContext({ factor })
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
   * Executes multiple tasks in parallel, rejecting on first error.
   * Similar to Promise.all().
   * 
   * @example
   * const [a, b, c] = await beeThreads.all([
   *   [(x) => x * 2, [21]],
   *   [(a, b) => a + b, [10, 20]],
   *   [() => 'hello']
   * ]);
   * 
   * @example
   * // With shared context
   * const TAX = 0.2;
   * const [p1, p2] = await beeThreads.all([
   *   [(p) => p * (1 + TAX), [100]],
   *   [(p) => p * (1 + TAX), [200]],
   * ], { context: { TAX } });
   */
  all<T extends any[]>(
    tasks: Array<[(...args: any[]) => any, any[]?, Record<string, any>?]>,
    options?: { context?: Record<string, any>; timeout?: number }
  ): Promise<T>;

  /**
   * Executes multiple tasks in parallel, always returning all results.
   * Similar to Promise.allSettled() - never throws.
   * 
   * @example
   * const results = await beeThreads.allSettled([
   *   [() => 'success'],
   *   [() => { throw new Error('fail'); }],
   *   [() => 42]
   * ]);
   * // [
   * //   { status: 'fulfilled', value: 'success' },
   * //   { status: 'rejected', reason: Error },
   * //   { status: 'fulfilled', value: 42 }
   * // ]
   */
  allSettled(
    tasks: Array<[(...args: any[]) => any, any[]?, Record<string, any>?]>,
    options?: { context?: Record<string, any>; timeout?: number }
  ): Promise<PromiseSettledResult<any>[]>;

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
  BeeClosures,
  BeeCurry,
  BeeCurryThenable,
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
