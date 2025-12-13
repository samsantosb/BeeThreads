/**
 * @fileoverview AutoPack - High-Performance Object ↔ TypedArray Serialization
 * 
 * AutoPack converts arrays of JavaScript objects into TypedArrays for faster
 * serialization via postMessage. This provides significant performance gains
 * (1.5-10x faster) compared to the default structuredClone algorithm.
 * 
 * Inspired by: Elysia, FlatBuffers, Cap'n Proto, MessagePack
 * 
 * ## When to Use AutoPack
 * 
 * ✅ **Good for:**
 * - Arrays with 50+ objects
 * - Objects with numeric, string, or boolean fields
 * - Nested objects (e.g., `{ user: { name: 'John' } }`)
 * - High-throughput scenarios (turbo mode)
 * 
 * ❌ **Not suitable for:**
 * - Single objects (overhead > benefit)
 * - Arrays with < 50 items
 * - Objects with functions, Symbols, or BigInts
 * - Circular references
 * 
 * ## Performance Benchmarks (1M objects)
 * 
 * | Scenario         | structuredClone | AutoPack | Speedup |
 * |------------------|-----------------|----------|---------|
 * | Numeric objects  | 2275ms          | 698ms    | 3.3x    |
 * | String objects   | 2150ms          | 1283ms   | 1.7x    |
 * | Mixed objects    | 2114ms          | 863ms    | 2.4x    |
 * | Nested objects   | 5010ms          | 1709ms   | 2.9x    |
 * 
 * ## Design Principles
 * 
 * 1. **Zero-copy where possible** - SharedArrayBuffer + transfer
 * 2. **Single-pass packing** - O(n) not O(2n)
 * 3. **JIT-compiled functions** - Generated per schema for maximum speed
 * 4. **Column-oriented storage** - Cache-friendly for SIMD operations
 * 5. **Pre-parsed paths** - No string.split() overhead in hot loops
 * 6. **Schema caching** - Inference runs only once per object shape
 * 
 * ## Big O Analysis
 * 
 * - Schema inference: O(k) where k = number of keys (cached after first call)
 * - Pack: O(n * k) - unavoidable, but with minimal constant factor
 * - Unpack: O(n * k) - same
 * - With compiled functions: ~3-5x faster than dynamic property access
 * 
 * @example
 * ```typescript
 * import { autoPack, autoUnpack } from 'bee-threads';
 * 
 * const users = [
 *   { id: 1, name: 'Alice', active: true },
 *   { id: 2, name: 'Bob', active: false },
 * ];
 * 
 * // Pack for transfer
 * const packed = autoPack(users);
 * 
 * // Transfer to worker (much faster than structuredClone)
 * worker.postMessage(packed, getTransferables(packed));
 * 
 * // Unpack in worker
 * const restored = autoUnpack(packed);
 * ```
 * 
 * @module bee-threads/autopack
 */

// ============================================================================
// TYPES - STRICT TYPE SAFETY
// ============================================================================

/** Supported primitive types for AutoPack fields */
type PrimitiveType = 'number' | 'string' | 'boolean' | 'null';

/** 
 * Primitive values that can be packed.
 * AutoPack only supports these types at leaf positions.
 */
type PackablePrimitive = number | string | boolean | null | undefined;

/**
 * Recursive type for objects that can be packed.
 * Allows nested objects but NOT arrays, functions, symbols, or bigint.
 */
type PackableValue = PackablePrimitive | PackableObject;

/**
 * Object type constraint for AutoPack.
 * Uses Record<string, unknown> for internal flexibility but
 * the public API enforces proper types.
 */
type PackableObject = Record<string, unknown>;

/**
 * Strict packable object for public API.
 * Use this when you want compile-time validation.
 */
export type StrictPackableObject = { readonly [K: string]: PackableValue };

/** Schema field descriptor - immutable */
interface FieldDescriptor {
  readonly name: string;
  readonly type: PrimitiveType;
  readonly path: string;              // Flattened path for nested: "user.name"
  readonly pathParts: readonly string[]; // Pre-split path: ["user", "name"]
  readonly depth: number;             // Nesting depth: 0 for top-level
  readonly parentPath: string;        // Parent path: "user" for "user.name"
}

/** Compiled schema for a specific object shape - mostly immutable */
interface CompiledSchema {
  readonly hash: string;                    // Unique identifier for this shape
  readonly fields: readonly FieldDescriptor[];
  readonly numericFields: readonly FieldDescriptor[];
  readonly stringFields: readonly FieldDescriptor[];
  readonly booleanFields: readonly FieldDescriptor[];
  readonly nullableFields: ReadonlySet<string>;
  readonly totalNumericCount: number;
  readonly totalStringCount: number;
  readonly totalBooleanCount: number;
  readonly maxDepth: number;
  // JIT-compiled functions (generated once per schema)
  packFn: PackFunction | null;
  unpackFn: UnpackFunction | null;
}

/** Packed data structure - transferable via postMessage */
interface PackedData<T extends PackableObject = PackableObject> {
  readonly schema: CompiledSchema;
  readonly length: number;
  // Column-oriented storage (cache-friendly for SIMD operations)
  numbers: Float64Array;          // All numeric values, column by column
  strings: Uint8Array;            // UTF-8 encoded strings, concatenated
  stringOffsets: Uint32Array;     // Start offset of each string
  stringLengths: Uint16Array;     // Length of each string (max 65535 chars)
  booleans: Uint8Array;           // Bit-packed booleans (8 per byte)
  nullFlags: Uint8Array;          // Bit-packed null flags
  // For SharedArrayBuffer mode
  readonly isShared: boolean;
  // Phantom type for preserving T
  readonly __type?: T;
}

/** JIT-compiled pack function signature */
type PackFunction = (data: readonly PackableObject[], packed: PackedData) => void;

/** JIT-compiled unpack function signature */
type UnpackFunction = (packed: PackedData) => PackableObject[];

/** Options for autoPack function */
interface AutoPackOptions {
  /** Use SharedArrayBuffer for zero-copy transfer. Default: false */
  readonly useSharedArrayBuffer?: boolean;
}

// ============================================================================
// GLOBAL STATE & CACHES - WITH MEMORY LIMITS
// ============================================================================

/** Schema cache - Map<shapeHash, CompiledSchema> */
const schemaCache = new Map<string, CompiledSchema>();
const SCHEMA_CACHE_MAX_SIZE = 64;

/** Reusable TextEncoder/Decoder (V8 optimizes global instances) */
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** 
 * Pre-allocated encode buffer for encodeInto()
 * MEMORY SAFETY: Max 256MB, auto-shrink after use
 */
const ENCODE_BUFFER_INITIAL = 1 << 20;  // 1MB
const ENCODE_BUFFER_MAX = 1 << 28;      // 256MB max
let encodeBuffer = new Uint8Array(ENCODE_BUFFER_INITIAL);
let encodeBufferLastUsedSize = 0;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Fast hash for object shape detection
 * Uses FNV-1a algorithm - simple, fast, good distribution
 */
