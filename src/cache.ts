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
import type { LRUCache, FunctionCache, FunctionCacheStats, LRUCacheEntry } from './types';

/** Default maximum cache size */
export const DEFAULT_MAX_SIZE = 100;

/** Default TTL for cache entries in milliseconds */
export const DEFAULT_TTL = 0; // 0 = no expiration

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
  require: typeof require !== 'undefined' ? require : undefined,
  module: typeof module !== 'undefined' ? module : undefined,
  exports: typeof exports !== 'undefined' ? exports : undefined,
  console,
  Buffer: typeof Buffer !== 'undefined' ? Buffer : undefined,
  process: typeof process !== 'undefined' ? process : undefined,
  setTimeout,
  setInterval,
  setImmediate: typeof setImmediate !== 'undefined' ? setImmediate : undefined,
  clearTimeout,
  clearInterval,
  clearImmediate: typeof clearImmediate !== 'undefined' ? clearImmediate : undefined,
  queueMicrotask,
  __dirname: typeof __dirname !== 'undefined' ? __dirname : undefined,
  __filename: typeof __filename !== 'undefined' ? __filename : undefined,
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
 * Creates a sandbox efficiently by inheriting from BASE_GLOBALS.
 *
 * Uses Object.create() to avoid copying all properties.
 * User context is applied as own properties on top.
 *
 * @param context - User context to merge
 * @returns Sandbox ready for vm.createContext()
 * @internal
 */
/**
 * LRU cache for reconstructed context functions.
 * Avoids recompiling the same function when used in different contexts.
 * @internal
 */
const reconstructedFnCache = new Map<string, Function>();
const RECONSTRUCTED_FN_CACHE_SIZE = 64;

/**
 * Reconstructs serialized functions from context.
 * Functions serialized with `__BEE_FN__:` prefix are converted back to real functions.
 * Uses vm.Script for better performance and security (no eval!).
 * Results are cached to avoid recompiling the same function in different contexts.
 * 
 * @param context - Context that may contain serialized functions
 * @returns Context with functions reconstructed
 * @internal
 */
