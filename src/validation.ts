/**
 * @fileoverview Input validation functions for bee-threads.
 *
 * ## Why This File Exists
 *
 * Centralizes all input validation logic. This follows the "fail-fast"
 * pattern - invalid inputs throw immediately with clear error messages,
 * rather than causing cryptic errors later in execution.
 *
 * ## What It Does
 *
 * - Validates function arguments (must be callable)
 * - Validates timeout values (must be positive finite number)
 * - Validates pool size (must be positive integer)
 * - Validates closure objects (must be non-null object)
 *
 * ## Design Principles
 *
 * 1. **Fail fast** - throw immediately on invalid input
 * 2. **Clear messages** - error messages explain what went wrong
 * 3. **Type guards** - functions act as TypeScript assertion functions
 * 4. **No side effects** - pure validation, no state changes
 *
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

// ============================================================================
// SECURITY VALIDATION
// ============================================================================

/**
 * Validates function source size against max limit.
 * Prevents DoS attacks via extremely large function strings.
 *
 * @param fnString - Function source code
 * @param maxSize - Maximum allowed size in bytes
 * @throws {RangeError} When function exceeds size limit
 */
export function validateFunctionSize(fnString: string, maxSize: number): void {
  const size = Buffer.byteLength(fnString, 'utf8');
  if (size > maxSize) {
    throw new RangeError(
      `Function source exceeds maximum size (${size} bytes > ${maxSize} bytes limit)`
    );
  }
}

/**
 * Validates context object for prototype pollution attacks.
 * Blocks __proto__, constructor, prototype keys.
 *
 * @param context - Context object to validate
 * @throws {TypeError} When dangerous keys are detected
 */
export function validateContextSecurity(context: Record<string, unknown>): void {
  // Check for __proto__ explicitly (Object.keys doesn't return it)
  if (Object.prototype.hasOwnProperty.call(context, '__proto__')) {
    throw new TypeError(
      `Context key "__proto__" is not allowed (potential prototype pollution)`
    );
  }
  
  // Check other dangerous keys
  const keys = Object.keys(context);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'constructor' || key === 'prototype') {
      throw new TypeError(
        `Context key "${key}" is not allowed (potential prototype pollution)`
      );
    }
  }
}

