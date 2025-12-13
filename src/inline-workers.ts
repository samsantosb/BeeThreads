/**
 * @fileoverview Inline worker code for bundler compatibility.
 * 
 * ## Why This Exists
 * 
 * Bundlers (webpack, vite, rspack, esbuild) don't include worker files by default.
 * This module provides inline worker code that works without external files.
 * 
 * ## Security
 * 
 * Uses `data:` URLs instead of `eval: true` - more secure and CSP-friendly.
 * The worker code is static (not from user input), so it's safe.
 * 
 * @module bee-threads/inline-workers
 * @internal
 */

/**
 * Minimal inline worker code for normal function execution.
 * Self-contained - no external imports needed.
 */
export const INLINE_WORKER_CODE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

if (!parentPort) process.exit(1);

const port = parentPort;
const config = workerData || {};
const DEBUG_MODE = config.debugMode || false;
const LOW_MEMORY = config.lowMemoryMode || false;
const CACHE_SIZE = config.functionCacheSize || 100;

const MSG = { SUCCESS: 'success', ERROR: 'error', LOG: 'log' };
const LOG = { LOG: 'log', WARN: 'warn', ERROR: 'error', INFO: 'info', DEBUG: 'debug' };

let currentFn = null;

const cache = new Map();
const cacheOrder = [];

function cacheGet(key) {
  if (cache.has(key)) {
    const idx = cacheOrder.indexOf(key);
    if (idx > -1) { cacheOrder.splice(idx, 1); cacheOrder.push(key); }
    return cache.get(key);
  }
  return null;
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_SIZE) {
    const oldest = cacheOrder.shift();
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, value);
  cacheOrder.push(key);
}

let baseCtx = null;
function getBaseContext() {
  if (!baseCtx) {
    baseCtx = vm.createContext({
      console, setTimeout, setInterval, clearTimeout, clearInterval,
      setImmediate, clearImmediate, queueMicrotask,
      Buffer, process, URL, URLSearchParams, TextEncoder, TextDecoder,
      AbortController, AbortSignal, Event, EventTarget,
      atob, btoa, structuredClone,
      Math, Date, JSON, Object, Array, String, Number, Boolean,
      Map, Set, WeakMap, WeakSet, Promise, Symbol, BigInt,
      Error, TypeError, RangeError, SyntaxError, ReferenceError,
      AggregateError, EvalError, URIError,
      parseInt, parseFloat, isNaN, isFinite, encodeURI, decodeURI,
      encodeURIComponent, decodeURIComponent,
      Uint8Array, Int8Array, Uint16Array, Int16Array,
      Uint32Array, Int32Array, Float32Array, Float64Array,
      BigInt64Array, BigUint64Array, ArrayBuffer, SharedArrayBuffer, DataView,
      Proxy, Reflect, WeakRef, FinalizationRegistry,
      require: require
    });
  }
  return baseCtx;
}

// LRU cache for reconstructed context functions (avoids recompiling same fn in different contexts)
const ctxFnCache = new Map();
const CTX_FN_CACHE_SIZE = 64;