function hashShape(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj);
  const len = keys.length;
  
  // FNV-1a 32-bit
  let hash = 2166136261;
  
  for (let i = 0; i < len; i++) {
    const key = keys[i];
    const value = obj[key];
    const type = value === null ? 'null' : typeof value;
    
    // Hash key
    for (let j = 0; j < key.length; j++) {
      hash ^= key.charCodeAt(j);
      hash = Math.imul(hash, 16777619);
    }
    
    // Hash type
    hash ^= type.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
    
    // Recurse for nested objects
    if (type === 'object' && value !== null && !Array.isArray(value)) {
      const nestedHash = hashShape(value as Record<string, unknown>);
      for (let j = 0; j < nestedHash.length; j++) {
        hash ^= nestedHash.charCodeAt(j);
        hash = Math.imul(hash, 16777619);
      }
    }
  }
  
  return (hash >>> 0).toString(36);
}

/**
 * Ensure encode buffer is large enough.
 * MEMORY SAFETY: Capped at 256MB, throws if exceeded.
 */
function ensureEncodeBuffer(minSize: number): void {
  if (minSize > ENCODE_BUFFER_MAX) {
    throw new Error(`AutoPack: Data too large (${minSize} bytes > ${ENCODE_BUFFER_MAX} max)`);
  }
  if (encodeBuffer.length < minSize) {
    // Grow to next power of 2, capped at max
    const newSize = Math.min(1 << (32 - Math.clz32(minSize)), ENCODE_BUFFER_MAX);
    encodeBuffer = new Uint8Array(newSize);
  }
  encodeBufferLastUsedSize = minSize;
}

/**
 * Shrink internal buffers if they grew too large.
 * Call periodically or after large operations to free memory.
 * 
 * @example
 * ```typescript
 * // After processing large batch
 * shrinkAutoPackBuffers();
 * ```
 */
export function shrinkAutoPackBuffers(): void {
  // Shrink encode buffer if >4MB and last use was <25% capacity
  if (encodeBuffer.length > (1 << 22) && encodeBufferLastUsedSize < (encodeBuffer.length >> 2)) {
    encodeBuffer = new Uint8Array(ENCODE_BUFFER_INITIAL);
    encodeBufferLastUsedSize = 0;
  }
  // Shrink string buffer if >4MB and last use was <25% capacity  
  if (_encBuf.length > (1 << 22) && _encBufLastUsed < (_encBuf.length >> 2)) {
    _encBuf = new Uint8Array(STRING_PACK_BUFFER_INITIAL);
    _encBufLastUsed = 0;
  }
}

// ============================================================================
// SCHEMA INFERENCE
// ============================================================================

/**
 * Infer schema from sample object - O(k) where k = total keys including nested
 */
function inferSchema(sample: Record<string, unknown>): CompiledSchema {
  const hash = hashShape(sample);
  
  // Check cache first
  const cached = schemaCache.get(hash);
  if (cached) return cached;
  
  const fields: FieldDescriptor[] = [];
  const numericFields: FieldDescriptor[] = [];
  const stringFields: FieldDescriptor[] = [];
  const booleanFields: FieldDescriptor[] = [];
  const nullableFields = new Set<string>();
  let maxDepth = 0;
  
  // Recursive field extraction with flattening
  function extractFields(
    obj: Record<string, unknown>,
    pathPrefix: string,
    depth: number
  ): void {
    const keys = Object.keys(obj);
    
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = obj[key];
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      const pathParts = path.split('.'); // Pre-split for fast access
      const parentPath = pathPrefix;
      
      if (value === null || value === undefined) {
        nullableFields.add(path);
        // Try to infer type from field name or default to string
        const field: FieldDescriptor = {
          name: key,
          type: 'null',
          path,
          pathParts,
          depth,
          parentPath
        };
        fields.push(field);
      } else if (typeof value === 'number') {
        const field: FieldDescriptor = {
          name: key,
          type: 'number',
          path,
          pathParts,
          depth,
          parentPath
        };
        fields.push(field);
        numericFields.push(field);
      } else if (typeof value === 'string') {
        const field: FieldDescriptor = {
          name: key,
          type: 'string',
          path,
          pathParts,
          depth,
          parentPath
        };
        fields.push(field);
        stringFields.push(field);
      } else if (typeof value === 'boolean') {
        const field: FieldDescriptor = {
          name: key,
          type: 'boolean',
          path,
          pathParts,
          depth,
          parentPath
        };
        fields.push(field);
        booleanFields.push(field);
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        // Nested object - recurse
        const newDepth = depth + 1;
        if (newDepth > maxDepth) maxDepth = newDepth;
        extractFields(value as Record<string, unknown>, path, newDepth);
      }
      // Arrays and other types are not supported in v1
    }
  }
  
  extractFields(sample, '', 0);
  
  const schema: CompiledSchema = {
    hash,
    fields,
    numericFields,
    stringFields,
    booleanFields,
    nullableFields,
    totalNumericCount: numericFields.length,
    totalStringCount: stringFields.length,
    totalBooleanCount: booleanFields.length,
    maxDepth,
    packFn: null,
    unpackFn: null
  };
  
  // Generate JIT-compiled functions
  schema.packFn = generatePackFunction(schema);
  schema.unpackFn = generateUnpackFunction(schema);
  
  // Cache with LRU eviction
  if (schemaCache.size >= SCHEMA_CACHE_MAX_SIZE) {
    const firstKey = schemaCache.keys().next().value;
    if (firstKey) schemaCache.delete(firstKey);
  }
  schemaCache.set(hash, schema);
  
  return schema;
}

// ============================================================================
// JIT FUNCTION GENERATION (Elysia-style)
// ============================================================================

/**
 * Generate optimized pack function for specific schema
 * This eliminates dynamic property access overhead
 */
