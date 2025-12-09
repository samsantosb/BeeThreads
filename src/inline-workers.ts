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

function compile(src, context) {
  // IMPORTANT: Cache key must include context VALUES, not just keys!
  // Otherwise two calls with same function but different context values
  // would incorrectly return the cached function compiled with old values.
  const ctxKey = context ? JSON.stringify(context) : '';
  const key = src + '::' + ctxKey;
  let fn = LOW_MEMORY ? null : cacheGet(key);
  if (fn) return fn;

  const script = new vm.Script('(' + src + ')', { filename: 'bee-worker.js' });
  
  if (context && Object.keys(context).length > 0) {
    const sandbox = Object.create(getBaseContext());
    const keys = Object.keys(context);
    for (let i = 0; i < keys.length; i++) sandbox[keys[i]] = context[keys[i]];
    fn = script.runInContext(vm.createContext(sandbox));
  } else {
    fn = script.runInContext(getBaseContext());
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

// Turbo mode handler
function handleTurbo(msg) {
  const { type, fn: fnSrc, chunk, startIndex, endIndex, context, inputBuffer, outputBuffer, controlBuffer, initialValue, workerId } = msg;
  
  try {
    const fn = compile(fnSrc, context);
    if (typeof fn !== 'function') throw new TypeError('Turbo function failed to compile');
    
    // SharedArrayBuffer mode (TypedArrays)
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
    
    // Chunk mode (regular arrays)
    if (chunk) {
      let result;
      if (type === 'turbo_map') {
        result = new Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) result[i] = fn(chunk[i], i);
      } else if (type === 'turbo_filter') {
        result = [];
        for (let i = 0; i < chunk.length; i++) if (fn(chunk[i], i)) result.push(chunk[i]);
      } else if (type === 'turbo_reduce') {
        let acc = initialValue;
        for (let i = 0; i < chunk.length; i++) acc = fn(acc, chunk[i], i);
        result = [acc];
      } else {
        throw new Error('Unknown turbo type: ' + type);
      }
      port.postMessage({ type: 'turbo_complete', workerId, result, itemsProcessed: chunk.length });
      return;
    }
    
    throw new Error('Turbo message missing chunk or SharedArrayBuffer');
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
 * Minimal inline worker code for generator/stream execution.
 * Self-contained - no external imports needed.
 */
export const INLINE_GENERATOR_WORKER_CODE = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

if (!parentPort) process.exit(1);

const port = parentPort;
const config = workerData || {};
const DEBUG_MODE = config.debugMode || false;
const LOW_MEMORY = config.lowMemoryMode || false;
const CACHE_SIZE = config.functionCacheSize || 100;

const MSG = { SUCCESS: 'success', ERROR: 'error', LOG: 'log', YIELD: 'yield', RETURN: 'return', END: 'end' };
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

function compile(src, context) {
  // IMPORTANT: Cache key must include context VALUES, not just keys!
  // Otherwise two calls with same function but different context values
  // would incorrectly return the cached function compiled with old values.
  const ctxKey = context ? JSON.stringify(context) : '';
  const key = src + '::' + ctxKey;
  let fn = LOW_MEMORY ? null : cacheGet(key);
  if (fn) return fn;

  const script = new vm.Script('(' + src + ')', { filename: 'bee-generator.js' });
  
  if (context && Object.keys(context).length > 0) {
    const sandbox = Object.create(getBaseContext());
    for (const k of Object.keys(context)) sandbox[k] = context[k];
    fn = script.runInContext(vm.createContext(sandbox));
  } else {
    fn = script.runInContext(getBaseContext());
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
  /^function\\s*\\*/, /^async\\s+function\\s*\\*/,
  /^function\\s*\\w*\\s*\\(/, /^async\\s+function\\s*\\w*\\s*\\(/,
  /^\\(.*\\)\\s*=>/, /^\\w+\\s*=>/, /^async\\s*\\(.*\\)\\s*=>/, /^async\\s+\\w+\\s*=>/,
];

function validate(src) {
  if (typeof src !== 'string') throw new TypeError('Function source must be a string');
  const t = src.trim();
  for (const p of PATTERNS) if (p.test(t)) return;
  throw new TypeError('Invalid function source');
}

function isGenerator(obj) {
  return obj && typeof obj.next === 'function' && typeof obj[Symbol.iterator] === 'function';
}

let gen = null;

async function runGenerator(iterator) {
  try {
    while (true) {
      const { value, done } = iterator.next();
      if (done) {
        port.postMessage({ type: MSG.RETURN, value });
        port.postMessage({ type: MSG.END });
        currentFn = null;
        return;
      }
      
      if (value && typeof value === 'object' && typeof value.then === 'function') {
        value.then(v => port.postMessage({ type: MSG.YIELD, value: v }))
          .catch(e => {
            port.postMessage({ type: MSG.ERROR, error: serializeError(e) });
            currentFn = null;
            try { iterator.return?.(); } catch {}
          });
      } else {
        port.postMessage({ type: MSG.YIELD, value });
      }
    }
  } catch (e) {
    port.postMessage({ type: MSG.ERROR, error: serializeError(e) });
    currentFn = null;
  }
}

port.on('message', (msg) => {
  const { fn: src, args, context } = msg;
  currentFn = src;
  
  try {
    validate(src);
    const fn = compile(src, context);
    if (typeof fn !== 'function') throw new TypeError('Not a function');
    
    const result = args && args.length > 0 ? fn(...args) : fn();
    
    if (!isGenerator(result)) {
      throw new TypeError('Function must return a generator');
    }
    
    gen = result;
    runGenerator(gen);
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

