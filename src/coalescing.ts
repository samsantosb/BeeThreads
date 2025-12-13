/**
 * @fileoverview Request Coalescing (Promise Deduplication) for bee-threads.
 *
 * ## Why This File Exists
 *
 * When multiple identical requests (same function + same arguments + same context)
 * are made simultaneously, executing them all in separate workers is wasteful.
 * Request coalescing ensures only the first request actually executes, while
 * subsequent identical requests share the same Promise.
 *
 * ## How It Works
 *
 * ```
 * Request 1: bee(fn)(args) → Creates Promise, stores in cache → Executes in Worker
 * Request 2: bee(fn)(args) → Finds Promise in cache → Returns same Promise
 * Request 3: bee(fn)(args) → Finds Promise in cache → Returns same Promise
 *                                    ↓
 *                          Worker completes
 *                                    ↓
 *                    Promise resolves → Removed from cache
 *                                    ↓
 * Request 4: bee(fn)(args) → Cache empty → Creates new Promise
 * ```
 *
 * ## Benefits
 *
 * - Prevents duplicate executions of identical concurrent requests
 * - Reduces worker pool load
 * - All callers receive the same result (consistency)
 * - Zero memory overhead for completed requests (auto-cleanup)
 *
 * ## Pattern Names
 *
 * This pattern is also known as:
 * - Singleflight (Go terminology)
 * - Promise Deduplication
 * - In-flight Request Caching
 * - Request Memoization
 *
 * @module bee-threads/coalescing
 * @internal
 */

// ============================================================================
// TYPES
// ============================================================================

/** Statistics for request coalescing */
export interface CoalescingStats {
  /** Number of requests that were deduplicated (shared existing promise) */
  coalesced: number;
  /** Number of unique requests that created new promises */
  unique: number;
  /** Current number of in-flight promises */
  inFlight: number;
  /** Coalescing rate as percentage string */
  coalescingRate: string;
}

// ============================================================================
// IN-FLIGHT PROMISE CACHE
// ============================================================================

import { fastHash, createContextKey } from './cache';

/**
 * Map of in-flight promises keyed by request signature.
 * When a promise resolves/rejects, it's automatically removed.
 */
const inFlightPromises = new Map<string, Promise<unknown>>();

/** Whether coalescing is enabled */
let coalescingEnabled = true;

/** Statistics counters */
let coalescedCount = 0;
let uniqueCount = 0;

// ============================================================================
// KEY GENERATION
// ============================================================================

/**
 * Patterns that indicate non-deterministic functions.
 * These functions produce different results on each call even with same inputs.
 * Coalescing is automatically disabled for functions containing these patterns.
 */
const NON_DETERMINISTIC_PATTERNS = [
  // Time-based
  'Date.now',
  'new Date',
  'performance.now',
  
  // Random
  'Math.random',
  'crypto.randomUUID',
  'crypto.randomBytes',
  'crypto.getRandomValues',
  
  // Unique IDs
  'uuid',
  'nanoid',
  'cuid',
  
  // Process/environment (can change)
  'process.hrtime',
] as const;

/**
 * Cache for non-deterministic function detection results.
 * Avoids re-checking the same function string multiple times.
 * Uses a simple LRU-style eviction: when full, clears oldest half.
 */
const nonDeterministicCache = new Map<string, boolean>();
const MAX_NON_DETERMINISTIC_CACHE_SIZE = 500;

/**
 * Checks if a function contains non-deterministic patterns.
 * Results are cached for performance with automatic LRU-style cleanup.
 * 
 * @param fnString - Function source code
 * @returns true if function appears to be non-deterministic
 */
export function isNonDeterministic(fnString: string): boolean {
  // Check cache first
  const cached = nonDeterministicCache.get(fnString);
  if (cached !== undefined) {
    return cached;
  }
  
  // Check for non-deterministic patterns
  let result = false;
  for (let i = 0; i < NON_DETERMINISTIC_PATTERNS.length; i++) {
    if (fnString.includes(NON_DETERMINISTIC_PATTERNS[i])) {
      result = true;
      break;
    }
  }
  
  // LRU-style eviction: when cache is full, remove oldest half
  // Map maintains insertion order, so first entries are oldest
  if (nonDeterministicCache.size >= MAX_NON_DETERMINISTIC_CACHE_SIZE) {
    const keysToDelete = Math.floor(MAX_NON_DETERMINISTIC_CACHE_SIZE / 2);
    const iterator = nonDeterministicCache.keys();
    for (let i = 0; i < keysToDelete; i++) {
      const key = iterator.next().value;
      if (key !== undefined) {
        nonDeterministicCache.delete(key);
      }
    }
  }
  
  // Cache result
  nonDeterministicCache.set(fnString, result);
  
  return result;
}

