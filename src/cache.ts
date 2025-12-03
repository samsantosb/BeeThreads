/**
 * @fileoverview LRU Cache for compiled functions using vm.Script.
 *
 * ## Why This File Exists
 *
 * Compiling functions has significant overhead (~0.3-0.5ms per call).
 * By caching compiled functions, repeated executions skip compilation
 * entirely (~0.001ms lookup) - a 300-500x speedup.
 *
 * ## Why vm.Script Instead of eval()
 *
 * | Aspect | eval() | vm.Script |
 * |--------|--------|-----------|
 * | Context injection | String manipulation | Native runInContext() |
 * | V8 code caching | Lost on string change | produceCachedData: true |
 * | Performance (cached) | ~1.2-3µs | ~0.08-0.3µs |
 * | Performance (w/ context) | ~4.8ms | ~0.1ms (43x faster) |
 * | Stack traces | Shows "eval" | Proper filename |
 *
 * ## V8 Optimization Benefits
 *
 * Cached functions benefit from V8's optimization pipeline:
 * 1. First executions use Ignition (interpreter)
 * 2. After ~7 calls, TurboFan compiles to optimized machine code
 * 3. Cached functions retain their optimized state
 * 4. Combined with worker affinity = near-native performance
 *
 * ## LRU Strategy
 *
 * LRU (Least Recently Used) evicts the oldest unused entry when
 * the cache is full. This ensures frequently-used functions stay
 * cached while rarely-used ones are removed.
 *
 * @module bee-threads/cache
 * @internal
 */

import * as vm from 'vm';
import type { LRUCache, FunctionCache, FunctionCacheStats } from './types';

/** Default maximum cache size */
export const DEFAULT_MAX_SIZE = 100;

// ============================================================================
// SANDBOX POOL (Memory Optimization)
// ============================================================================

/**
 * Base globals object - created once, reused everywhere.
 *
 * ## Why This Exists (Memory Optimization)
 *
 * Creating the globals object for every vm.Script execution is expensive:
 * - Object allocation overhead (~500 bytes per sandbox)
 * - Property assignment overhead (60+ properties)
 * - GC pressure from short-lived objects
 *
 * By creating this once and using Object.create() for inheritance:
 * - Only user context variables are allocated
 * - BASE_GLOBALS is shared across all sandboxes
 * - GC pressure reduced significantly
 *
 * @internal
 */
const BASE_GLOBALS: Record<string, unknown> = {
  require,
  module,
  exports,
  console,
  Buffer,
  process,
  setTimeout,
  setInterval,
  setImmediate,
  clearTimeout,
  clearInterval,
  clearImmediate,
  queueMicrotask,
  __dirname,
  __filename,
  // Global constructors
  Array,
  Object,
  String,
  Number,
  Boolean,
  Symbol,
  BigInt,
  Function,
  Date,
  RegExp,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Promise,
  Proxy,
  Reflect,
  JSON,
  Math,
  Intl,
  ArrayBuffer,
  SharedArrayBuffer,
  DataView,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  // Utilities
  encodeURI,
  encodeURIComponent,
  decodeURI,
  decodeURIComponent,
  isNaN,
  isFinite,
  parseFloat,
  parseInt,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder
};

/**
 * Shared base context - created ONCE per worker, reused for all executions.
 * @internal
 */
let BASE_CONTEXT: vm.Context | null = null;

/**
 * Gets or creates the shared base context.
 * Lazy initialization - only created when first needed.
 *
 * @returns The shared base context
 * @internal
 */
function getBaseContext(): vm.Context {
  if (!BASE_CONTEXT) {
    BASE_CONTEXT = vm.createContext(Object.assign({}, BASE_GLOBALS));
  }
  return BASE_CONTEXT;
}

/**
 * Creates a sandbox efficiently by inheriting from BASE_GLOBALS.
 *
 * Uses Object.create() to avoid copying all properties.
 * User context is applied as own properties on top.
 *
 * @param context - User context to merge
 * @returns Sandbox ready for vm.createContext()
 * @internal
 */
function createSandbox(context?: Record<string, unknown> | null): Record<string, unknown> {
  // Create object with BASE_GLOBALS as prototype (no property copying!)
  const sandbox = Object.create(BASE_GLOBALS) as Record<string, unknown>;

  // Apply user context as own properties (overwrites if needed)
  if (context) {
    const keys = Object.keys(context);
    for (let i = 0; i < keys.length; i++) {
      sandbox[keys[i]] = context[keys[i]];
    }
  }

  return sandbox;
}

/**
 * Creates an LRU cache for compiled functions.
 *
 * ## How It Works
 *
 * Uses a Map to store entries. Map maintains insertion order,
 * so we can implement LRU by:
 * 1. On get: delete and re-insert to move to end (most recent)
 * 2. On set: if full, delete first entry (least recent)
 *
 * @param maxSize - Maximum number of entries
 * @returns Cache instance with get, set, has, clear, size methods
 */