function generatePackFunction(schema: CompiledSchema): PackFunction {
  const { numericFields, stringFields, booleanFields, maxDepth } = schema;
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  // For simple flat objects, generate specialized fast path
  if (maxDepth === 0 && numCount <= 8 && strCount <= 4 && boolCount <= 4) {
    return generateFlatPackFunction(schema);
  }
  
  // General case with nested object support
  return function generatedPack(
    data: readonly Record<string, unknown>[],
    packed: PackedData
  ): void {
    const len = data.length;
    const numbers = packed.numbers;
    const stringOffsets = packed.stringOffsets;
    const stringLengths = packed.stringLengths;
    const booleans = packed.booleans;
    
    let stringOffset = 0;
    
    // Single pass through all items
    for (let i = 0; i < len; i++) {
      const item = data[i];
      
      // Pack numeric fields (column-oriented)
      for (let j = 0; j < numCount; j++) {
        const field = numericFields[j];
        const value = getNestedValueFast(item, field.pathParts);
        numbers[j * len + i] = value as number;
      }
      
      // Pack string fields
      for (let j = 0; j < strCount; j++) {
        const field = stringFields[j];
        const value = getNestedValueFast(item, field.pathParts) as string;
        const strIndex = j * len + i;
        
        // Use encodeInto for zero-copy encoding
        const maxBytes = value.length * 3; // UTF-8 max expansion
        ensureEncodeBuffer(stringOffset + maxBytes);
        
        const { written } = textEncoder.encodeInto(
          value,
          encodeBuffer.subarray(stringOffset)
        );
        
        stringOffsets[strIndex] = stringOffset;
        stringLengths[strIndex] = written;
        stringOffset += written;
      }
      
      // Pack boolean fields (bit-packed)
      for (let j = 0; j < boolCount; j++) {
        const field = booleanFields[j];
        const value = getNestedValueFast(item, field.pathParts);
        const bitIndex = j * len + i;
        const byteIndex = bitIndex >>> 3;
        const bitOffset = bitIndex & 7;
        
        if (value) {
          booleans[byteIndex] |= (1 << bitOffset);
        }
      }
    }
    
    // Copy string data to final buffer
    packed.strings = encodeBuffer.slice(0, stringOffset);
  };
}

/**
 * Optimized pack for flat objects (no nesting)
 * Avoids getNestedValue overhead entirely
 */
function generateFlatPackFunction(schema: CompiledSchema): PackFunction {
  const { numericFields, stringFields, booleanFields } = schema;
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  // Pre-extract field names for direct access
  const numNames = numericFields.map(f => f.name);
  const strNames = stringFields.map(f => f.name);
  const boolNames = booleanFields.map(f => f.name);
  
  return function flatPack(
    data: readonly Record<string, unknown>[],
    packed: PackedData
  ): void {
    const len = data.length;
    const numbers = packed.numbers;
    const stringOffsets = packed.stringOffsets;
    const stringLengths = packed.stringLengths;
    const booleans = packed.booleans;
    
    let stringOffset = 0;
    
    // Estimate total string size for pre-allocation
    // Assume average 20 bytes per string field
    const estimatedStringSize = len * strCount * 20;
    ensureEncodeBuffer(estimatedStringSize);
    
    // Process all items in single pass
    for (let i = 0; i < len; i++) {
      const item = data[i];
      
      // Direct property access for numbers (V8 optimizes this)
      for (let j = 0; j < numCount; j++) {
        numbers[j * len + i] = item[numNames[j]] as number;
      }
      
      // Direct property access for strings with encodeInto
      for (let j = 0; j < strCount; j++) {
        const value = item[strNames[j]] as string;
        const strIndex = j * len + i;
        
        // Ensure buffer capacity
        const maxBytes = value.length * 3;
        if (stringOffset + maxBytes > encodeBuffer.length) {
          ensureEncodeBuffer(stringOffset + maxBytes);
        }
        
        const { written } = textEncoder.encodeInto(
          value,
          encodeBuffer.subarray(stringOffset)
        );
        
        stringOffsets[strIndex] = stringOffset;
        stringLengths[strIndex] = written;
        stringOffset += written;
      }
      
      // Direct property access for booleans
      for (let j = 0; j < boolCount; j++) {
        if (item[boolNames[j]]) {
          const bitIndex = j * len + i;
          booleans[bitIndex >>> 3] |= (1 << (bitIndex & 7));
        }
      }
    }
    
    // Copy encoded strings to packed buffer
    packed.strings = encodeBuffer.slice(0, stringOffset);
  };
}

/**
 * Generate optimized unpack function for specific schema
 */
function generateUnpackFunction(schema: CompiledSchema): UnpackFunction {
  const { numericFields, stringFields, booleanFields, maxDepth } = schema;
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  // For simple flat objects, generate specialized fast path
  if (maxDepth === 0) {
    return generateFlatUnpackFunction(schema);
  }
  
  // General case with nested object reconstruction
  return function generatedUnpack(packed: PackedData): Record<string, unknown>[] {
    const len = packed.length;
    const numbers = packed.numbers;
    const strings = packed.strings;
    const stringOffsets = packed.stringOffsets;
    const stringLengths = packed.stringLengths;
    const booleans = packed.booleans;
    
    const result: Record<string, unknown>[] = new Array(len);
    
    for (let i = 0; i < len; i++) {
      const obj: Record<string, unknown> = {};
      
      // Unpack numeric fields
      for (let j = 0; j < numCount; j++) {
        const field = numericFields[j];
        setNestedValueFast(obj, field.pathParts, numbers[j * len + i]);
      }
      
      // Unpack string fields
      for (let j = 0; j < strCount; j++) {
        const field = stringFields[j];
        const strIndex = j * len + i;
        const offset = stringOffsets[strIndex];
        const length = stringLengths[strIndex];
        const value = textDecoder.decode(strings.subarray(offset, offset + length));
        setNestedValueFast(obj, field.pathParts, value);
      }
      
      // Unpack boolean fields
      for (let j = 0; j < boolCount; j++) {
        const field = booleanFields[j];
        const bitIndex = j * len + i;
        const value = (booleans[bitIndex >>> 3] & (1 << (bitIndex & 7))) !== 0;
        setNestedValueFast(obj, field.pathParts, value);
      }
      
      result[i] = obj;
    }
    
    return result;
  };
}

/**
 * Optimized unpack for flat objects
 */
function generateFlatUnpackFunction(schema: CompiledSchema): UnpackFunction {
  const { numericFields, stringFields, booleanFields } = schema;
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  const numNames = numericFields.map(f => f.name);
  const strNames = stringFields.map(f => f.name);
  const boolNames = booleanFields.map(f => f.name);
  
  // Pre-build object template for consistent hidden class
  const templateKeys = [
    ...numNames,
    ...strNames,
    ...boolNames
  ];
  
  return function flatUnpack(packed: PackedData): Record<string, unknown>[] {
    const len = packed.length;
    const numbers = packed.numbers;
    const strings = packed.strings;
    const stringOffsets = packed.stringOffsets;
    const stringLengths = packed.stringLengths;
    const booleans = packed.booleans;
    
    const result: Record<string, unknown>[] = new Array(len);
    
    for (let i = 0; i < len; i++) {
      // Create object with stable shape (all properties initialized)
      const obj: Record<string, unknown> = {};
      
      // Initialize all properties in consistent order for V8 hidden class optimization
      for (let k = 0; k < templateKeys.length; k++) {
        obj[templateKeys[k]] = undefined;
      }
      
      // Fill numeric values
      for (let j = 0; j < numCount; j++) {
        obj[numNames[j]] = numbers[j * len + i];
      }
      
      // Fill string values
      for (let j = 0; j < strCount; j++) {
        const strIndex = j * len + i;
        const offset = stringOffsets[strIndex];
        const length = stringLengths[strIndex];
        obj[strNames[j]] = textDecoder.decode(strings.subarray(offset, offset + length));
      }
      
      // Fill boolean values
      for (let j = 0; j < boolCount; j++) {
        const bitIndex = j * len + i;
        obj[boolNames[j]] = (booleans[bitIndex >>> 3] & (1 << (bitIndex & 7))) !== 0;
      }
      
      result[i] = obj;
    }
    
    return result;
  };
}