// Reconstruct serialized functions from context using vm.Script (faster than eval!)
function reconstructContext(context) {
  if (!context) return context;
  const result = {};
  const keys = Object.keys(context);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = context[key];
    if (typeof value === 'string' && value.startsWith('__BEE_FN__:')) {
      const fnStr = value.slice(11); // Remove '__BEE_FN__:' prefix
      // Check cache first
      let fn = ctxFnCache.get(fnStr);
      if (!fn) {
        try {
          const script = new vm.Script('(' + fnStr + ')', { filename: 'bee-context-fn.js' });
          fn = script.runInThisContext();
          // LRU eviction
          if (ctxFnCache.size >= CTX_FN_CACHE_SIZE) {
            const firstKey = ctxFnCache.keys().next().value;
            if (firstKey) ctxFnCache.delete(firstKey);
          }
          ctxFnCache.set(fnStr, fn);
        } catch (e) {
          throw new Error('Failed to reconstruct function "' + key + '": ' + e.message);
        }
      }
      result[key] = fn;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function compile(src, context) {
  // Reconstruct any serialized functions in context
  const processedContext = reconstructContext(context);
  
  // IMPORTANT: Cache key must include context VALUES, not just keys!
  const ctxKey = processedContext ? JSON.stringify(context) : '';
  const key = src + '::' + ctxKey;
  let fn = LOW_MEMORY ? null : cacheGet(key);
  if (fn) return fn;

  if (processedContext && Object.keys(processedContext).length > 0) {
    // With context: use vm.Script (slower but needed for context injection)
    const script = new vm.Script('(' + src + ')', { filename: 'bee-worker.js' });
    const sandbox = Object.create(getBaseContext());
    const keys = Object.keys(processedContext);
    for (let i = 0; i < keys.length; i++) sandbox[keys[i]] = processedContext[keys[i]];
    fn = script.runInContext(vm.createContext(sandbox));
  } else {
    // FAST PATH: No context - use new Function() which is 30x faster!
    // vm.runInContext() has massive overhead even with cached context
    fn = (new Function('return ' + src))();
  }
  
  if (!LOW_MEMORY) cacheSet(key, fn);
  return fn;
}

function serializeError(e) {
  const s = { name: 'Error', message: '', stack: undefined };
  if (DEBUG_MODE && currentFn) s._sourceCode = currentFn;
  
  if (e && typeof e === 'object' && 'name' in e && 'message' in e) {
    s.name = String(e.name);
    s.message = String(e.message);
    s.stack = e.stack;
    if (e.cause != null) s.cause = serializeError(e.cause);
    if (Array.isArray(e.errors)) s.errors = e.errors.map(serializeError);
    for (const k of Object.keys(e)) {
      if (!['name','message','stack','cause','errors'].includes(k)) {
        const v = e[k];
        if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') s[k] = v;
      }
    }
  } else if (e instanceof Error) {
    s.name = e.name; s.message = e.message; s.stack = e.stack;
  } else {
    s.message = String(e);
  }
  return s;
}

process.on('uncaughtException', (err) => {
  try { port.postMessage({ type: MSG.ERROR, error: serializeError(err) }); }
  catch { process.exit(1); }
});

process.on('unhandledRejection', (reason) => {
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    port.postMessage({ type: MSG.ERROR, error: serializeError(err) });
  } catch { process.exit(1); }
});

const stringify = (args) => args.map(String);
console.log = (...a) => port.postMessage({ type: MSG.LOG, level: LOG.LOG, args: stringify(a) });
console.warn = (...a) => port.postMessage({ type: MSG.LOG, level: LOG.WARN, args: stringify(a) });
console.error = (...a) => port.postMessage({ type: MSG.LOG, level: LOG.ERROR, args: stringify(a) });
console.info = (...a) => port.postMessage({ type: MSG.LOG, level: LOG.INFO, args: stringify(a) });
console.debug = (...a) => port.postMessage({ type: MSG.LOG, level: LOG.DEBUG, args: stringify(a) });

const PATTERNS = [
  /^function\\s*\\w*\\s*\\(/,
  /^async\\s+function\\s*\\w*\\s*\\(/,
  /^\\(.*\\)\\s*=>/,
  /^\\w+\\s*=>/,
  /^async\\s*\\(.*\\)\\s*=>/,
  /^async\\s+\\w+\\s*=>/,
  /^\\(\\s*\\[/,
  /^\\(\\s*\\{/,
];

function validate(src) {
  if (typeof src !== 'string') throw new TypeError('Function source must be a string');
  const t = src.trim();
  for (const p of PATTERNS) if (p.test(t)) return;
  throw new TypeError('Invalid function source');
}

function apply(fn, args) {
  if (!args || args.length === 0) return fn();
  let result = fn(...args);
  if (typeof result === 'function' && args.length > 1) {
    result = fn;
    for (const arg of args) {
      if (typeof result !== 'function') break;
      result = result(arg);
    }
  }
  return result;
}

// ============================================================================
// UNPACK FUNCTIONS - V8 OPTIMIZED (synced with worker.ts)
// ============================================================================

// Unpack number array from Float64Array
function unpackNumbers(packed) {
  const len = packed.length;
  if (len === 0) return [];
  const data = packed.data;
  const result = new Array(len);
  const blockEnd = len & ~3;
  let i = 0;
  for (; i < blockEnd; i += 4) {
    result[i] = data[i];
    result[i + 1] = data[i + 1];
    result[i + 2] = data[i + 2];
    result[i + 3] = data[i + 3];
  }
  for (; i < len; i++) result[i] = data[i];
  return result;
}

// Cached decoder for string unpacking
const stringDecoder = new TextDecoder();

// Unpack string array from UTF-8 bytes
function unpackStrings(packed) {
  const len = packed.length;
  if (len === 0) return [];
  const data = packed.data;
  const offsets = packed.offsets;
  const lengths = packed.lengths;
  const result = new Array(len);
  const blockEnd = len & ~3;
  let i = 0;
  for (; i < blockEnd; i += 4) {
    const o0 = offsets[i], o1 = offsets[i+1], o2 = offsets[i+2], o3 = offsets[i+3];
    const l0 = lengths[i], l1 = lengths[i+1], l2 = lengths[i+2], l3 = lengths[i+3];
    result[i] = stringDecoder.decode(data.subarray(o0, o0 + l0));
    result[i+1] = stringDecoder.decode(data.subarray(o1, o1 + l1));
    result[i+2] = stringDecoder.decode(data.subarray(o2, o2 + l2));
    result[i+3] = stringDecoder.decode(data.subarray(o3, o3 + l3));
  }
  for (; i < len; i++) {
    const o = offsets[i];
    result[i] = stringDecoder.decode(data.subarray(o, o + lengths[i]));
  }
  return result;
}

// Unpack object array from AutoPack columnar format
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
    for (let f = 0; f < numCount; f++) obj[numericFields[f].name] = numbers[f * length + i];
    for (let f = 0; f < strCount; f++) {
      const idx = f * length + i;
      const offset = stringOffsets[idx];
      const len = stringLengths[idx];
      obj[stringFields[f].name] = decoder.decode(strings.subarray(offset, offset + len));
    }
    for (let f = 0; f < boolCount; f++) {
      const bitIndex = f * length + i;
      obj[booleanFields[f].name] = (booleans[Math.floor(bitIndex / 8)] & (1 << (bitIndex % 8))) !== 0;
    }
    result[i] = obj;
  }
  return result;
}

// ============================================================================
// TURBO MODE HANDLER - V8 OPTIMIZED (synced with worker.ts)
// ============================================================================

function handleTurbo(msg) {
  const { type, fn: fnSrc, chunk, startIndex, endIndex, context, inputBuffer, outputBuffer, controlBuffer, initialValue, workerId, packType, packedNumbers, packedStrings, packedData } = msg;
  
  try {
    const fn = compile(fnSrc, context);
    if (typeof fn !== 'function') throw new TypeError('Turbo function failed to compile');
    
    // SharedArrayBuffer mode (for TypedArrays)
    if (inputBuffer && outputBuffer) {
      const inputView = new Float64Array(inputBuffer);
      const outputView = new Float64Array(outputBuffer);
      const start = startIndex || 0;
      const end = endIndex || inputView.length;
      
      if (type === 'turbo_map') {
        for (let i = start; i < end; i++) {
          outputView[i] = fn(inputView[i], i);
        }
      }
      
      if (controlBuffer) {
        const ctrl = new Int32Array(controlBuffer);
        Atomics.add(ctrl, 0, 1);
        Atomics.notify(ctrl, 0);
      }
      
      port.postMessage({ type: 'turbo_complete', workerId, itemsProcessed: end - start });
      return;
    }
    
    // Determine chunk based on packType (synced with worker.ts)
    let actualChunk;
    const pType = packType || 'none';
    
    if (pType === 'number' && packedNumbers) {
      actualChunk = unpackNumbers(packedNumbers);
    } else if (pType === 'string' && packedStrings) {
      actualChunk = unpackStrings(packedStrings);
    } else if (pType === 'object' && packedData) {
      actualChunk = genericUnpack(packedData);
    } else if (chunk) {
      actualChunk = chunk;
    } else {
      throw new Error('Turbo message missing chunk data');
    }
    
    const chunkLen = actualChunk.length;
    let result;
    
    if (type === 'turbo_map') {
      result = new Array(chunkLen);
      for (let i = 0; i < chunkLen; i++) result[i] = fn(actualChunk[i], i);
    } else if (type === 'turbo_filter') {
      result = [];
      for (let i = 0; i < chunkLen; i++) if (fn(actualChunk[i], i)) result.push(actualChunk[i]);
    } else if (type === 'turbo_reduce') {
      let acc = initialValue;
      for (let i = 0; i < chunkLen; i++) acc = fn(acc, actualChunk[i], i);
      result = [acc];
    } else {
      throw new Error('Unknown turbo type: ' + type);
    }
    
    port.postMessage({ type: 'turbo_complete', workerId, result, itemsProcessed: chunkLen });
  } catch (e) {
    port.postMessage({ type: 'turbo_error', workerId, error: serializeError(e), itemsProcessed: 0 });
  }
}

port.on('message', (msg) => {
  // Handle turbo messages
  if (msg.type === 'turbo_map' || msg.type === 'turbo_filter' || msg.type === 'turbo_reduce') {
    handleTurbo(msg);
    return;
  }
  
  const { fn: src, args, context } = msg;
  currentFn = src;
  
  try {
    validate(src);
    const fn = compile(src, context);
    if (typeof fn !== 'function') throw new TypeError('Not a function');
    
    const ret = apply(fn, args);
    
    if (ret && typeof ret === 'object' && typeof ret.then === 'function') {
      ret.then(v => {
        currentFn = null;
        port.postMessage({ type: MSG.SUCCESS, value: v });
      }).catch(e => {
        port.postMessage({ type: MSG.ERROR, error: serializeError(e) });
        currentFn = null;
      });
    } else {
      currentFn = null;
      port.postMessage({ type: MSG.SUCCESS, value: ret });
    }
  } catch (e) {
    port.postMessage({ type: MSG.ERROR, error: serializeError(e) });
    currentFn = null;
  }
});
`;

/**
 * Converts worker code to a data: URL (base64 encoded).
 * More secure than eval: true - works with CSP.
 */
export function createWorkerDataUrl(code: string): string {
  const base64 = Buffer.from(code, 'utf-8').toString('base64');
  return `data:text/javascript;base64,${base64}`;
}

