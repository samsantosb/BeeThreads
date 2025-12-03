/**
 * @fileoverview Input validation functions for bee-threads.
 * @module bee-threads/validation
 */

/**
 * Validates that a value is a callable function.
 * Throws immediately if not (fail-fast pattern).
 *
 * @param fn - Value to validate
 * @throws {TypeError} When fn is not a function
 *
 * @example
 * validateFunction(() => {});  // ✓ passes
 * validateFunction('string');  // ✗ throws TypeError
 */
export function validateFunction(fn: unknown): asserts fn is Function {
  if (typeof fn !== 'function') {
    throw new TypeError(`Expected a function, got ${typeof fn}`);
  }
}

/**
 * Validates timeout is a positive finite number.
 *
 * @param ms - Value to validate
 * @throws {TypeError} When ms is invalid
 *
 * @example
 * validateTimeout(1000);    // ✓ passes
 * validateTimeout(-1);      // ✗ throws TypeError
 * validateTimeout(Infinity); // ✗ throws TypeError
 */
export function validateTimeout(ms: unknown): asserts ms is number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    throw new TypeError('Timeout must be a positive finite number');
  }
}

/**
 * Validates pool size is a positive integer.
 *
 * @param size - Value to validate
 * @throws {TypeError} When size is invalid
 *
 * @example
 * validatePoolSize(4);   // ✓ passes
 * validatePoolSize(2.5); // ✗ throws TypeError
 * validatePoolSize(0);   // ✗ throws TypeError
 */
export function validatePoolSize(size: unknown): asserts size is number {
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    throw new TypeError('Pool size must be a positive integer >= 1');
  }
}

/**
 * Validates closure object is a non-null object.
 *
 * @param obj - Value to validate
 * @throws {TypeError} When obj is not a non-null object
 */
export function validateClosure(obj: unknown): asserts obj is Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) {
    throw new TypeError('usingClosure() requires a non-null object');
  }
}

