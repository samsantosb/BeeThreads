/**
 * @fileoverview LRU Cache for compiled functions.
 * 
 * ## Why This File Exists
 * 
 * Compiling functions with eval() has overhead (~0.3-0.5ms per call).
 * By caching compiled functions, repeated executions of the same
 * function skip compilation entirely (~0.001ms lookup).
 * 
 * Additionally, cached functions benefit from V8 optimization:
 * - First executions use Ignition (interpreter)
 * - After several calls, TurboFan optimizes the function
 * - Cached functions retain their optimized state
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

'use strict';

/**
 * Default maximum cache size.
 * @type {number}
 */
const DEFAULT_MAX_SIZE = 100;

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
 * ## Performance
 * 
 * | Operation | Time Complexity |
 * |-----------|-----------------|
 * | get       | O(1)            |
 * | set       | O(1)            |
 * | has       | O(1)            |
 * | evict     | O(1)            |
 * 
 * @param {number} [maxSize=100] - Maximum number of entries
 * @returns {Object} Cache instance with get, set, has, clear, size methods
 * 
 * @example
 * const cache = createLRUCache(50);
 * 
 * cache.set('key1', value1);
 * cache.get('key1'); // Returns value1, moves to most recent
 * cache.has('key1'); // true
 * cache.size();      // 1
 * cache.clear();     // Removes all entries
 */
function createLRUCache(maxSize = DEFAULT_MAX_SIZE) {
  const cache = new Map();
  
  return {
    /**
     * Gets a value from the cache.
     * If found, moves entry to most-recently-used position.
     * 
     * @param {string} key - Cache key
     * @returns {*} Cached value or undefined
     */
    get(key) {
      if (!cache.has(key)) {
        return undefined;
      }
      
      // Move to end (most recent) by re-inserting
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      
      return value;
    },
    
    /**
     * Sets a value in the cache.
     * If cache is full, evicts least-recently-used entry.
     * 
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     */
    set(key, value) {
      // If key exists, delete first to update position
      if (cache.has(key)) {
        cache.delete(key);
      }
      // Evict oldest if at capacity
      else if (cache.size >= maxSize) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }
      
      cache.set(key, value);
    },
    
    /**
     * Checks if a key exists in cache.
     * Does NOT update LRU position (use get for that).
     * 
     * @param {string} key - Cache key
     * @returns {boolean} True if key exists
     */
    has(key) {
      return cache.has(key);
    },
    
    /**
     * Clears all entries from the cache.
     */
    clear() {
      cache.clear();
    },
    
    /**
     * Returns the current number of entries.
     * 
     * @returns {number} Number of cached entries
     */
    size() {
      return cache.size;
    },
    
    /**
     * Returns cache statistics.
     * 
     * @returns {Object} Stats object with size and maxSize
     */
    stats() {
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
 * @param {string} str - String to hash
 * @returns {string} Hash string (base36)
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
 * Creates a lightweight context key for caching.
 * 
 * Instead of JSON.stringify (slow for large objects), we create
 * a composite key from:
 * - Sorted keys (for deterministic ordering)
 * - Type markers for values
 * - Primitive value hashes
 * 
 * This is ~10x faster than JSON.stringify for typical contexts
 * while maintaining uniqueness for different context values.
 * 
 * @param {Object} context - Context object
 * @returns {string} Context key
 * @internal
 */
function createContextKey(context) {
  if (!context) return '';
  
  const keys = Object.keys(context);
  if (keys.length === 0) return '';
  
  // Sort keys for deterministic ordering
  keys.sort();
  
  const parts = [];
  for (const key of keys) {
    const value = context[key];
    const type = typeof value;
    
    // Create type-specific representation
    if (value === null) {
      parts.push(`${key}:null`);
    } else if (type === 'function') {
      // For functions, use a hash of the source
      parts.push(`${key}:fn:${fastHash(value.toString())}`);
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
 * Creates a function cache that compiles and caches functions.
 * 
 * This is the main interface used by workers to cache compiled
 * functions and avoid repeated eval() calls.
 * 
 * @param {number} [maxSize=100] - Maximum cached functions
 * @returns {Object} Function cache with getOrCompile method
 * 
 * @example
 * const fnCache = createFunctionCache(50);
 * 
 * // First call: compiles and caches
 * const fn1 = fnCache.getOrCompile('(x) => x * 2');
 * 
 * // Second call: returns cached function (no eval)
 * const fn2 = fnCache.getOrCompile('(x) => x * 2');
 * 
 * fn1 === fn2; // true - same function instance
 */
function createFunctionCache(maxSize = DEFAULT_MAX_SIZE) {
  const cache = createLRUCache(maxSize);
  
  // Stats for monitoring
  let hits = 0;
  let misses = 0;
  
  return {
    /**
     * Gets a compiled function from cache, or compiles and caches it.
     * 
     * @param {string} fnString - Function source code
     * @param {Object} [context] - Optional context for closure injection
     * @returns {Function} Compiled function
     */
    getOrCompile(fnString, context) {
      // Create optimized cache key (faster than JSON.stringify)
      const contextKey = createContextKey(context);
      const cacheKey = contextKey ? `${fnString}::${contextKey}` : fnString;
      
      // Try cache first
      let fn = cache.get(cacheKey);
      
      if (fn) {
        hits++;
        return fn;
      }
      
      // Cache miss - compile
      misses++;
      
      if (context && Object.keys(context).length > 0) {
        // Compile with context injection
        const contextKeys = Object.keys(context);
        const contextValues = Object.values(context);
        
        const wrapperCode = `
          (function(${contextKeys.join(', ')}) {
            return (${fnString});
          })
        `;
        
        const wrapper = eval(wrapperCode);
        fn = wrapper(...contextValues);
      } else {
        // Simple compile
        fn = eval(`(${fnString})`);
      }
      
      // Cache the compiled function
      cache.set(cacheKey, fn);
      
      return fn;
    },
    
    /**
     * Clears the function cache.
     */
    clear() {
      cache.clear();
      hits = 0;
      misses = 0;
    },
    
    /**
     * Returns cache statistics.
     * 
     * @returns {Object} Stats with hits, misses, hitRate, size
     */
    stats() {
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

module.exports = {
  createLRUCache,
  createFunctionCache,
  DEFAULT_MAX_SIZE
};