function reconstructFunctions(context: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const keys = Object.keys(context);
  for (let i = 0, len = keys.length; i < len; i++) {
    const key = keys[i];
    const value = context[key];
    if (typeof value === 'string' && value.startsWith('__BEE_FN__:')) {
      const fnStr = value.slice(11); // Remove '__BEE_FN__:' prefix
      
      // Check cache first (same function may be used in different contexts)
      let fn = reconstructedFnCache.get(fnStr);
      if (!fn) {
        // Cache miss - compile with vm.Script
        try {
          const script = new vm.Script('(' + fnStr + ')', { filename: `bee-context-fn-${key}.js` });
          fn = script.runInThisContext() as Function;
          
          // LRU eviction if cache is full
          if (reconstructedFnCache.size >= RECONSTRUCTED_FN_CACHE_SIZE) {
            const firstKey = reconstructedFnCache.keys().next().value;
            if (firstKey) reconstructedFnCache.delete(firstKey);
          }
          reconstructedFnCache.set(fnStr, fn);
        } catch (e) {
          throw new Error(`Failed to reconstruct function "${key}": ${(e as Error).message}`);
        }
      }
      result[key] = fn;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function createSandbox(context?: Record<string, unknown> | null): Record<string, unknown> {
  // Create object with BASE_GLOBALS as prototype (no property copying!)
  const sandbox = Object.create(BASE_GLOBALS) as Record<string, unknown>;

  // Apply user context as own properties (overwrites if needed)
  if (context) {
    // Reconstruct any serialized functions first
    const processedContext = reconstructFunctions(context);
    // Fast assign - direct iteration without keys array
    for (const key in processedContext) {
      sandbox[key] = processedContext[key];
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
 * @param ttl - Time-to-live for entries in milliseconds (Default = 0 - no expiration)
 * @returns Cache instance with get, set, has, clear, size methods
 */
export function createLRUCache<T>(maxSize: number = DEFAULT_MAX_SIZE, ttl: number = DEFAULT_TTL): LRUCache<T> {
  const cache = new Map<string, LRUCacheEntry<T>>();

  return {
    /**
     * Gets a value from the cache.
     * If found, moves entry to most-recently-used position.
     */
    get(key: string): T | undefined {     
      const entry = cache.get(key);
      if (entry === undefined) return undefined;

      // Entry expired. If ttl isn't set, it never expires
      if (entry.expiresAt && Date.now() >= entry.expiresAt) {
        return this.delete(key, entry), undefined;
      }

      // Move to end (most recent) by deleting and re-inserting
      // Use internal Map operations to preserve the same entry (including timeoutId)
      // This maintains "absolute TTL" - entry expires at original time, not sliding
      cache.delete(key);
      cache.set(key, entry);

      return entry.value;
    },

    /**
     * Sets a value in the cache.
     * If cache is full, evicts least-recently-used entry.
     */
    set(key: string, value: T, timeToLive: number = ttl): void {
      let expiresAt: number | undefined;
      let timeoutId: NodeJS.Timeout | undefined;

      // Schedule expiration timer if TTL is set
      if (timeToLive > 0) {
        expiresAt = Date.now() + timeToLive;
        timeoutId = setTimeout(() => {
          // Timer callback - entry should be expired, just delete it
          // No need to re-check expiresAt since timer fired at the right time
          if (cache.has(key)) {
            const entry = cache.get(key);
            if (entry?.timeoutId) clearTimeout(entry.timeoutId);
            cache.delete(key);
          }
        }, timeToLive);
      }

      // Delete first to update position and set again
      this.delete(key);

      // Insert new entry with optional expiration
      cache.set(key, { value, expiresAt, timeoutId });

      // Evict least-recently-used if over max size
      if (cache.size > maxSize) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) {
          this.delete(oldestKey);
        }
      }
    },

    /**
     * Checks if a key exists in cache.
     * Does NOT update LRU position (use get for that).
     */
    has(key: string): boolean {
      return cache.has(key);
    },

    /**
     * Deletes an entry from the cache.
     * Also cancels any pending expiration timer.
     */
    delete(key: string, entry?: LRUCacheEntry<T>) {
      entry ??= cache.get(key);
      if (entry?.timeoutId) clearTimeout(entry.timeoutId);

      cache.delete(key);
    },

    /**
     * Clears all entries from the cache.
     * Also cancels all pending expiration timers.
     * V8: Uses forEach which is optimized for Map iteration.
     */
    clear(): void {
      // Cancel all pending timers before clearing
      // V8: Map.forEach is faster than for...of for this case
      cache.forEach((entry) => {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
      });
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
    stats() {
      return {
        size: cache.size,
        maxSize,
        ttl,
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
 */
export function fastHash(str: string): string {
  let hash = 5381;
  for (let i = 0, len = str.length; i < len; i++) {
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
 */
export function createContextKey(context: unknown, level: number = 0): string {
  if (context === undefined) {
    return ''; // Undefined as empty string
  }
  // O(1) type check instead of array.includes()
  const ctxType = typeof context;
  if (context === null || ctxType === 'string' || ctxType === 'number' || ctxType === 'boolean') {
    return String(context); // Primitive as string
  }
  if (context instanceof Date) {
    return String(context.getTime()); // Date as timestamp
  }
  if (ctxType === 'function') {
    return fastHash(context.toString()); // Hash function source
  }
  if (level >= 10) {
    return fastHash(JSON.stringify(context)); // Prevent too deep recursion
  }

  // Increase level for nested structures
  level++;

  // Handle arrays recursively. Return string as "[item1,item2,...]"
  // Optimized: single loop instead of .map().filter().join() chain
  if (Array.isArray(context)) {
    let arrResult = '[';
    let first = true;
    for (let i = 0, len = context.length; i < len; i++) {
      const itemKey = createContextKey(context[i], level);
      if (itemKey) {
        if (!first) arrResult += ',';
        arrResult += itemKey;
        first = false;
      }
    }
    return arrResult + ']';
  }

  const keys = Object.keys(context) as Array<keyof typeof context>;
  const keysLen = keys.length;
  if (!keysLen) return '';

  // Handle objects recursively. Sort for deterministic ordering.
  // Skip sort for single key (common case)
  if (keysLen > 1) keys.sort();
  
  let objResult = '{';
  let first = true;
  for (let i = 0; i < keysLen; i++) {
    const key = keys[i];
    const value = createContextKey(context[key], level);
    if (value) {
      if (!first) objResult += '&';
      objResult += key + ':' + value;
      first = false;
    }
  }
  return objResult + '}';
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
export function createFunctionCache(maxSize: number = DEFAULT_MAX_SIZE, ttl = DEFAULT_TTL): FunctionCache {
  const cache = createLRUCache<Function>(maxSize, ttl);

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
      // Check if context has any actual properties (fast check without full iteration)
      let hasContext = false;
      if (context) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for (const _ in context) { hasContext = true; break; }
      }

      // Create optimized cache key (faster than JSON.stringify)
      const contextKey = hasContext ? createContextKey(context) : '';
      const cacheKey = contextKey ? `${fnString}::${contextKey}` : fnString;

      // Try cache first
      let fn = cache.get(cacheKey);

      if (fn) {
        hits++;
        return fn;
      }

      // Cache miss - compile function
      misses++;

      // ─────────────────────────────────────────────────────────────────────
      // CRITICAL PERFORMANCE FIX:
      // vm.Script.runInContext() has 30x overhead on EVERY function call!
      // Even with cached context, each invocation crosses VM boundary.
      // 
      // Solution: Use new Function() when no context needed (fast path)
      //           Only use runInContext() when context injection is required
      // ─────────────────────────────────────────────────────────────────────
      if (!hasContext) {
        // FAST PATH: No context = use new Function() (30x faster!)
        // new Function() creates native functions without VM boundary overhead
        // We inject 'require' to maintain Node.js compatibility
        fn = (new Function('require', 'return ' + fnString))(require) as Function;
      } else {
        // SLOW PATH: Has context = must use vm.Script for context injection
        const code = `(${fnString})`;
        const script = new vm.Script(code, {
          filename: 'bee-worker-fn.js',
          produceCachedData: true // Enable V8 code caching
        });
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