/**
 * Clears the non-deterministic detection cache.
 * Used in testing or when memory pressure is high.
 */
export function clearNonDeterministicCache(): void {
  nonDeterministicCache.clear();
}

/**
 * Creates a unique key for a request based on function, args, and context.
 * Reuses fastHash and createContextKey from cache.ts for consistency.
 * 
 * @param fnString - Function source code
 * @param args - Function arguments
 * @param context - Execution context (closures)
 * @param fnHash - Pre-computed function hash (optional, avoids recomputation)
 * @returns Unique request key
 */
function createRequestKey(
  fnString: string,
  args: unknown[],
  context: Record<string, unknown> | null | undefined,
  fnHash?: string
): string {
  // Hash the function (avoids huge keys for large functions)
  const hash = fnHash ?? fastHash(fnString);
  
  // Use createContextKey for args and context (faster than JSON.stringify)
  // Note: createContextKey handles empty arrays/objects efficiently
  const argsKey = createContextKey(args);
  const contextKey = context ? createContextKey(context) : '';
  
  return `${hash}:${argsKey}:${contextKey}`;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Gets an existing in-flight promise or creates a new one.
 * 
 * If an identical request is already in progress, returns the existing promise.
 * Otherwise, executes the factory function and caches the resulting promise.
 * The promise is automatically removed from cache when it settles.
 * 
 * Coalescing is automatically skipped for:
 * - Non-deterministic functions (Date.now, Math.random, etc.)
 * - Requests with skipCoalescing=true
 * 
 * @param fnString - Function source code
 * @param args - Function arguments
 * @param context - Execution context
 * @param factory - Factory function that creates the actual promise
 * @param skipCoalescing - Force skip coalescing for this request
 * @param fnHash - Pre-computed function hash (optional, avoids recomputation)
 * @returns The (possibly shared) promise
 */
export function coalesce<T>(
  fnString: string,
  args: unknown[],
  context: Record<string, unknown> | null | undefined,
  factory: () => Promise<T>,
  skipCoalescing: boolean = false,
  fnHash?: string
): Promise<T> {
  // Skip coalescing if:
  // 1. Globally disabled
  // 2. Explicitly skipped for this request
  // 3. Function contains non-deterministic patterns
  if (!coalescingEnabled || skipCoalescing || isNonDeterministic(fnString)) {
    return factory();
  }

  const key = createRequestKey(fnString, args, context, fnHash);
  
  // Check if there's already an in-flight promise for this request
  const existing = inFlightPromises.get(key);
  if (existing) {
    coalescedCount++;
    return existing as Promise<T>;
  }
  
  // No existing promise - create new one
  uniqueCount++;
  
  const promise = factory().finally(() => {
    // Auto-cleanup: remove from cache when promise settles
    inFlightPromises.delete(key);
  });
  
  // Store in cache
  inFlightPromises.set(key, promise);
  
  return promise;
}

/**
 * Enables or disables request coalescing.
 * 
 * @param enabled - Whether to enable coalescing
 */
export function setCoalescingEnabled(enabled: boolean): void {
  coalescingEnabled = enabled;
}

/**
 * Returns whether coalescing is currently enabled.
 */
export function isCoalescingEnabled(): boolean {
  return coalescingEnabled;
}

/**
 * Returns coalescing statistics.
 */
export function getCoalescingStats(): CoalescingStats {
  const total = coalescedCount + uniqueCount;
  return {
    coalesced: coalescedCount,
    unique: uniqueCount,
    inFlight: inFlightPromises.size,
    coalescingRate: total > 0 
      ? (coalescedCount / total * 100).toFixed(1) + '%' 
      : '0%'
  };
}

/**
 * Resets coalescing statistics.
 */
export function resetCoalescingStats(): void {
  coalescedCount = 0;
  uniqueCount = 0;
}

/**
 * Clears all in-flight promises (for shutdown/testing).
 * Note: Does not reject pending promises, just removes references.
 */
export function clearInFlightPromises(): void {
  inFlightPromises.clear();
}