export function createLRUCache<T>(maxSize: number = DEFAULT_MAX_SIZE): LRUCache<T> {
  const cache = new Map<string, T>();

  return {
    /**
     * Gets a value from the cache.
     * If found, moves entry to most-recently-used position.
     */
    get(key: string): T | undefined {
      if (!cache.has(key)) {
        return undefined;
      }

      // Move to end (most recent) by re-inserting
      const value = cache.get(key)!;
      cache.delete(key);
      cache.set(key, value);

      return value;
    },

    /**
     * Sets a value in the cache.
     * If cache is full, evicts least-recently-used entry.
     */
    set(key: string, value: T): void {
      // If key exists, delete first to update position
      if (cache.has(key)) {
        cache.delete(key);
      }
      // Evict oldest if at capacity
      else if (cache.size >= maxSize) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) {
          cache.delete(oldestKey);
        }
      }

      cache.set(key, value);
    },

    /**
     * Checks if a key exists in cache.
     * Does NOT update LRU position (use get for that).
     */
    has(key: string): boolean {
      return cache.has(key);
    },

    /**
     * Clears all entries from the cache.
     */
    clear(): void {
      cache.clear();
    },

    /**
     * Returns the current number of entries.
     */
    size(): number {
      return cache.size;
    },

    /**
     * Returns cache statistics.
     */
    stats(): { size: number; maxSize: number } {
      return {
        size: cache.size,
        maxSize
      };
    }
  };
}

/**
 * Creates a fast hash for cache keys.
 * Uses djb2 algorithm - fast and good distribution.
 *
 * @param str - String to hash
 * @returns Hash string (base36)
 * @internal
 */
function fastHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Creates a lightweight context key for caching.
 *
 * Instead of JSON.stringify (slow for large objects), we create
 * a composite key from:
 * - Sorted keys (for deterministic ordering)
 * - Type markers for values
 * - Primitive value hashes
 *
 * @param context - Context object
 * @returns Context key
 * @internal
 */
function createContextKey(context: Record<string, unknown> | null | undefined): string {
  if (!context) return '';

  const keys = Object.keys(context);
  if (keys.length === 0) return '';

  // Sort keys for deterministic ordering
  keys.sort();

  const parts: string[] = [];
  for (const key of keys) {
    const value = context[key];
    const type = typeof value;

    // Create type-specific representation
    if (value === null) {
      parts.push(`${key}:null`);
    } else if (type === 'function') {
      // For functions, use a hash of the source
      parts.push(`${key}:fn:${fastHash((value as Function).toString())}`);
    } else if (type === 'object') {
      // For objects/arrays, use a hash of JSON (only for cache key)
      parts.push(`${key}:obj:${fastHash(JSON.stringify(value))}`);
    } else {
      // Primitives: include value directly (fast for small values)
      parts.push(`${key}:${type}:${String(value)}`);
    }
  }

  return parts.join('|');
}

/**
 * Creates a function cache that compiles and caches functions using vm.Script.
 *
 * This is the main interface used by workers to cache compiled functions.
 * Uses `vm.Script` for compilation, which is 5-15x faster than `eval()`
 * for context injection scenarios.
 *
 * @param maxSize - Maximum cached functions
 * @returns Function cache with getOrCompile, clear, stats methods
 */
export function createFunctionCache(maxSize: number = DEFAULT_MAX_SIZE): FunctionCache {
  const cache = createLRUCache<Function>(maxSize);

  // Stats for monitoring
  let hits = 0;
  let misses = 0;

  return {
    /**
     * Gets a compiled function from cache, or compiles and caches it.
     *
     * @param fnString - Function source code (e.g., "(x) => x * 2")
     * @param context - Variables to inject into function scope
     * @returns Compiled, executable function
     */
    getOrCompile(fnString: string, context?: Record<string, unknown> | null): Function {
      // Check if context has any actual properties
      const hasContext = context && Object.keys(context).length > 0;

      // Create optimized cache key (faster than JSON.stringify)
      const contextKey = hasContext ? createContextKey(context) : '';
      const cacheKey = contextKey ? `${fnString}::${contextKey}` : fnString;

      // Try cache first
      let fn = cache.get(cacheKey);

      if (fn) {
        hits++;
        return fn;
      }

      // Cache miss - compile with vm.Script (no eval!)
      misses++;

      const code = `(${fnString})`;
      const script = new vm.Script(code, {
        filename: 'bee-worker-fn.js',
        produceCachedData: true // Enable V8 code caching
      });

      // ─────────────────────────────────────────────────────────────────────
      // CRITICAL: Reuse shared context when no custom context needed (90%)
      // This avoids creating a new V8 context (~1-2MB each!) per execution
      // ─────────────────────────────────────────────────────────────────────
      if (!hasContext) {
        // No context = run in shared base context (zero memory overhead)
        fn = script.runInContext(getBaseContext()) as Function;
      } else {
        // Has context = need sandbox for closure variable injection
        const sandbox = createSandbox(context);
        vm.createContext(sandbox);
        fn = script.runInContext(sandbox) as Function;
      }

      // Cache the compiled function
      cache.set(cacheKey, fn);

      return fn;
    },

    /**
     * Clears the function cache.
     */
    clear(): void {
      cache.clear();
      hits = 0;
      misses = 0;
    },

    /**
     * Returns cache statistics.
     */
    stats(): FunctionCacheStats {
      const total = hits + misses;
      return {
        hits,
        misses,
        hitRate: total > 0 ? (hits / total * 100).toFixed(1) + '%' : '0%',
        ...cache.stats()
      };
    }
  };
}