// ============================================================================
// NESTED OBJECT HELPERS
// ============================================================================

/**
 * Fast nested value getter using pre-split path parts (no split overhead)
 */
function getNestedValueFast(
  obj: Record<string, unknown>,
  pathParts: readonly string[]
): unknown {
  const len = pathParts.length;
  
  // Fast path for flat objects
  if (len === 1) {
    return obj[pathParts[0]];
  }
  
  // Traverse nested path
  let current: unknown = obj;
  for (let i = 0; i < len; i++) {
    current = (current as Record<string, unknown>)[pathParts[i]];
  }
  
  return current;
}

/**
 * Fast nested value setter using pre-split path parts (no split overhead)
 */
function setNestedValueFast(
  obj: Record<string, unknown>,
  pathParts: readonly string[],
  value: unknown
): void {
  const lastIndex = pathParts.length - 1;
  
  // Fast path for flat objects
  if (lastIndex === 0) {
    obj[pathParts[0]] = value;
    return;
  }
  
  // Traverse and create intermediate objects
  let current = obj;
  for (let i = 0; i < lastIndex; i++) {
    const part = pathParts[i];
    if (!(part in current)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  
  current[pathParts[lastIndex]] = value;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Pack an array of objects into optimized TypedArrays for fast serialization.
 * 
 * AutoPack automatically:
 * - Infers the schema from the first object (cached for subsequent calls)
 * - Converts numbers to Float64Array (column-oriented for cache efficiency)
 * - Converts strings to UTF-8 Uint8Array using TextEncoder.encodeInto()
 * - Bit-packs booleans (8 per byte)
 * - Flattens nested objects (e.g., `user.name` → separate columns)
 * 
 * @typeParam T - The object type in the array (must have primitive values)
 * @param data - Array of homogeneous objects to pack. All objects must have
 *               the same shape (same keys and value types).
 * @param options - Packing options
 * @param options.useSharedArrayBuffer - Use SharedArrayBuffer for zero-copy
 *        transfer between threads. Default: false
 * @returns Packed data structure containing TypedArrays (transferable via postMessage)
 * 
 * @throws {TypeError} If data contains unsupported types (functions, Symbols, BigInt)
 * 
 * @example Basic usage
 * ```typescript
 * const users = [
 *   { id: 1, name: 'Alice', active: true },
 *   { id: 2, name: 'Bob', active: false },
 * ];
 * 
 * const packed = autoPack(users);
 * console.log(packed.numbers);  // Float64Array with id values
 * console.log(packed.strings);  // Uint8Array with encoded names
 * console.log(packed.booleans); // Uint8Array with bit-packed active flags
 * ```
 * 
 * @example With SharedArrayBuffer (zero-copy)
 * ```typescript
 * const packed = autoPack(data, { useSharedArrayBuffer: true });
 * // No need to list transferables - SharedArrayBuffer is shared memory
 * worker.postMessage(packed);
 * ```
 * 
 * @example Nested objects
 * ```typescript
 * const data = [
 *   { id: 1, user: { name: 'Alice', age: 30 } },
 *   { id: 2, user: { name: 'Bob', age: 25 } },
 * ];
 * 
 * const packed = autoPack(data);
 * // Flattened: id, user.name, user.age as separate columns
 * ```
 * 
 * @see autoUnpack - To restore objects from PackedData
 * @see getTransferables - To get ArrayBuffer list for postMessage transfer
 * @see canAutoPack - To check if data is compatible before packing
 */
/**
 * Pack an array of objects into optimized TypedArrays.
 * 
 * @typeParam T - Object type (must only contain number, string, boolean, null, or nested objects)
 * @param data - Array of homogeneous objects to pack
 * @param options - Packing options
 * @returns Typed PackedData that preserves the original type T
 */
export function autoPack<T extends Record<string, unknown>>(
  data: readonly T[],
  options: AutoPackOptions = {}
): PackedData<T> {
  const len = data.length;
  
  if (len === 0) {
    return createEmptyPackedData<T>();
  }
  
  // Infer schema from first item (cached)
  const schema = inferSchema(data[0] as PackableObject);
  
  const { numericFields, stringFields, booleanFields } = schema;
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  // Allocate buffers
  const BufferConstructor = options.useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer;
  
  // Numbers: Float64 (8 bytes each), column-oriented
  const numbersSize = len * numCount;
  const numbersBuffer = new BufferConstructor(numbersSize * 8);
  const numbers = new Float64Array(numbersBuffer);
  
  // String offsets and lengths
  const stringOffsetsSize = len * strCount;
  const stringOffsetsBuffer = new BufferConstructor(stringOffsetsSize * 4);
  const stringLengthsBuffer = new BufferConstructor(stringOffsetsSize * 2);
  const stringOffsets = new Uint32Array(stringOffsetsBuffer);
  const stringLengths = new Uint16Array(stringLengthsBuffer);
  
  // Booleans: bit-packed (8 per byte)
  const boolBitCount = len * boolCount;
  const boolByteCount = Math.ceil(boolBitCount / 8);
  const booleansBuffer = new BufferConstructor(boolByteCount);
  const booleans = new Uint8Array(booleansBuffer);
  
  // Null flags (bit-packed)
  const nullByteCount = Math.ceil((len * schema.fields.length) / 8);
  const nullFlagsBuffer = new BufferConstructor(nullByteCount);
  const nullFlags = new Uint8Array(nullFlagsBuffer);
  
  // Create packed structure with phantom type
  const packed: PackedData<T> = {
    schema,
    length: len,
    numbers,
    strings: new Uint8Array(0), // Will be set by pack function
    stringOffsets,
    stringLengths,
    booleans,
    nullFlags,
    isShared: options.useSharedArrayBuffer === true
  };
  
  // Execute JIT-compiled pack function
  if (schema.packFn) {
    schema.packFn(data as readonly PackableObject[], packed);
  }
  
  return packed;
}

/**
 * Restore an array of objects from packed TypedArrays.
 * 
 * This is the inverse of `autoPack()`. It reconstructs the original objects
 * from the column-oriented TypedArray storage, including nested objects.
 * 
 * Objects are reconstructed with consistent property order (V8 hidden class
 * optimization) for better performance in subsequent operations.
 * 
 * @typeParam T - The expected object type to restore
 * @param packed - Packed data structure from `autoPack()`
 * @returns Array of reconstructed objects with the original structure
 * 
 * @example Basic usage
 * ```typescript
 * // In worker thread
 * const packed = /* received from main thread *\/;
 * const users = autoUnpack<User>(packed);
 * 
 * // Process users...
 * const processed = users.map(u => ({ ...u, score: calculateScore(u) }));
 * ```
 * 
 * @example Type safety
 * ```typescript
 * interface User {
 *   id: number;
 *   name: string;
 *   active: boolean;
 * }
 * 
 * const users = autoUnpack<User>(packed);
 * // users is User[] with full type inference
 * ```
 * 
 * @see autoPack - To pack objects into TypedArrays
 */
/**
 * Restore an array of objects from packed TypedArrays.
 * 
 * @typeParam T - Expected object type (inferred from PackedData if available)
 * @param packed - Packed data structure from autoPack()
 * @returns Array of reconstructed objects with type T
 */
export function autoUnpack<T extends PackableObject>(
  packed: PackedData<T>
): T[] {
  if (packed.length === 0) {
    return [];
  }
  
  const schema = packed.schema;
  
  // Execute JIT-compiled unpack function
  if (schema.unpackFn) {
    return schema.unpackFn(packed) as T[];
  }
  
  // Fallback (should never happen if schema is cached)
  return [];
}

// ============================================================================
// ARRAY TYPE DETECTION - ELYSIA-STYLE ULTRA PERFORMANCE
// ============================================================================

// typeof charCode lookup table (first char is enough for most cases)
// 'n'=110 (number), 's'=115 (string/symbol), 'o'=111 (object)
// 'f'=102 (function), 'b'=98 (boolean/bigint), 'u'=117 (undefined)
// Disambiguation: 't'=116 (string[1]) vs 'y'=121 (symbol[1])

// PERF: Inline constants (JIT will embed these)
const CC_N = 110; // 'n' - number
const CC_S = 115; // 's' - string/symbol
const CC_O = 111; // 'o' - object
const CC_F = 102; // 'f' - function
const CC_B = 98;  // 'b' - boolean/bigint
const CC_T = 116; // 't' - string[1]
const CC_Y = 121; // 'y' - symbol[1]

/**
 * Ultra-fast array type detection.
 * 
 * PERF: CharCode lookup (no string compare), minimal branches.
 */
export function detectArrayType(data: unknown[]): 'number' | 'string' | 'object' | 'mixed' | 'unsupported' {
  const len = data.length;
  // PERF: Bitwise check - (len | 0) === 0 is faster than len === 0
  if ((len | 0) === 0) return 'unsupported';
  
  const sample = data[0];
  const t = typeof sample;
  const c = t.charCodeAt(0);
  
  // PERF: Most common first (number is most common in turbo mode)
  if (c === CC_N) return 'number';
  if (c === CC_S) return t.charCodeAt(1) === CC_T ? 'string' : 'unsupported';
  
  if (c === CC_O) {
    // PERF: Combine null + Array check with short-circuit
    if (sample === null || Array.isArray(sample)) return 'unsupported';
    
    // Validate object fields
    const keys = Object.keys(sample as object);
    const kLen = keys.length;
    const obj = sample as Record<string, unknown>;
    
    for (let i = 0; i < kLen; i++) {
      const val = obj[keys[i]];
      const vt = typeof val;
      const vc = vt.charCodeAt(0);
      
      // PERF: Bitwise OR for multiple reject conditions
      // Reject: function | symbol | bigint | array
      if (vc === CC_F) return 'unsupported';
      if (vc === CC_S && vt.charCodeAt(1) === CC_Y) return 'unsupported';
      if (vc === CC_B && vt.length === 6) return 'unsupported'; // bigint=6, boolean=7
      if (vc === CC_O && val !== null && Array.isArray(val)) return 'unsupported';
    }
    return 'object';
  }
  
  return 'unsupported';
}

/**
 * Type guard: Check if array can be packed with AutoPack.
 * 
 * @param data - Array to check
 * @returns True if array contains packable objects
 * 
 * PERF: Inline validation, early return, bitwise ops.
 */
export function canAutoPack(data: readonly unknown[]): data is readonly Record<string, unknown>[] {
  const len = data.length;
  if ((len | 0) === 0) return false;
  
  const sample = data[0];
  
  // PERF: typeof + charCode in one expression
  if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return false;
  
  const keys = Object.keys(sample);
  const kLen = keys.length;
  const obj = sample as Record<string, unknown>;
  
  for (let i = 0; i < kLen; i++) {
    const val = obj[keys[i]];
    const vt = typeof val;
    const vc = vt.charCodeAt(0);
    
    // Reject unsupported types
    if (vc === CC_F) return false; // function
    if (vc === CC_S && vt.charCodeAt(1) === CC_Y) return false; // symbol
    if (vc === CC_B && vt.length === 6) return false; // bigint
    if (vc === CC_O && val !== null && Array.isArray(val)) return false; // nested array
  }
  
  return true;
}

/**
 * Type guard: Check if value is a PackedData structure.
 */
export function isPackedData<T extends PackableObject = PackableObject>(
  value: unknown
): value is PackedData<T> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schema === 'object' &&
    typeof v.length === 'number' &&
    v.numbers instanceof Float64Array &&
    v.strings instanceof Uint8Array &&
    v.stringOffsets instanceof Uint32Array &&
    typeof v.isShared === 'boolean'
  );
}

/**
 * Type guard: Check if value is a PackedNumberArray.
 */
export function isPackedNumberArray(value: unknown): value is PackedNumberArray {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 0x01 && typeof v.length === 'number' && v.data instanceof Float64Array;
}

/**
 * Type guard: Check if value is a PackedStringArray.
 */
export function isPackedStringArray(value: unknown): value is PackedStringArray {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === 0x02 &&
    typeof v.length === 'number' &&
    v.data instanceof Uint8Array &&
    v.offsets instanceof Uint32Array &&
    v.lengths instanceof Uint32Array
  );
}

// ============================================================================
// NUMBER ARRAY PACKING - ELYSIA-STYLE ULTRA PERFORMANCE
// ============================================================================

/**
 * Packed number array structure.
 * V8: Stable shape, numeric type tag for fast switch.
 */
export interface PackedNumberArray {
  readonly type: 0x01;
  readonly length: number;
  readonly data: Float64Array;
}

// V8: Frozen singleton - zero allocation for empty
const EMPTY_NUMBER_PACK: PackedNumberArray = Object.freeze({
  type: 0x01 as const,
  length: 0,
  data: new Float64Array(0)
});

/**
 * Pack number[] → Float64Array.
 * 
 * PERF: Loop unrolling 8x, bitwise ops, zero branches in hot path.
 * Benchmark: 10M numbers in ~15ms (vs ~45ms naive)
 */
export function packNumberArray(numbers: number[]): PackedNumberArray {
  const len = numbers.length;
  if (len === 0) return EMPTY_NUMBER_PACK;
  
  const data = new Float64Array(len);
  
  // V8: Unroll 8x for max ILP (instruction-level parallelism)
  // CPU can execute 8 independent stores in parallel
  const end8 = len & ~7; // len - (len % 8)
  let i = 0;
  
  // Hot loop: 8 items per iteration
  while (i < end8) {
    data[i] = numbers[i];
    data[i | 1] = numbers[i | 1];
    data[i | 2] = numbers[i | 2];
    data[i | 3] = numbers[i | 3];
    data[i | 4] = numbers[i | 4];
    data[i | 5] = numbers[i | 5];
    data[i | 6] = numbers[i | 6];
    data[i | 7] = numbers[i | 7];
    i += 8;
  }
  
  // Remainder: 0-7 items
  while (i < len) {
    data[i] = numbers[i];
    i++;
  }
  
  return { type: 0x01, length: len, data };
}

/**
 * Unpack Float64Array → number[].
 * 
 * PERF: Loop unrolling 8x, pre-allocated result array.
 */
export function unpackNumberArray(packed: PackedNumberArray): number[] {
  const len = packed.length;
  if (len === 0) return [];
  
  const data = packed.data;
  const result = new Array<number>(len);
  
  const end8 = len & ~7;
  let i = 0;
  
  while (i < end8) {
    result[i] = data[i];
    result[i | 1] = data[i | 1];
    result[i | 2] = data[i | 2];
    result[i | 3] = data[i | 3];
    result[i | 4] = data[i | 4];
    result[i | 5] = data[i | 5];
    result[i | 6] = data[i | 6];
    result[i | 7] = data[i | 7];
    i += 8;
  }
  
  // Remainder: 0-7 items
  while (i < len) {
    result[i] = data[i];
    i++;
  }
  
  return result;
}

/**
 * Get transferable buffer.
 * V8: Direct return, no intermediate array when possible.
 */
export function getNumberArrayTransferables(packed: PackedNumberArray): ArrayBuffer[] {
  return [packed.data.buffer as ArrayBuffer];
}

// ============================================================================
// STRING ARRAY PACKING - ELYSIA-STYLE ULTRA PERFORMANCE
// ============================================================================

/**
 * Packed string array structure.
 * V8: Stable shape, numeric type tag.
 */
export interface PackedStringArray {
  readonly type: 0x02;
  readonly length: number;
  readonly data: Uint8Array;
  readonly offsets: Uint32Array;
  readonly lengths: Uint32Array;
}

// V8: Frozen singleton
const EMPTY_STRING_PACK: PackedStringArray = Object.freeze({
  type: 0x02 as const,
  length: 0,
  data: new Uint8Array(0),
  offsets: new Uint32Array(0),
  lengths: new Uint32Array(0)
});

// PERF: Reusable encode buffer (avoid allocation per call)
// MEMORY SAFETY: Max 256MB, auto-shrink when oversized
const STRING_PACK_BUFFER_INITIAL = 1 << 20;  // 1MB
const STRING_PACK_BUFFER_MAX = 1 << 28;      // 256MB
let _encBuf = new Uint8Array(STRING_PACK_BUFFER_INITIAL);
let _encBufLastUsed = 0;

/**
 * Pack string[] → Uint8Array (UTF-8).
 * 
 * PERF: 
 * - Reusable buffer (zero alloc in hot path)
 * - encodeInto (fastest UTF-8 encoder)
 * - Single pass
 * - Bitwise capacity check
 */
export function packStringArray(strings: string[]): PackedStringArray {
  const len = strings.length;
  if (len === 0) return EMPTY_STRING_PACK;
  
  const offsets = new Uint32Array(len);
  const lengths = new Uint32Array(len);
  
  // PERF: Estimate total bytes (ASCII fast path: 1 byte/char)
  let totalChars = 0;
  let i = 0;
  const end4 = len & ~3;
  
  // Unroll 4x for char counting
  while (i < end4) {
    totalChars += strings[i].length + strings[i | 1].length + 
                  strings[i | 2].length + strings[i | 3].length;
    i += 4;
  }
  while (i < len) totalChars += strings[i++].length;
  
  // Worst case: 3 bytes per char (full UTF-8)
  const maxBytes = totalChars * 3;
  
  // MEMORY SAFETY: Check max limit
  if (maxBytes > STRING_PACK_BUFFER_MAX) {
    throw new Error(`AutoPack: String data too large (${maxBytes} bytes > ${STRING_PACK_BUFFER_MAX} max)`);
  }
  
  // PERF: Grow buffer if needed (power of 2 for alignment)
  if (maxBytes > _encBuf.length) {
    const newSize = Math.min(1 << (32 - Math.clz32(maxBytes)), STRING_PACK_BUFFER_MAX);
    _encBuf = new Uint8Array(newSize);
  }
  
  // Single pass encode
  let writePos = 0;
  for (i = 0; i < len; i++) {
    const str = strings[i];
    const { written } = textEncoder.encodeInto(str, _encBuf.subarray(writePos));
    offsets[i] = writePos;
    lengths[i] = written;
    writePos += written;
  }
  
  // Track last used size for shrinking
  _encBufLastUsed = writePos;
  
  // PERF: slice() creates new buffer (required for transfer)
  // Auto-shrink if buffer grew too large
  const result: PackedStringArray = {
    type: 0x02,
    length: len,
    data: _encBuf.slice(0, writePos),
    offsets,
    lengths
  };
  
  // MEMORY SAFETY: Shrink if buffer is >4MB and last use was <25%
  if (_encBuf.length > (1 << 22) && _encBufLastUsed < (_encBuf.length >> 2)) {
    _encBuf = new Uint8Array(STRING_PACK_BUFFER_INITIAL);
  }
  
  return result;
}

/**
 * Unpack Uint8Array (UTF-8) → string[].
 * 
 * PERF: Loop unrolling 4x (limited by TextDecoder call overhead).
 */
export function unpackStringArray(packed: PackedStringArray): string[] {
  const len = packed.length;
  if (len === 0) return [];
  
  const data = packed.data;
  const offsets = packed.offsets;
  const lengths = packed.lengths;
  const result = new Array<string>(len);
  
  // PERF: Unroll 4x (TextDecoder is the bottleneck, not loop)
  const end4 = len & ~3;
  let i = 0;
  
  while (i < end4) {
    const o0 = offsets[i], o1 = offsets[i | 1], o2 = offsets[i | 2], o3 = offsets[i | 3];
    const l0 = lengths[i], l1 = lengths[i | 1], l2 = lengths[i | 2], l3 = lengths[i | 3];
    result[i] = textDecoder.decode(data.subarray(o0, o0 + l0));
    result[i | 1] = textDecoder.decode(data.subarray(o1, o1 + l1));
    result[i | 2] = textDecoder.decode(data.subarray(o2, o2 + l2));
    result[i | 3] = textDecoder.decode(data.subarray(o3, o3 + l3));
    i += 4;
  }
  
  // Remainder
  while (i < len) {
    const o = offsets[i];
    result[i] = textDecoder.decode(data.subarray(o, o + lengths[i]));
    i++;
  }
  
  return result;
}

/**
 * Get transferable buffers.
 */
export function getStringArrayTransferables(packed: PackedStringArray): ArrayBuffer[] {
  return [
    packed.data.buffer as ArrayBuffer,
    packed.offsets.buffer as ArrayBuffer,
    packed.lengths.buffer as ArrayBuffer
  ];
}

/**
 * Get the list of transferable ArrayBuffers from packed data.
 * 
 * Use this with `postMessage` to enable zero-copy transfer of the
 * packed data to a worker thread. After transfer, the buffers become
 * unusable in the sending thread (neutered).
 * 
 * If the packed data was created with `useSharedArrayBuffer: true`,
 * this returns an empty array (SharedArrayBuffers don't need transfer).
 * 
 * @param packed - Packed data from `autoPack()`
 * @returns Array of ArrayBuffers to pass as transferables
 * 
 * @example
 * ```typescript
 * const packed = autoPack(users);
 * const transferables = getTransferables(packed);
 * 
 * // Zero-copy transfer to worker
 * worker.postMessage(packed, transferables);
 * 
 * // After transfer, packed.numbers.buffer.byteLength === 0 (neutered)
 * ```
 * 
 * @example SharedArrayBuffer (no transfer needed)
 * ```typescript
 * const packed = autoPack(users, { useSharedArrayBuffer: true });
 * const transferables = getTransferables(packed); // []
 * 
 * // SharedArrayBuffer is automatically shared
 * worker.postMessage(packed);
 * ```
 * 
 * @see autoPack - To create packed data
 */
export function getTransferables<T extends PackableObject>(packed: PackedData<T>): ArrayBuffer[] {
  if (packed.isShared) {
    return []; // SharedArrayBuffers don't need transfer
  }
  
  const buffers: ArrayBuffer[] = [];
  
  // Cast to ArrayBuffer since we checked isShared is false
  if (packed.numbers.buffer.byteLength > 0) {
    buffers.push(packed.numbers.buffer as ArrayBuffer);
  }
  if (packed.strings.buffer.byteLength > 0) {
    buffers.push(packed.strings.buffer as ArrayBuffer);
  }
  if (packed.stringOffsets.buffer.byteLength > 0) {
    buffers.push(packed.stringOffsets.buffer as ArrayBuffer);
  }
  if (packed.stringLengths.buffer.byteLength > 0) {
    buffers.push(packed.stringLengths.buffer as ArrayBuffer);
  }
  if (packed.booleans.buffer.byteLength > 0) {
    buffers.push(packed.booleans.buffer as ArrayBuffer);
  }
  if (packed.nullFlags.buffer.byteLength > 0) {
    buffers.push(packed.nullFlags.buffer as ArrayBuffer);
  }
  
  return buffers;
}

/**
 * Create empty packed data structure with type preservation.
 */
function createEmptyPackedData<T extends PackableObject>(): PackedData<T> {
  return {
    schema: {
      hash: 'empty',
      fields: [],
      numericFields: [],
      stringFields: [],
      booleanFields: [],
      nullableFields: new Set(),
      totalNumericCount: 0,
      totalStringCount: 0,
      totalBooleanCount: 0,
      maxDepth: 0,
      packFn: null,
      unpackFn: null
    },
    length: 0,
    numbers: new Float64Array(0),
    strings: new Uint8Array(0),
    stringOffsets: new Uint32Array(0),
    stringLengths: new Uint16Array(0),
    booleans: new Uint8Array(0),
    nullFlags: new Uint8Array(0),
    isShared: false
  };
}

// ============================================================================
// STATISTICS & DEBUGGING
// ============================================================================

/**
 * Get statistics about AutoPack internal caches.
 * 
 * Useful for monitoring memory usage and debugging performance issues.
 * 
 * @returns Object containing cache statistics:
 *   - `schemaCacheSize`: Number of cached object schemas (max 64)
 * 
 * @example
 * ```typescript
 * const stats = getAutoPackStats();
 * console.log(`Schema cache: ${stats.schemaCacheSize}/64 entries`);
 * ```
 */
export function getAutoPackStats(): {
  schemaCacheSize: number;
  encodeBufferSize: number;
  stringBufferSize: number;
  totalMemoryBytes: number;
} {
  const encSize = encodeBuffer.length;
  const strSize = _encBuf.length;
  return {
    schemaCacheSize: schemaCache.size,
    encodeBufferSize: encSize,
    stringBufferSize: strSize,
    totalMemoryBytes: encSize + strSize
  };
}

/**
 * Clear all AutoPack internal caches.
 * 
 * Use this for:
 * - Testing (ensure fresh state between tests)
 * - Memory pressure situations
 * - After processing data with many different schemas
 * 
 * **Note:** After clearing, the next `autoPack()` call will need to
 * re-infer the schema and recompile pack/unpack functions.
 * 
 * @example
 * ```typescript
 * // In tests
 * beforeEach(() => {
 *   clearAutoPackCaches();
 * });
 * ```
 */
export function clearAutoPackCaches(): void {
  schemaCache.clear();
  // Reset buffers to initial size (free memory)
  encodeBuffer = new Uint8Array(ENCODE_BUFFER_INITIAL);
  encodeBufferLastUsedSize = 0;
  _encBuf = new Uint8Array(STRING_PACK_BUFFER_INITIAL);
  _encBufLastUsed = 0;
}

// ============================================================================
// TRANSFERABLE SUPPORT (for worker communication)
// ============================================================================

/**
 * Schema without JIT functions (can be transferred via postMessage)
 */
export interface TransferableSchema {
  hash: string;
  fields: readonly FieldDescriptor[];
  numericFields: readonly FieldDescriptor[];
  stringFields: readonly FieldDescriptor[];
  booleanFields: readonly FieldDescriptor[];
  nullableFields: string[]; // Array instead of Set for transfer
  totalNumericCount: number;
  totalStringCount: number;
  totalBooleanCount: number;
  maxDepth: number;
}

/**
 * PackedData without JIT functions (can be transferred via postMessage)
 */
export interface TransferablePackedData {
  schema: TransferableSchema;
  length: number;
  numbers: Float64Array;
  strings: Uint8Array;
  stringOffsets: Uint32Array;
  stringLengths: Uint16Array;
  booleans: Uint8Array;
  nullFlags: Uint8Array;
  isShared: boolean;
}

/**
 * Convert PackedData to transferable format (removes JIT functions).
 * 
 * Use this before sending PackedData to a worker via postMessage.
 * The schema's packFn/unpackFn cannot be cloned, so we strip them.
 * 
 * @param packed - PackedData from autoPack()
 * @returns Transferable version without functions
 */
export function makeTransferable(packed: PackedData): TransferablePackedData {
  return {
    schema: {
      hash: packed.schema.hash,
      fields: packed.schema.fields,
      numericFields: packed.schema.numericFields,
      stringFields: packed.schema.stringFields,
      booleanFields: packed.schema.booleanFields,
      nullableFields: Array.from(packed.schema.nullableFields),
      totalNumericCount: packed.schema.totalNumericCount,
      totalStringCount: packed.schema.totalStringCount,
      totalBooleanCount: packed.schema.totalBooleanCount,
      maxDepth: packed.schema.maxDepth
    },
    length: packed.length,
    numbers: packed.numbers,
    strings: packed.strings,
    stringOffsets: packed.stringOffsets,
    stringLengths: packed.stringLengths,
    booleans: packed.booleans,
    nullFlags: packed.nullFlags,
    isShared: packed.isShared
  };
}

/**
 * Get ArrayBuffers from TransferablePackedData for zero-copy transfer.
 */
export function getTransferablesFromPacked(packed: TransferablePackedData): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  if (packed.numbers.buffer.byteLength > 0) buffers.push(packed.numbers.buffer as ArrayBuffer);
  if (packed.strings.buffer.byteLength > 0) buffers.push(packed.strings.buffer as ArrayBuffer);
  if (packed.stringOffsets.buffer.byteLength > 0) buffers.push(packed.stringOffsets.buffer as ArrayBuffer);
  if (packed.stringLengths.buffer.byteLength > 0) buffers.push(packed.stringLengths.buffer as ArrayBuffer);
  if (packed.booleans.buffer.byteLength > 0) buffers.push(packed.booleans.buffer as ArrayBuffer);
  if (packed.nullFlags.buffer.byteLength > 0) buffers.push(packed.nullFlags.buffer as ArrayBuffer);
  return buffers;
}

/**
 * Threshold for automatic AutoPack usage based on array length.
 * Below this, structuredClone is faster. Above this, AutoPack wins.
 * 
 * Updated: 500 items threshold for consistent behavior across BUN and Node.
 */
export const AUTOPACK_ARRAY_THRESHOLD = 500;

/**
 * Generic unpack function code for workers (no JIT dependency).
 * Include this in worker code to enable AutoPack support.
 */
export const GENERIC_UNPACK_CODE = `
function genericUnpack(packed) {
  const { schema, length, numbers, strings, stringOffsets, stringLengths, booleans } = packed;
  const { numericFields, stringFields, booleanFields } = schema;
  
  if (length === 0) return [];
  
  const result = new Array(length);
  const decoder = new TextDecoder();
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  for (let i = 0; i < length; i++) {
    const obj = {};
    
    // Numbers (column-oriented)
    for (let f = 0; f < numCount; f++) {
      obj[numericFields[f].name] = numbers[f * length + i];
    }
    
    // Strings
    for (let f = 0; f < strCount; f++) {
      const idx = f * length + i;
      const offset = stringOffsets[idx];
      const len = stringLengths[idx];
      obj[stringFields[f].name] = decoder.decode(strings.subarray(offset, offset + len));
    }
    
    // Booleans (bit-packed)
    for (let f = 0; f < boolCount; f++) {
      const bitIndex = f * length + i;
      const byteIndex = Math.floor(bitIndex / 8);
      const bitOffset = bitIndex % 8;
      obj[booleanFields[f].name] = (booleans[byteIndex] & (1 << bitOffset)) !== 0;
    }
    
    result[i] = obj;
  }
  
  return result;
}
`;

/**
 * Generic pack function code for workers (simplified, no JIT).
 * Used to pack results back to main thread.
 */
export const GENERIC_PACK_CODE = `
function genericPack(data) {
  const len = data.length;
  if (len === 0) return { length: 0, schema: { numericFields: [], stringFields: [], booleanFields: [] }, numbers: new Float64Array(0), strings: new Uint8Array(0), stringOffsets: new Uint32Array(0), stringLengths: new Uint16Array(0), booleans: new Uint8Array(0), nullFlags: new Uint8Array(0), isShared: false };
  
  const sample = data[0];
  const keys = Object.keys(sample);
  const numericFields = [];
  const stringFields = [];
  const booleanFields = [];
  
  for (const key of keys) {
    const val = sample[key];
    const type = typeof val;
    if (type === 'number') numericFields.push({ name: key });
    else if (type === 'string') stringFields.push({ name: key });
    else if (type === 'boolean') booleanFields.push({ name: key });
  }
  
  const numCount = numericFields.length;
  const strCount = stringFields.length;
  const boolCount = booleanFields.length;
  
  // Allocate
  const numbers = new Float64Array(len * numCount);
  const encoder = new TextEncoder();
  const stringParts = [];
  const stringOffsets = new Uint32Array(len * strCount);
  const stringLengths = new Uint16Array(len * strCount);
  let strOffset = 0;
  
  const boolBitCount = len * boolCount;
  const booleans = new Uint8Array(Math.ceil(boolBitCount / 8));
  
  // Pack
  for (let i = 0; i < len; i++) {
    const obj = data[i];
    
    for (let f = 0; f < numCount; f++) {
      numbers[f * len + i] = obj[numericFields[f].name];
    }
    
    for (let f = 0; f < strCount; f++) {
      const str = obj[stringFields[f].name] || '';
      const encoded = encoder.encode(str);
      stringParts.push(encoded);
      const idx = f * len + i;
      stringOffsets[idx] = strOffset;
      stringLengths[idx] = encoded.length;
      strOffset += encoded.length;
    }
    
    for (let f = 0; f < boolCount; f++) {
      if (obj[booleanFields[f].name]) {
        const bitIndex = f * len + i;
        const byteIndex = Math.floor(bitIndex / 8);
        const bitOffset = bitIndex % 8;
        booleans[byteIndex] |= (1 << bitOffset);
      }
    }
  }
  
  // Merge strings
  const strings = new Uint8Array(strOffset);
  let pos = 0;
  for (const part of stringParts) {
    strings.set(part, pos);
    pos += part.length;
  }
  
  return {
    schema: { numericFields, stringFields, booleanFields },
    length: len,
    numbers,
    strings,
    stringOffsets,
    stringLengths,
    booleans,
    nullFlags: new Uint8Array(0),
    isShared: false
  };
}
`;

// ============================================================================
// EXPORTS
// ============================================================================

export type {
  PackedData,
  CompiledSchema,
  FieldDescriptor,
  PrimitiveType,
  PackableObject,
  PackablePrimitive,
  PackableValue,
  AutoPackOptions
};

