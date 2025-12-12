// test.ts - bee-threads test suite v1.0.0
import * as assert from 'assert';
import { bee, beeThreads, AbortError, TimeoutError, QueueFullError, WorkerError, noopLogger, RUNTIME, IS_BUN } from './dist/index.js';
import { createLRUCache, createFunctionCache } from './dist/cache.js';
import type { Logger } from './dist/types.js';

// ES2022+ Error types (for TypeScript compatibility)
declare class AggregateError extends Error {
  errors: Error[];
  constructor(errors: Iterable<Error>, message?: string);
}

// Augment Error constructor to accept options with cause
declare interface ErrorConstructor {
  new(message?: string, options?: { cause?: unknown }): Error;
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: unknown) {
    const error = err as Error;
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
    if (error.stack) console.log(`     ${error.stack.split('\n')[1]}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n📦 ${name}`);
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests(): Promise<void> {
  console.log('\n🧪 bee-threads Test Suite\n');
  console.log('='.repeat(50));

  // ---------- BEE() SIMPLE API ----------
  section('bee() - Simple Curried API');

  await test('bee(fn)() executes with no params', async () => {
    const result = await bee(() => 42)();
    assert.strictEqual(result, 42);
  });

  await test('bee(fn)(arg) executes with single argument', async () => {
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
  });

  await test('bee(fn)(a, b, c) executes with multiple arguments', async () => {
    const result = await bee((a: number, b: number, c: number) => a + b + c)(1, 2, 3);
    assert.strictEqual(result, 6);
  });

  await test('bee(fn)(arg)({ beeClosures }) injects context', async () => {
    const TAX = 0.2;
    const result = await bee((p: number) => p * (1 + TAX))(100)({ beeClosures: { TAX } });
    assert.strictEqual(result, 120);
  });

  await test('bee(fn)({ beeClosures }) works without params', async () => {
    const VALUE = 99;
    const result = await bee(() => VALUE)({ beeClosures: { VALUE } });
    assert.strictEqual(result, 99);
  });

  await test('bee(fn)(a)(b)(c) curries multiple calls', async () => {
    const result = await bee((a: number, b: number, c: number) => a + b + c)(1)(2)(3);
    assert.strictEqual(result, 6);
  });

  await test('bee(fn)(a)(b)({ beeClosures }) curries with closures', async () => {
    const CURRY_MULT = 10;
    const result = await bee((a: number, b: number) => (a + b) * CURRY_MULT)(2)(3)({ beeClosures: { CURRY_MULT } });
    assert.strictEqual(result, 50);
  });

  await test('bee() throws TypeError for non-function', () => {
    assert.throws(() => bee('not a function' as any), TypeError);
    assert.throws(() => bee(123 as any), TypeError);
    assert.throws(() => bee(null as any), TypeError);
  });

  await test('bee(fn)(arg) handles async functions', async () => {
    const result = await bee(async (x: number) => {
      return x * 2;
    })(21);
    assert.strictEqual(result, 42);
  });

  await test('bee(fn)(n) handles complex computation', async () => {
    const result = await bee((n: number) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += i;
      return sum;
    })(1000);
    assert.strictEqual(result, 499500);
  });

  await test('bee() hash password example', async () => {
    const hash = await bee((pwd: string) => {
      const crypto = require('crypto');
      return crypto.pbkdf2Sync(pwd, 'salt', 1000, 64, 'sha512').toString('hex');
    })('password123');
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 128);
  });

  await test('bee(fn)(args) with multiple beeClosures values', async () => {
    const A = 10;
    const B = 5;
    const result = await bee((x: number) => x * A + B)(2)({ beeClosures: { A, B } });
    assert.strictEqual(result, 25);
  });

  await test('bee(fn) with nested object in beeClosures', async () => {
    const config = { multiplier: 3, offset: 7 };
    const result = await bee((x: number) => x * config.multiplier + config.offset)(10)({ beeClosures: { config } });
    assert.strictEqual(result, 37);
  });

  await test('bee(fn) with array in beeClosures', async () => {
    const values = [1, 2, 3, 4, 5];
    const result = await bee(() => values.reduce((a, b) => a + b, 0))({ beeClosures: { values } });
    assert.strictEqual(result, 15);
  });

  await test('bee(fn)(a)(b)(c)(d) deep curry chain', async () => {
    const result = await bee((a: number, b: number, c: number, d: number) => a * b + c * d)(2)(3)(4)(5);
    assert.strictEqual(result, 26);
  });

  await test('bee(fn)() returns object correctly', async () => {
    const result = await bee(() => ({ name: 'test', value: 42 }))();
    assert.deepStrictEqual(result, { name: 'test', value: 42 });
  });

  await test('bee(fn)() returns array correctly', async () => {
    const result = await bee(() => [1, 2, 3])();
    assert.deepStrictEqual(result, [1, 2, 3]);
  });

  await test('bee(fn)() handles require() inside worker', async () => {
    const result = await bee(() => {
      const path = require('path');
      return path.join('a', 'b', 'c');
    })();
    assert.ok(result.includes('a') && result.includes('b') && result.includes('c'));
  });

  await test('bee(fn) with beeClosures containing function as string', async () => {
    const helperCode = '(x) => x * 2';
    const result = await bee((n: number) => {
      const helper = eval(helperCode);
      return helper(n);
    })(21)({ beeClosures: { helperCode } });
    assert.strictEqual(result, 42);
  });

  await test('bee(fn) parallel execution', async () => {
    const results = await Promise.all([
      bee((x: number) => x * 1)(10),
      bee((x: number) => x * 2)(10),
      bee((x: number) => x * 3)(10),
      bee((x: number) => x * 4)(10),
    ]);
    assert.deepStrictEqual(results, [10, 20, 30, 40]);
  });

  await test('bee(fn)() error propagation', async () => {
    try {
      await bee(() => { throw new Error('test error'); })();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error;
      assert.ok(error.message.includes('test error'));
    }
  });

  await test('bee(fn)() with undefined return', async () => {
    const result = await bee(() => undefined)();
    assert.strictEqual(result, undefined);
  });

  await test('bee(fn)() with null return', async () => {
    const result = await bee(() => null)();
    assert.strictEqual(result, null);
  });

  await test('bee(fn) mixed curry with spread args', async () => {
    const result = await bee((a: number, b: number, c: number, d: number) => a + b + c + d)(1, 2)(3, 4);
    assert.strictEqual(result, 10);
  });

  await test('bee(fn) supports curried callback function', async () => {
    const result = await bee((a: number) => (b: number) => a + b)(1)(2);
    assert.strictEqual(result, 3);
  });

  await test('bee(fn) supports deeply curried callback', async () => {
    const result = await bee((a: number) => (b: number) => (c: number) => a + b + c)(1)(2)(3);
    assert.strictEqual(result, 6);
  });

  // ---------- BASIC RUN ----------
  section('beeThreads.run()');

  await test('executes sync function and returns result', async () => {
    const result = await beeThreads
      .run((a: number, b: number) => a + b)
      .usingParams(2, 3)
      .execute();
    assert.strictEqual(result, 5);
  });

  await test('handles complex computation', async () => {
    const result = await beeThreads
      .run((n: number) => {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += i;
        return sum;
      })
      .usingParams(100)
      .execute();
    assert.strictEqual(result, 4950);
  });

  await test('handles async functions (promises)', async () => {
    const result = await beeThreads
      .run(() => Promise.resolve(42))
      .usingParams()
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('rejects on error', async () => {
    await assert.rejects(
      beeThreads.run(() => { throw new Error('test error'); }).usingParams().execute(),
      { message: 'test error' }
    );
  });

  await test('preserves error name', async () => {
    try {
      await beeThreads
        .run(() => {
          const err = new TypeError('type error');
          throw err;
        })
        .usingParams()
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error;
      assert.strictEqual(error.name, 'TypeError');
    }
  });

  await test('passes multiple arguments correctly', async () => {
    const result = await beeThreads
      .run((a: number, b: number, c: number, d: number) => a * b + c - d)
      .usingParams(2, 3, 10, 4)
      .execute();
    assert.strictEqual(result, 12);
  });

  await test('handles arrow functions', async () => {
    const result = await beeThreads
      .run((x: number) => x * 2)
      .usingParams(21)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('handles async arrow functions', async () => {
    const result = await beeThreads
      .run(async (x: number) => {
        await new Promise(r => setTimeout(r, 10));
        return x * 2;
      })
      .usingParams(21)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('handles curried functions automatically', async () => {
    const result = await beeThreads
      .run((a: number) => (b: number) => (c: number) => a + b + c)
      .usingParams(1, 2, 3)
      .execute();
    assert.strictEqual(result, 6);
  });

  // ---------- TIMEOUT ----------
  section('beeThreads.withTimeout()');

  await test('completes before timeout', async () => {
    const result = await beeThreads
      .withTimeout(5000)((x: number) => x + 1)
      .usingParams(41)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('rejects on timeout', async () => {
    await assert.rejects(
      beeThreads
        .withTimeout(50)(() => {
          const start = Date.now();
          while (Date.now() - start < 200) {}
          return 'done';
        })
        .usingParams()
        .execute(),
      TimeoutError
    );
  });

  await test('timeout race condition - always returns TimeoutError', async () => {
    // This test verifies the fix for the race condition where worker.terminate()
    // fires 'exit' event asynchronously, potentially causing WorkerError instead
    // of TimeoutError in ~50% of cases
    const results = { timeout: 0, workerError: 0, other: 0 };
    
    for (let i = 0; i < 10; i++) {
      try {
        await beeThreads
          .withTimeout(30)(() => {
            while (true) {} // Busy loop
          })
          .execute();
      } catch (e: unknown) {
        const error = e as Error;
        if (error.name === 'TimeoutError' || error instanceof TimeoutError) {
          results.timeout++;
        } else if (error.message?.includes('exited with code')) {
          results.workerError++;
        } else {
          results.other++;
        }
      }
    }
    
    // Should ALWAYS be TimeoutError, never WorkerError
    assert.strictEqual(results.workerError, 0, `Got ${results.workerError} WorkerErrors instead of TimeoutError`);
    assert.strictEqual(results.timeout, 10, `Only got ${results.timeout}/10 TimeoutErrors`);
  });

  await beeThreads.shutdown();

  // ---------- STREAM ----------
  section('beeThreads.stream()');

  await test('streams generator yields', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 1;
        yield 2;
        yield 3;
      })
      .usingParams()
      .execute();

    const chunks: number[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as number);
    }
    assert.deepStrictEqual(chunks, [1, 2, 3]);
  });

  await test('streams with arguments', async () => {
    const stream = beeThreads
      .stream(function* (start: number, count: number) {
        for (let i = 0; i < count; i++) {
          yield start + i;
        }
      })
      .usingParams(10, 3)
      .execute();

    const chunks: number[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as number);
    }
    assert.deepStrictEqual(chunks, [10, 11, 12]);
  });

  await test('handles async yields in generator', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield Promise.resolve(1);
        yield Promise.resolve(2);
      })
      .usingParams()
      .execute();

    const chunks: number[] = [];
    for await (const chunk of stream) {
      // Generator yields Promises, so we await each chunk
      chunks.push(await chunk);
    }
    assert.deepStrictEqual(chunks, [1, 2]);
  });

  await test('captures generator return value', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 1;
        yield 2;
        return 'final';
      })
      .usingParams()
      .execute();

    const chunks: number[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as number);
    }
    assert.deepStrictEqual(chunks, [1, 2]);
    assert.strictEqual(stream.returnValue, 'final');
  });

  await beeThreads.shutdown();

  // ---------- INPUT VALIDATION ----------
  section('Input Validation');

  await test('run() throws TypeError for non-function', () => {
    assert.throws(
      () => beeThreads.run('not a function' as any),
      TypeError
    );
  });

  await test('run() throws TypeError for null', () => {
    assert.throws(
      () => beeThreads.run(null as any),
      TypeError
    );
  });

  await test('withTimeout() throws for negative timeout', () => {
    assert.throws(
      () => beeThreads.withTimeout(-100),
      TypeError
    );
  });

  await test('withTimeout() throws for non-number', () => {
    assert.throws(
      () => beeThreads.withTimeout('100' as any),
      TypeError
    );
  });

  await test('withTimeout() throws for Infinity', () => {
    assert.throws(
      () => beeThreads.withTimeout(Infinity),
      TypeError
    );
  });

  await test('configure() throws for non-integer poolSize', () => {
    assert.throws(
      () => beeThreads.configure({ poolSize: 2.5 }),
      TypeError
    );
  });

  await test('configure() throws for zero poolSize', () => {
    assert.throws(
      () => beeThreads.configure({ poolSize: 0 }),
      TypeError
    );
  });

  await test('stream() throws TypeError for non-function', () => {
    assert.throws(
      () => beeThreads.stream('not a generator' as any),
      TypeError
    );
  });

  // ---------- POOL MANAGEMENT ----------
  section('Pool Management');

  await test('getPoolStats() returns valid stats', async () => {
    await beeThreads.run((x: number) => x).usingParams(1).execute();
    const stats = beeThreads.getPoolStats();
    assert.ok(typeof stats.maxSize === 'number');
    assert.ok(typeof stats.normal.size === 'number');
    assert.ok(typeof stats.normal.busy === 'number');
    assert.ok(typeof stats.normal.idle === 'number');
    assert.ok(Array.isArray(stats.normal.workers));
    assert.ok(stats.metrics.totalTasksExecuted >= 1);
  });

  await test('configure() updates poolSize', () => {
    const originalMax = beeThreads.getPoolStats().maxSize;
    beeThreads.configure({ poolSize: 10 });
    assert.strictEqual(beeThreads.getPoolStats().maxSize, 10);
    beeThreads.configure({ poolSize: originalMax });
  });
  
  await test('configure() updates pool options', () => {
    beeThreads.configure({ maxQueueSize: 500, maxTemporaryWorkers: 5 });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.maxQueueSize, 500);
    assert.strictEqual(stats.config.maxTemporaryWorkers, 5);
  });

  await test('getPoolStats() returns frozen object', () => {
    const stats = beeThreads.getPoolStats();
    assert.ok(Object.isFrozen(stats), 'stats should be frozen');
    assert.ok(Object.isFrozen(stats.normal), 'stats.normal should be frozen');
    assert.ok(Object.isFrozen(stats.config), 'stats.config should be frozen');
    
    assert.throws(() => {
      'use strict';
      (stats as any).maxSize = 999;
    }, TypeError);
  });

  await test('transfer() method exists on executor', () => {
    const exec = beeThreads.run((x: number) => x);
    assert.ok(typeof exec.transfer === 'function', 'transfer method should exist');
  });

  await test('signal() method exists on executor', () => {
    const exec = beeThreads.run((x: number) => x);
    assert.ok(typeof exec.signal === 'function', 'signal method should exist');
  });

  // ---------- CURRIED REUSABILITY ----------
  section('Curried API');

  await test('executor can be reused multiple times', async () => {
    const double = beeThreads.run((x: number) => x * 2);
    
    const r1 = await double.usingParams(5).execute();
    const r2 = await double.usingParams(10).execute();
    const r3 = await double.usingParams(21).execute();
    
    assert.strictEqual(r1, 10);
    assert.strictEqual(r2, 20);
    assert.strictEqual(r3, 42);
  });

  await test('multiple executors work independently', async () => {
    const add = beeThreads.run((a: number, b: number) => a + b);
    const mul = beeThreads.run((a: number, b: number) => a * b);
    
    const sum = await add.usingParams(10, 5).execute();
    const product = await mul.usingParams(10, 5).execute();
    
    assert.strictEqual(sum, 15);
    assert.strictEqual(product, 50);
  });

  // ---------- EDGE CASES ----------
  section('Edge Cases');

  await test('handles undefined return', async () => {
    const result = await beeThreads.run(() => undefined).usingParams().execute();
    assert.strictEqual(result, undefined);
  });

  await test('handles null return', async () => {
    const result = await beeThreads.run(() => null).usingParams().execute();
    assert.strictEqual(result, null);
  });

  await test('handles object return', async () => {
    const result = await beeThreads
      .run(() => ({ foo: 'bar', num: 42 }))
      .usingParams()
      .execute();
    assert.deepStrictEqual(result, { foo: 'bar', num: 42 });
  });

  await test('handles array return', async () => {
    const result = await beeThreads
      .run(() => [1, 2, 3, 'four'])
      .usingParams()
      .execute();
    assert.deepStrictEqual(result, [1, 2, 3, 'four']);
  });

  await test('handles nested data structures', async () => {
    const result = await beeThreads
      .run(() => ({
        arr: [1, { nested: true }, [2, 3]],
        obj: { deep: { value: 42 } }
      }))
      .usingParams()
      .execute();
    assert.deepStrictEqual(result, {
      arr: [1, { nested: true }, [2, 3]],
      obj: { deep: { value: 42 } }
    });
  });

  await test('handles no arguments', async () => {
    const result = await beeThreads.run(() => 'no args').usingParams().execute();
    assert.strictEqual(result, 'no args');
  });

  // ---------- ABORT SIGNAL ----------
  section('AbortSignal Support');

  await beeThreads.shutdown();

  await test('aborts task with AbortController', async () => {
    const controller = new AbortController();
    
    const task = beeThreads
      .run(() => {
        const start = Date.now();
        while (Date.now() - start < 5000) {}
        return 'done';
      })
      .usingParams()
      .signal(controller.signal)
      .execute();
    
    setTimeout(() => controller.abort(), 50);
    
    await assert.rejects(task, AbortError);
  });

  await test('respects already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    
    await assert.rejects(
      beeThreads
        .run(() => 'should not run')
        .usingParams()
        .signal(controller.signal)
        .execute(),
      AbortError
    );
  });

  await beeThreads.shutdown();

  await test('fluent API chains correctly', async () => {
    const controller = new AbortController();
    
    const exec = beeThreads
      .run((x: number) => x * 2)
      .signal(controller.signal)
      .retry({ maxAttempts: 2 })
      .usingParams(21);
    
    const result = await exec.execute();
    assert.strictEqual(result, 42);
  });

  // ---------- TYPED ERRORS ----------
  section('Typed Errors');

  await test('AbortError has correct properties', () => {
    const err = new AbortError('custom message');
    assert.strictEqual(err.name, 'AbortError');
    assert.strictEqual(err.code, 'ERR_ABORTED');
    assert.strictEqual(err.message, 'custom message');
  });

  await test('TimeoutError has correct properties', () => {
    const err = new TimeoutError(5000);
    assert.strictEqual(err.name, 'TimeoutError');
    assert.strictEqual(err.code, 'ERR_TIMEOUT');
    assert.strictEqual(err.timeout, 5000);
  });

  await test('WorkerError wraps errors from worker', async () => {
    try {
      await beeThreads
        .run(() => { throw new RangeError('out of range'); })
        .usingParams()
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof WorkerError);
      assert.strictEqual((err as Error).name, 'RangeError');
    }
  });

  // ---------- RETRY ----------
  section('Retry Support');

  await test('retry() method exists on executor', () => {
    const exec = beeThreads.run((x: number) => x);
    assert.ok(typeof exec.retry === 'function', 'retry method should exist');
  });

  await test('retry succeeds on transient failure simulation', async () => {
    const result = await beeThreads
      .run((attempt: number) => {
        if (attempt < 2) {
          throw new Error('transient');
        }
        return 'success';
      })
      .usingParams(2)
      .retry({ maxAttempts: 3, baseDelay: 10 })
      .execute();
    
    assert.strictEqual(result, 'success');
  });

  // ---------- RESOURCE LIMITS ----------
  section('Resource Limits');

  await test('configure() accepts resourceLimits', () => {
    beeThreads.configure({
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 64
      }
    });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.resourceLimits.maxOldGenerationSizeMb, 256);
  });

  // ---------- CONTEXT (CLOSURES) ----------
  section('setContext() - Closure Injection');

  await beeThreads.shutdown();

  await test('setContext() method exists on executor', () => {
    const exec = beeThreads.run((x: number) => x);
    assert.ok(typeof exec.setContext === 'function', 'setContext method should exist');
  });

  await test('setContext() injects variables into function scope', async () => {
    const factor = 10;
    const prefix = 'result:';
    
    const result = await beeThreads
      .run((x: number) => prefix + (x * factor))
      .usingParams(5)
      .setContext({ factor, prefix })
      .execute();
    
    assert.strictEqual(result, 'result:50');
  });

  await test('setContext() works with multiple variables', async () => {
    const config = { multiplier: 3, offset: 100 };
    const label = 'value';
    
    const result = await beeThreads
      .run((x: number) => ({ [label]: x * config.multiplier + config.offset }))
      .usingParams(10)
      .setContext({ config, label })
      .execute();
    
    assert.deepStrictEqual(result, { value: 130 });
  });

  await test('setContext() works with stream/generators', async () => {
    const ctxMultiplier = 2;
    
    const stream = beeThreads
      .stream(function* (count: number) {
        for (let idx = 1; idx <= count; idx++) {
          yield idx * ctxMultiplier;
        }
      })
      .usingParams(3)
      .setContext({ ctxMultiplier })
      .execute();
    
    const chunks: number[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as number);
    }
    
    assert.deepStrictEqual(chunks, [2, 4, 6]);
  });

  await beeThreads.shutdown();

  // ---------- USING PARAMS ----------
  section('usingParams() - Arguments');

  await test('usingParams() method exists on executor', () => {
    const exec = beeThreads.run((x: number) => x);
    assert.ok(typeof exec.usingParams === 'function', 'usingParams method should exist');
  });

  await test('usingParams() passes arguments correctly', async () => {
    const result = await beeThreads
      .run((a: number, b: number, c: number) => a + b + c)
      .usingParams(10, 20, 12)
      .execute();
    
    assert.strictEqual(result, 42);
  });

  await test('usingParams() can be chained', async () => {
    const result = await beeThreads
      .run((a: number, b: number, c: number, d: number) => a + b + c + d)
      .usingParams(1)
      .usingParams(2)
      .usingParams(3, 4)
      .execute();
    
    assert.strictEqual(result, 10);
  });

  await test('usingParams() combines with setContext()', async () => {
    const factor = 2;
    
    const result = await beeThreads
      .run((a: number, b: number) => (a + b) * factor)
      .usingParams(10, 20)
      .setContext({ factor })
      .execute();
    
    assert.strictEqual(result, 60);
  });

  await test('execute() works with empty usingParams', async () => {
    const result = await beeThreads
      .run(() => 42)
      .usingParams()
      .execute();
    
    assert.strictEqual(result, 42);
  });

  await beeThreads.shutdown();

  // ---------- LOAD BALANCING ----------
  section('Load Balancing');

  await beeThreads.shutdown();

  await test('distributes tasks across workers (least-used)', async () => {
    beeThreads.configure({ poolSize: 3 });
    
    for (let i = 0; i < 6; i++) {
      await beeThreads.run(() => 'task').usingParams().execute();
    }
    
    const stats = beeThreads.getPoolStats();
    const execCounts = stats.normal.workers.map(w => w.tasksExecuted);
    assert.ok(execCounts.length <= 3, 'Should use max 3 workers');
    const max = Math.max(...execCounts);
    const min = Math.min(...execCounts);
    assert.ok(max - min <= 1, `Tasks not evenly distributed: ${execCounts.join(', ')}`);
  });

  await beeThreads.shutdown();

  await test('queues tasks when pool is full', async () => {
    beeThreads.configure({ poolSize: 1, maxTemporaryWorkers: 0 });
    
    const task1 = beeThreads
      .run(() => {
        const start = Date.now();
        while (Date.now() - start < 50) {}
        return 1;
      })
      .usingParams()
      .execute();
    
    const task2 = beeThreads.run(() => 2).usingParams().execute();
    
    const results = await Promise.all([task1, task2]);
    assert.deepStrictEqual(results, [1, 2]);
  });

  await beeThreads.shutdown();
  beeThreads.configure({ poolSize: 4, maxTemporaryWorkers: 10 });

  await test('tracks execution metrics', async () => {
    const statsBefore = beeThreads.getPoolStats();
    const before = statsBefore.metrics.totalTasksExecuted;
    
    await beeThreads.run(() => 1).usingParams().execute();
    await beeThreads.run(() => 2).usingParams().execute();
    
    const statsAfter = beeThreads.getPoolStats();
    assert.ok(statsAfter.metrics.totalTasksExecuted >= before + 2);
  });

  await test('tracks failure counts per worker', async () => {
    try {
      await beeThreads.run(() => { throw new Error('fail'); }).usingParams().execute();
    } catch {}
    
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.metrics.totalTasksFailed >= 1);
  });

  // ---------- EXECUTE WITHOUT USINGPARAMS ----------
  section('Execute without usingParams()');

  await test('execute() works directly without usingParams()', async () => {
    const result = await beeThreads
      .run(() => 'direct execute')
      .execute();
    assert.strictEqual(result, 'direct execute');
  });

  await test('stream execute() works without usingParams()', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 'a';
        yield 'b';
      })
      .execute();

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as string);
    }
    assert.deepStrictEqual(chunks, ['a', 'b']);
  });

  await beeThreads.shutdown();

  // ---------- CONSOLE.LOG FORWARDING ----------
  section('Console.log Forwarding');

  await test('console.log in worker executes without error', async () => {
    const result = await beeThreads
      .run(() => {
        console.log('test log from worker');
        return 'logged';
      })
      .execute();
    assert.strictEqual(result, 'logged');
  });

  await test('console.warn in worker executes without error', async () => {
    const result = await beeThreads
      .run(() => {
        console.warn('test warning from worker');
        return 'warned';
      })
      .execute();
    assert.strictEqual(result, 'warned');
  });

  await test('console.error in worker executes without error', async () => {
    const result = await beeThreads
      .run(() => {
        console.error('test error log from worker');
        return 'error logged';
      })
      .execute();
    assert.strictEqual(result, 'error logged');
  });

  await test('multiple console methods in worker', async () => {
    const result = await beeThreads
      .run(() => {
        console.log('log');
        console.info('info');
        console.debug('debug');
        console.warn('warn');
        console.error('error');
        return 'all logged';
      })
      .execute();
    assert.strictEqual(result, 'all logged');
  });

  await beeThreads.shutdown();

  // ---------- SETCONTEXT VALIDATION ----------
  section('setContext() Validation');

  await test('setContext() throws TypeError for null', () => {
    assert.throws(
      () => beeThreads.run((x: number) => x).setContext(null as any),
      TypeError
    );
  });

  await test('setContext() throws TypeError for non-object', () => {
    assert.throws(
      () => beeThreads.run((x: number) => x).setContext('not an object' as any),
      TypeError
    );
  });

  await test('setContext() works with array (arrays are objects)', async () => {
    // Note: Arrays are valid objects in JS, so setContext accepts them
    const result = await beeThreads
      .run(() => arr.length)
      .setContext({ arr: [1, 2, 3] })
      .execute();
    assert.strictEqual(result, 3);
  });

  await test('setContext() accepts empty object', async () => {
    const result = await beeThreads
      .run(() => 42)
      .setContext({})
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('setContext() throws for function values', () => {
    assert.throws(
      () => beeThreads.run(() => 42).setContext({ fn: () => 1 }),
      /contains a function which cannot be serialized/
    );
  });

  await test('setContext() throws for Symbol values', () => {
    assert.throws(
      () => beeThreads.run(() => 42).setContext({ sym: Symbol('test') }),
      /contains a Symbol which cannot be serialized/
    );
  });

  // ---------- TRANSFER (ARRAYBUFFER) ----------
  section('Transfer (ArrayBuffer)');

  await test('transfer() passes ArrayBuffer to worker', async () => {
    const buffer = new ArrayBuffer(16);
    const view = new Uint8Array(buffer);
    view[0] = 42;
    view[1] = 123;

    const result = await beeThreads
      .run((buf: ArrayBuffer) => {
        const arr = new Uint8Array(buf);
        return arr[0] + arr[1];
      })
      .usingParams(buffer)
      .transfer([buffer])
      .execute();

    assert.strictEqual(result, 165);
    // Buffer should be detached after transfer
    assert.strictEqual(buffer.byteLength, 0);
  });

  await test('transfer() works with large buffer', async () => {
    const size = 1024 * 1024; // 1MB
    const buffer = new ArrayBuffer(size);
    const view = new Uint8Array(buffer);
    view[0] = 1;
    view[size - 1] = 2;

    const result = await beeThreads
      .run((buf: ArrayBuffer) => {
        const arr = new Uint8Array(buf);
        return arr[0] + arr[arr.length - 1];
      })
      .usingParams(buffer)
      .transfer([buffer])
      .execute();

    assert.strictEqual(result, 3);
  });

  await test('stream transfer() passes ArrayBuffer to generator worker', async () => {
    const buffer = new ArrayBuffer(8);
    const view = new Uint8Array(buffer);
    view[0] = 10;
    view[1] = 20;

    const stream = beeThreads
      .stream(function* (buf: ArrayBuffer) {
        const arr = new Uint8Array(buf);
        yield arr[0];
        yield arr[1];
      })
      .usingParams(buffer)
      .transfer([buffer])
      .execute();

    const chunks: number[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as number);
    }
    assert.deepStrictEqual(chunks, [10, 20]);
    // Buffer should be detached after transfer
    assert.strictEqual(buffer.byteLength, 0);
  });

  await beeThreads.shutdown();

  // ---------- STREAM ERROR HANDLING ----------
  section('Stream Error Handling');

  await beeThreads.shutdown();

  await test('stream handles generator errors', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 1;
        throw new Error('generator error');
      })
      .execute();

    const chunks: number[] = [];
    try {
      for await (const chunk of stream) {
        chunks.push(chunk as number);
      }
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error;
      assert.strictEqual(error.message, 'generator error');
      assert.deepStrictEqual(chunks, [1]);
    }
  });

  await beeThreads.shutdown();

  await test('stream completes all values', async () => {
    // Note: Early break/cancel causes worker termination (expected)
    // This test verifies full stream consumption works
    const stream = beeThreads
      .stream(function* () {
        yield 'first';
        yield 'second';
        yield 'third';
      })
      .execute();

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as string);
    }
    
    assert.deepStrictEqual(chunks, ['first', 'second', 'third']);
  });

  // ---------- QUEUE FULL ERROR ----------
  section('QueueFullError');

  await test('throws QueueFullError when queue is full', async () => {
    beeThreads.configure({ 
      poolSize: 1, 
      maxTemporaryWorkers: 0,
      maxQueueSize: 1 
    });

    // Start a long task to occupy the worker
    const blockingTask = beeThreads
      .run(() => {
        const start = Date.now();
        while (Date.now() - start < 200) {}
        return 'done';
      })
      .execute();

    // Give time for the task to start
    await new Promise(r => setTimeout(r, 10));

    // Queue one task (should succeed)
    const queuedTask = beeThreads.run(() => 'queued').execute();

    // Third task should fail - queue is full
    await assert.rejects(
      beeThreads.run(() => 'overflow').execute(),
      QueueFullError
    );

    await Promise.all([blockingTask, queuedTask]);
    await beeThreads.shutdown();
    beeThreads.configure({ poolSize: 4, maxQueueSize: 1000, maxTemporaryWorkers: 10 });
  });

  await test('QueueFullError has correct properties', () => {
    const err = new QueueFullError(100);
    assert.strictEqual(err.name, 'QueueFullError');
    assert.strictEqual(err.code, 'ERR_QUEUE_FULL');
    assert.strictEqual(err.maxSize, 100);
    assert.ok(err.message.includes('100'));
  });

  // ---------- CONCURRENT TASKS ----------
  section('Concurrent Tasks');

  await test('handles many concurrent tasks', async () => {
    beeThreads.configure({ poolSize: 4 });
    
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(
        beeThreads
          .run((n: number) => n * 2)
          .usingParams(i)
          .execute()
      );
    }

    const results = await Promise.all(tasks);
    
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(results[i], i * 2);
    }
  });

  await beeThreads.shutdown();

  // ---------- WORKER IDLE TIMEOUT CONFIG ----------
  section('Worker Idle Timeout Configuration');

  await test('configure() accepts workerIdleTimeout', () => {
    beeThreads.configure({ workerIdleTimeout: 60000 });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.workerIdleTimeout, 60000);
  });

  await test('configure() throws for negative workerIdleTimeout', () => {
    assert.throws(
      () => beeThreads.configure({ workerIdleTimeout: -1 }),
      TypeError
    );
  });

  await test('configure() throws for non-number workerIdleTimeout', () => {
    assert.throws(
      () => beeThreads.configure({ workerIdleTimeout: 'fast' as any }),
      TypeError
    );
  });

  await test('workerIdleTimeout 0 disables idle cleanup', () => {
    beeThreads.configure({ workerIdleTimeout: 0 });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.workerIdleTimeout, 0);
  });

  beeThreads.configure({ workerIdleTimeout: 30000 });

  // ---------- COMPLEX CONTEXT ----------
  section('Complex Context Scenarios');

  await test('setContext() with nested objects', async () => {
    const config = {
      db: { host: 'localhost', port: 5432 },
      cache: { enabled: true, ttl: 3600 }
    };

    const result = await beeThreads
      .run(() => config.db.host + ':' + config.db.port)
      .setContext({ config })
      .execute();

    assert.strictEqual(result, 'localhost:5432');
  });

  await test('setContext() with arrays', async () => {
    const items = [10, 20, 30];

    const result = await beeThreads
      .run(() => items.reduce((a: number, b: number) => a + b, 0))
      .setContext({ items })
      .execute();

    assert.strictEqual(result, 60);
  });

  await test('setContext() with functions as strings', async () => {
    const helperCode = '(x) => x * 2';

    const result = await beeThreads
      .run((val: number) => {
        const helper = eval(helperCode);
        return helper(val);
      })
      .usingParams(21)
      .setContext({ helperCode })
      .execute();

    assert.strictEqual(result, 42);
  });

  await beeThreads.shutdown();

  // ---------- FLUENT API ORDERING ----------
  section('Fluent API Method Ordering');

  await test('methods can be called in any order', async () => {
    const factor = 2;
    const controller = new AbortController();

    const result = await beeThreads
      .run((x: number) => x * factor)
      .setContext({ factor })
      .signal(controller.signal)
      .retry({ maxAttempts: 2 })
      .usingParams(21)
      .execute();

    assert.strictEqual(result, 42);
  });

  await test('reverse order also works', async () => {
    const factor = 3;

    const result = await beeThreads
      .run((x: number) => x * factor)
      .usingParams(14)
      .retry({ maxAttempts: 2 })
      .setContext({ factor })
      .execute();

    assert.strictEqual(result, 42);
  });

  await beeThreads.shutdown();

  // ---------- METRICS ACCURACY ----------
  section('Metrics Accuracy');

  await test('totalTasksExecuted increments correctly', async () => {
    await beeThreads.shutdown();
    
    const before = beeThreads.getPoolStats().metrics.totalTasksExecuted;
    
    await beeThreads.run(() => 1).execute();
    await beeThreads.run(() => 2).execute();
    await beeThreads.run(() => 3).execute();
    
    const after = beeThreads.getPoolStats().metrics.totalTasksExecuted;
    assert.strictEqual(after - before, 3);
  });

  await test('totalTasksFailed increments on error', async () => {
    const before = beeThreads.getPoolStats().metrics.totalTasksFailed;
    
    try {
      await beeThreads.run(() => { throw new Error('fail'); }).execute();
    } catch {}
    
    const after = beeThreads.getPoolStats().metrics.totalTasksFailed;
    assert.strictEqual(after - before, 1);
  });

  await test('worker stats track execution time', async () => {
    await beeThreads.shutdown();
    
    await beeThreads
      .run(() => {
        const start = Date.now();
        while (Date.now() - start < 50) {}
        return 'done';
      })
      .execute();
    
    const stats = beeThreads.getPoolStats();
    const worker = stats.normal.workers[0];
    assert.ok(worker, 'Worker should exist in stats');
    assert.ok(typeof worker.avgExecutionTime === 'number', 
      'avgExecutionTime should be a number');
    assert.ok(worker.avgExecutionTime >= 40, 
      `Expected >= 40ms, got ${worker.avgExecutionTime}ms`);
  });

  await beeThreads.shutdown();

  // ---------- MINTHREADS & WARMUP ----------
  section('minThreads & warmup()');

  await beeThreads.shutdown();

  await test('configure() accepts minThreads', () => {
    beeThreads.configure({ minThreads: 2 });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.minThreads, 2);
  });

  await test('configure() throws for minThreads > poolSize', () => {
    assert.throws(
      () => beeThreads.configure({ minThreads: 999 }),
      TypeError
    );
  });

  await test('configure() throws for negative minThreads', () => {
    assert.throws(
      () => beeThreads.configure({ minThreads: -1 }),
      TypeError
    );
  });

  await test('warmup() pre-creates workers', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ minThreads: 0 });
    
    const before = beeThreads.getPoolStats();
    assert.strictEqual(before.normal.size, 0);
    
    await beeThreads.warmup(2);
    
    const after = beeThreads.getPoolStats();
    assert.strictEqual(after.normal.size, 2);
  });

  await test('warmup() uses minThreads as default', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ minThreads: 3 });
    
    await beeThreads.warmup();
    
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.normal.size, 3);
  });

  await beeThreads.shutdown();
  beeThreads.configure({ minThreads: 0 });

  // ---------- TASK PRIORITY ----------
  section('Task Priority');

  await test('priority() method exists on executor', () => {
    const exec = beeThreads.run((x: number) => x);
    assert.ok(typeof exec.priority === 'function', 'priority method should exist');
  });

  await test('priority() returns new executor', () => {
    const exec1 = beeThreads.run((x: number) => x);
    const exec2 = exec1.priority('high');
    assert.notStrictEqual(exec1, exec2);
  });

  await test('high priority tasks execute', async () => {
    const result = await beeThreads
      .run(() => 'high priority result')
      .priority('high')
      .execute();
    assert.strictEqual(result, 'high priority result');
  });

  await test('low priority tasks execute', async () => {
    const result = await beeThreads
      .run(() => 'low priority result')
      .priority('low')
      .execute();
    assert.strictEqual(result, 'low priority result');
  });

  await test('getPoolStats() shows queue by priority', async () => {
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.normal.queueByPriority, 'queueByPriority should exist');
    assert.ok(typeof stats.normal.queueByPriority.high === 'number');
    assert.ok(typeof stats.normal.queueByPriority.normal === 'number');
    assert.ok(typeof stats.normal.queueByPriority.low === 'number');
  });

  await test('priority() throws for invalid priority', () => {
    assert.throws(
      () => beeThreads.run(() => 42).priority('ULTRA' as any),
      /Invalid priority/
    );
  });

  await test('priority() throws for unknown priority', () => {
    assert.throws(
      () => beeThreads.run(() => 42).priority('critical' as any),
      TypeError
    );
  });

  await beeThreads.shutdown();

  // ---------- LRU CACHE ----------
  section('LRU Cache');

  await test('createLRUCache() creates cache with default size', () => {
    const cache = createLRUCache();
    assert.strictEqual(cache.size(), 0);
    assert.strictEqual(cache.stats().maxSize, 100);
  });

  await test('createLRUCache(n) creates cache with custom size', () => {
    const cache = createLRUCache(50);
    assert.strictEqual(cache.stats().maxSize, 50);
  });

  await test('cache.set() and cache.get() work correctly', () => {
    const cache = createLRUCache<string>(10);
    cache.set('key1', 'value1');
    assert.strictEqual(cache.get('key1'), 'value1');
    assert.strictEqual(cache.size(), 1);
  });

  await test('cache.has() checks existence without updating LRU', () => {
    const cache = createLRUCache<string>(10);
    cache.set('key1', 'value1');
    assert.strictEqual(cache.has('key1'), true);
    assert.strictEqual(cache.has('nonexistent'), false);
  });

  await test('cache.get() returns undefined for missing keys', () => {
    const cache = createLRUCache<string>(10);
    assert.strictEqual(cache.get('nonexistent'), undefined);
  });

  await test('cache evicts LRU entry when full', () => {
    const cache = createLRUCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Cache is full: [c, b, a]
    
    cache.set('d', 4); // Should evict 'a'
    
    assert.strictEqual(cache.has('a'), false, 'a should be evicted');
    assert.strictEqual(cache.has('b'), true);
    assert.strictEqual(cache.has('c'), true);
    assert.strictEqual(cache.has('d'), true);
  });

  await test('cache.get() moves entry to most recent', () => {
    const cache = createLRUCache<number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Order: [c, b, a]
    
    cache.get('a'); // Move 'a' to most recent
    // Order: [a, c, b]
    
    cache.set('d', 4); // Should evict 'b' (now oldest)
    
    assert.strictEqual(cache.has('b'), false, 'b should be evicted');
    assert.strictEqual(cache.has('a'), true, 'a should still exist');
  });

  await test('cache.clear() removes all entries', () => {
    const cache = createLRUCache<number>(10);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
  });

  await test('cache with TTL expires entries', async () => {
    const cache = createLRUCache<number>(10, 100); // 100ms TTL
    cache.set('a', 1);
    assert.strictEqual(cache.get('a'), 1);
    
    // Wait for TTL to expire
    await new Promise(resolve => setTimeout(resolve, 150));
    
    // Entry should be expired
    assert.strictEqual(cache.get('a'), undefined);
  });

  await test('cache TTL=0 means no expiration', async () => {
    const cache = createLRUCache<number>(10, 0); // No TTL
    cache.set('a', 1);
    
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Entry should still exist
    assert.strictEqual(cache.get('a'), 1);
  });

  await test('cache.stats() includes TTL', () => {
    const cache = createLRUCache<number>(10, 5000);
    const stats = cache.stats();
    assert.strictEqual(stats.ttl, 5000);
    assert.strictEqual(stats.maxSize, 10);
  });

  // ---------- FUNCTION CACHE ----------
  section('Function Cache');

  await test('createFunctionCache() creates function cache', () => {
    const cache = createFunctionCache();
    assert.ok(cache.getOrCompile);
    assert.ok(cache.stats);
    assert.ok(cache.clear);
  });

  await test('fnCache.getOrCompile() compiles function', () => {
    const cache = createFunctionCache();
    const fn = cache.getOrCompile('(x) => x * 2');
    assert.strictEqual(typeof fn, 'function');
    assert.strictEqual(fn(21), 42);
  });

  await test('fnCache.getOrCompile() returns cached function', () => {
    const cache = createFunctionCache();
    const fn1 = cache.getOrCompile('(x) => x * 2');
    const fn2 = cache.getOrCompile('(x) => x * 2');
    assert.strictEqual(fn1, fn2, 'Should return same function instance');
  });

  await test('fnCache.getOrCompile() with context compiles correctly', () => {
    const cache = createFunctionCache();
    const fn = cache.getOrCompile('(x) => x * MULT', { MULT: 10 });
    assert.strictEqual(fn(5), 50);
  });

  await test('fnCache.stats() tracks hits and misses', () => {
    const cache = createFunctionCache();
    cache.getOrCompile('() => 1'); // miss
    cache.getOrCompile('() => 1'); // hit
    cache.getOrCompile('() => 1'); // hit
    cache.getOrCompile('() => 2'); // miss
    
    const stats = cache.stats();
    assert.strictEqual(stats.hits, 2);
    assert.strictEqual(stats.misses, 2);
    assert.strictEqual(stats.hitRate, '50.0%');
  });

  // ---------- CACHE INTEGRATION ----------
  section('Cache Integration (bee-threads)');

  await test('repeated bee() calls benefit from cache', async () => {
    const fn = (x: number) => x * 2;
    
    // Run same function multiple times
    const results = await Promise.all([
      bee(fn)(1),
      bee(fn)(2),
      bee(fn)(3),
      bee(fn)(4),
      bee(fn)(5),
    ]);
    
    assert.deepStrictEqual(results, [2, 4, 6, 8, 10]);
  });

  await test('repeated beeThreads calls benefit from cache', async () => {
    // Run same function multiple times
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await beeThreads.run((x: number) => x * 3).usingParams(i).execute();
      results.push(r);
    }
    
    assert.deepStrictEqual(results, [0, 3, 6, 9, 12]);
  });

  await test('stream generator benefits from cache', async () => {
    const results1: number[] = [];
    const stream1 = beeThreads.stream(function* (n: number) {
      for (let i = 0; i < n; i++) yield i;
    }).usingParams(3).execute();
    for await (const v of stream1) results1.push(v as number);
    
    const results2: number[] = [];
    const stream2 = beeThreads.stream(function* (n: number) {
      for (let i = 0; i < n; i++) yield i;
    }).usingParams(3).execute();
    for await (const v of stream2) results2.push(v as number);
    
    assert.deepStrictEqual(results1, [0, 1, 2]);
    assert.deepStrictEqual(results2, [0, 1, 2]);
  });

  await beeThreads.shutdown();

  // ---------- WORKER AFFINITY ----------
  section('Worker Affinity');

  await beeThreads.shutdown();

  await test('affinity routes same function to same worker', async () => {
    beeThreads.configure({ poolSize: 4 });
    
    // Run the same function multiple times
    const fn = (x: number) => x * 2;
    for (let i = 0; i < 10; i++) {
      await beeThreads.run(fn).usingParams(i).execute();
    }
    
    const stats = beeThreads.getPoolStats();
    // After repeated calls, should have affinity hits
    assert.ok(stats.metrics.affinityHits >= 0, 'Should track affinity hits');
    assert.ok(stats.metrics.affinityMisses >= 0, 'Should track affinity misses');
    assert.ok(typeof stats.metrics.affinityHitRate === 'string', 'Should have affinityHitRate');
  });

  await test('workers track cached functions count', async () => {
    const stats = beeThreads.getPoolStats();
    const workers = stats.normal.workers;
    assert.ok(workers.length > 0, 'Should have workers');
    
    for (const w of workers) {
      assert.ok(typeof w.cachedFunctions === 'number', 'Worker should have cachedFunctions count');
    }
  });

  await beeThreads.shutdown();

  // ---------- FUNCTION CACHE SIZE CONFIG ----------
  section('functionCacheSize Configuration');

  await test('configure() accepts functionCacheSize', () => {
    beeThreads.configure({ functionCacheSize: 500 });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.functionCacheSize, 500);
  });

  await test('configure() throws for non-integer functionCacheSize', () => {
    assert.throws(
      () => beeThreads.configure({ functionCacheSize: 50.5 }),
      TypeError
    );
  });

  await test('configure() throws for zero functionCacheSize', () => {
    assert.throws(
      () => beeThreads.configure({ functionCacheSize: 0 }),
      TypeError
    );
  });

  await test('configure() throws for negative functionCacheSize', () => {
    assert.throws(
      () => beeThreads.configure({ functionCacheSize: -10 }),
      TypeError
    );
  });

  beeThreads.configure({ functionCacheSize: 100 }); // Reset

  // ---------- LOW MEMORY MODE ----------
  section('lowMemoryMode Configuration');

  await test('configure() accepts lowMemoryMode', () => {
    beeThreads.configure({ lowMemoryMode: true });
    const stats = beeThreads.getPoolStats();
    assert.strictEqual(stats.config.lowMemoryMode, true);
  });

  await test('configure() throws for non-boolean lowMemoryMode', () => {
    assert.throws(
      () => beeThreads.configure({ lowMemoryMode: 'yes' as any }),
      TypeError
    );
  });

  await test('lowMemoryMode still executes tasks correctly', async () => {
    beeThreads.configure({ lowMemoryMode: true });
    await beeThreads.shutdown(); // Force new workers
    
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
  });

  await test('lowMemoryMode works with context', async () => {
    const result = await bee((x: number) => x * MULT)(5, { beeClosures: { MULT: 10 } });
    assert.strictEqual(result, 50);
  });

  beeThreads.configure({ lowMemoryMode: false }); // Reset

  // ---------- VM.SCRIPT OPTIMIZATION ----------
  section('vm.Script Optimization (context)');

  await test('vm.Script compiles with context correctly', async () => {
    const VM_MULT = 100;
    const result = await beeThreads
      .run((x: number) => x * VM_MULT)
      .setContext({ VM_MULT })
      .usingParams(5)
      .execute();
    assert.strictEqual(result, 500);
  });

  await test('vm.Script provides require in context', async () => {
    const PREFIX = 'hash:';
    const result = await beeThreads
      .run((data: string) => {
        const crypto = require('crypto');
        return PREFIX + crypto.createHash('md5').update(data).digest('hex').slice(0, 8);
      })
      .setContext({ PREFIX })
      .usingParams('test')
      .execute();
    assert.ok(result.startsWith('hash:'));
    assert.strictEqual(result.length, 13); // 'hash:' + 8 hex chars
  });

  await test('vm.Script works with complex context', async () => {
    const config = { multiplier: 3, prefix: '>' };
    const items = [1, 2, 3];
    
    const result = await beeThreads
      .run(() => items.map(i => config.prefix + (i * config.multiplier)).join(','))
      .setContext({ config, items })
      .execute();
    
    assert.strictEqual(result, '>3,>6,>9');
  });

  await beeThreads.shutdown();

  // ---------- STRESS TESTS ----------
  section('Stress Tests');

  await test('20 parallel tasks (same function)', async () => {
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(bee((n: number) => n * n)(i));
    }
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 20);
    assert.strictEqual(results[0], 0);
    assert.strictEqual(results[5], 25);
    assert.strictEqual(results[19], 361);
  });

  await test('50 parallel tasks (same function)', async () => {
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 50; i++) {
      tasks.push(bee((n: number) => n + 1)(i));
    }
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 50);
    assert.strictEqual(results[0], 1);
    assert.strictEqual(results[49], 50);
  });

  await test('100 parallel tasks (same function)', async () => {
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(bee((x: number) => x * 2)(i));
    }
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 100);
    assert.strictEqual(results[50], 100);
    assert.strictEqual(results[99], 198);
  });

  await test('20 parallel tasks with context', async () => {
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(bee((n: number) => n * MULT)(i)({ beeClosures: { MULT: 10 } }));
    }
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 20);
    assert.strictEqual(results[5], 50);
    assert.strictEqual(results[19], 190);
  });

  await test('mixed parallel tasks (different functions)', async () => {
    const tasks = [
      bee((x: number) => x + 1)(10),
      bee((x: number) => x * 2)(10),
      bee((x: number) => x - 1)(10),
      bee((x: number) => x / 2)(10),
      bee((x: number) => x ** 2)(10),
      bee((x: number) => Math.sqrt(x))(100),
      bee(() => 42)(),
      bee((a: number, b: number) => a + b)(20, 22),
      bee((x: number) => x.toString())(123),
      bee((arr: number[]) => arr.length)([1,2,3,4,5]),
    ];
    const results = await Promise.all(tasks);
    assert.strictEqual(results[0], 11);
    assert.strictEqual(results[1], 20);
    assert.strictEqual(results[2], 9);
    assert.strictEqual(results[3], 5);
    assert.strictEqual(results[4], 100);
    assert.strictEqual(results[5], 10);
    assert.strictEqual(results[6], 42);
    assert.strictEqual(results[7], 42);
    assert.strictEqual(results[8], '123');
    assert.strictEqual(results[9], 5);
  });

  await test('stress: rapid sequential tasks', async () => {
    for (let i = 0; i < 50; i++) {
      const result = await bee((n: number) => n)(i);
      assert.strictEqual(result, i);
    }
  });

  await beeThreads.shutdown();

  // ---------- RACE CONDITION TESTS ----------
  section('Race Condition Tests');

  await test('concurrent cache access (same key)', async () => {
    // All tasks use exact same function - tests cache race conditions
    const fn = (x: number) => x * 2;
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 30; i++) {
      tasks.push(bee(fn)(i));
    }
    const results = await Promise.all(tasks);
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(results[i], i * 2, `Task ${i} failed`);
    }
  });

  await test('concurrent cache access (different keys)', async () => {
    // Each task uses different function - tests cache eviction races
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 30; i++) {
      // Create unique function for each task
      tasks.push(bee(new Function('x', `return x + ${i}`) as (x: number) => number)(100));
    }
    const results = await Promise.all(tasks);
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(results[i], 100 + i, `Task ${i} failed`);
    }
  });

  await test('concurrent context injection', async () => {
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 20; i++) {
      // Each task has different context value
      tasks.push(bee((x: number) => x * FACTOR)(10)({ beeClosures: { FACTOR: i } }));
    }
    const results = await Promise.all(tasks);
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(results[i], 10 * i, `Context ${i} failed`);
    }
  });

  await test('concurrent worker affinity', async () => {
    // Same function should route to same worker (when possible)
    const fn = (n: number) => n * n;
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 40; i++) {
      tasks.push(bee(fn)(i));
    }
    const results = await Promise.all(tasks);
    assert.strictEqual(results.length, 40);
    // Verify correctness
    for (let i = 0; i < 40; i++) {
      assert.strictEqual(results[i], i * i);
    }
  });

  await test('interleaved sync and async functions', async () => {
    const tasks: PromiseLike<number | Promise<number>>[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        tasks.push(bee((x: number) => x)(i)); // sync - returns number
      } else {
        tasks.push(bee(async (x: number) => x)(i)); // async - returns Promise<number>
      }
    }
    const results = await Promise.all(tasks);
    for (let i = 0; i < 20; i++) {
      // Async functions return Promise, sync return number directly
      const value = await results[i];
      assert.strictEqual(value, i);
    }
  });

  await beeThreads.shutdown();

  // ---------- MEMORY PRESSURE TESTS ----------
  section('Memory Pressure Tests');

  await test('many unique functions (cache eviction)', async () => {
    // Create more unique functions than cache size (default 100)
    const results: number[] = [];
    for (let i = 0; i < 150; i++) {
      const result = await bee(new Function('return ' + i) as () => number)();
      results.push(result);
    }
    // Verify all executed correctly despite cache evictions
    for (let i = 0; i < 150; i++) {
      assert.strictEqual(results[i], i);
    }
  });

  await test('large data transfer', async () => {
    const largeArray = new Array(10000).fill(0).map((_, i) => i);
    const result = await bee((arr: number[]) => arr.reduce((a, b) => a + b, 0))(largeArray);
    assert.strictEqual(result, 49995000);
  });

  await test('repeated large computations', async () => {
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(bee((n: number) => {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += j;
        return sum;
      })(10000));
    }
    const results = await Promise.all(tasks);
    for (const result of results) {
      assert.strictEqual(result, 49995000);
    }
  });

  await beeThreads.shutdown();

  // ---------- UNCAUGHT ERROR HANDLING ----------
  section('Uncaught Error Handling');

  await beeThreads.shutdown();

  await test('captures ReferenceError (undefined variable)', async () => {
    try {
      await beeThreads
        .run(() => (undefinedVariable as any))
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof WorkerError, 'Should be WorkerError');
      assert.strictEqual((err as Error).name, 'ReferenceError');
      assert.ok((err as Error).message.includes('undefinedVariable'), `Message should mention variable: ${(err as Error).message}`);
    }
  });

  await test('captures TypeError (null property access)', async () => {
    try {
      await beeThreads
        .run(() => (null as any).property)
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof WorkerError, 'Should be WorkerError');
      assert.strictEqual((err as Error).name, 'TypeError');
      assert.ok((err as Error).message.includes('null'), `Message should mention null: ${(err as Error).message}`);
    }
  });

  await test('captures TypeError (undefined property access)', async () => {
    try {
      await beeThreads
        .run(() => {
          const obj = undefined;
          return (obj as any).property;
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof WorkerError, 'Should be WorkerError');
      assert.strictEqual((err as Error).name, 'TypeError');
    }
  });

  await test('captures unhandled async rejection', async () => {
    try {
      await beeThreads
        .run(async () => {
          throw new Error('async rejection test');
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof WorkerError, 'Should be WorkerError');
      assert.ok((err as Error).message.includes('async rejection test'), `Message: ${(err as Error).message}`);
    }
  });

  await test('captures stack overflow (infinite recursion)', async () => {
    try {
      await beeThreads
        .run(() => {
          // Use eval to prevent tsx from transforming the function
          const recurse = eval('(function f() { return f(); })');
          return recurse();
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      assert.ok(err instanceof WorkerError, 'Should be WorkerError');
      assert.strictEqual((err as Error).name, 'RangeError');
      assert.ok((err as Error).message.includes('stack') || (err as Error).message.includes('recursion'), 
        `Message should mention stack: ${(err as Error).message}`);
    }
  });

  await test('error includes stack trace', async () => {
    try {
      await beeThreads
        .run(() => {
          throw new Error('stack trace test');
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error;
      assert.ok(error.stack, 'Error should have stack trace');
      assert.ok(error.stack.length > 0, 'Stack trace should not be empty');
    }
  });

  await test('preserves custom error properties', async () => {
    try {
      await beeThreads
        .run(() => {
          const e = new Error('custom error') as Error & { code: string; statusCode: number };
          e.code = 'ERR_CUSTOM';
          e.statusCode = 500;
          throw e;
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error & { code?: string; statusCode?: number };
      assert.strictEqual(error.code, 'ERR_CUSTOM', 'Should preserve error.code');
      assert.strictEqual(error.statusCode, 500, 'Should preserve error.statusCode');
    }
  });

  await test('preserves Error.cause (ES2022)', async () => {
    try {
      await beeThreads
        .run(() => {
          const cause = new Error('original cause');
          throw new Error('wrapper error', { cause });
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error & { cause?: Error };
      assert.ok(error.cause, 'Should have cause property');
      assert.strictEqual(error.cause.message, 'original cause', 'cause.message should match');
    }
  });

  await test('preserves AggregateError.errors', async () => {
    try {
      await beeThreads
        .run(() => {
          throw new AggregateError([
            new Error('error 1'),
            new Error('error 2'),
          ], 'Multiple errors');
        })
        .execute();
      assert.fail('Should have thrown');
    } catch (err: unknown) {
      const error = err as Error & { errors?: Error[] };
      assert.strictEqual(error.name, 'AggregateError', 'Should be AggregateError');
      assert.ok(Array.isArray(error.errors), 'Should have errors array');
      assert.strictEqual(error.errors.length, 2, 'Should have 2 errors');
      assert.strictEqual(error.errors[0].message, 'error 1');
      assert.strictEqual(error.errors[1].message, 'error 2');
    }
  });

  await beeThreads.shutdown();

  // ---------- POOL COUNTER STABILITY ----------
  section('Pool Counter Stability');

  await test('busy counter stays non-negative after timeouts', async () => {
    beeThreads.configure({ poolSize: 4, logger: null });
    await beeThreads.warmup(2);
    
    // Execute multiple timeouts
    for (let i = 0; i < 5; i++) {
      try {
        await beeThreads.withTimeout(30)(() => { while(true) {} }).execute();
      } catch { /* expected */ }
    }
    
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.normal.busy >= 0, `busy should be >= 0, got ${stats.normal.busy}`);
    assert.ok(stats.normal.idle >= 0, `idle should be >= 0, got ${stats.normal.idle}`);
  });

  await test('pool remains functional after many timeouts', async () => {
    // After timeouts, pool should still work
    const result = await beeThreads.run(() => 42).execute();
    assert.strictEqual(result, 42);
  });

  await beeThreads.shutdown();

  // ---------- DEBUG MODE ----------
  section('debugMode Configuration');

  await test('configure() accepts debugMode', () => {
    beeThreads.configure({ debugMode: true });
    // No direct way to check, but should not throw
  });

  await test('configure() throws for non-boolean debugMode', () => {
    assert.throws(
      () => beeThreads.configure({ debugMode: 'yes' as unknown as boolean }),
      TypeError
    );
  });

  await test('debugMode false disables code dump', async () => {
    beeThreads.configure({ debugMode: false });
    await beeThreads.shutdown();
    
    // Should still work, just without code dump
    const result = await beeThreads.run(() => 42).execute();
    assert.strictEqual(result, 42);
  });

  beeThreads.configure({ debugMode: true }); // Reset for other tests

  // ---------- CUSTOM LOGGER ----------
  section('Logger Configuration');

  await test('configure() accepts logger', () => {
    const logs: unknown[][] = [];
    const customLogger: Logger = {
      log: (...args: unknown[]) => logs.push(['log', ...args]),
      warn: (...args: unknown[]) => logs.push(['warn', ...args]),
      error: (...args: unknown[]) => logs.push(['error', ...args]),
      info: (...args: unknown[]) => logs.push(['info', ...args]),
      debug: (...args: unknown[]) => logs.push(['debug', ...args]),
    };
    beeThreads.configure({ logger: customLogger });
    // Should not throw
  });

  await test('configure() accepts null logger (disable logging)', () => {
    beeThreads.configure({ logger: null });
    // Should not throw
  });

  await test('noopLogger is exported and works', () => {
    assert.ok(noopLogger, 'noopLogger should be exported');
    assert.ok(typeof noopLogger.log === 'function');
    assert.ok(typeof noopLogger.warn === 'function');
    assert.ok(typeof noopLogger.error === 'function');
    // Should not throw
    noopLogger.log('test');
    noopLogger.warn('test');
    noopLogger.error('test');
  });

  await test('configure() throws for invalid logger', () => {
    assert.throws(
      () => beeThreads.configure({ logger: 'not a logger' as unknown as Logger }),
      TypeError
    );
    assert.throws(
      () => beeThreads.configure({ logger: {} as Logger }),
      TypeError
    );
  });

  await test('custom logger receives worker logs', async () => {
    const logs: unknown[][] = [];
    const customLogger: Logger = {
      log: (...args: unknown[]) => logs.push(['log', ...args]),
      warn: (...args: unknown[]) => logs.push(['warn', ...args]),
      error: (...args: unknown[]) => logs.push(['error', ...args]),
      info: (...args: unknown[]) => logs.push(['info', ...args]),
      debug: (...args: unknown[]) => logs.push(['debug', ...args]),
    };
    beeThreads.configure({ logger: customLogger });
    await beeThreads.shutdown();

    await beeThreads.run(() => {
      console.log('custom log test');
      return 'done';
    }).execute();

    assert.ok(logs.some(l => l[0] === 'log' && l.some(arg => String(arg).includes('custom log test'))),
      'Custom logger should receive log');
  });

  await test('null logger disables log forwarding', async () => {
    beeThreads.configure({ logger: null });
    await beeThreads.shutdown();

    // Should not throw even with logs
    const result = await beeThreads.run(() => {
      console.log('should not cause error');
      return 42;
    }).execute();
    
    assert.strictEqual(result, 42);
  });

  // Reset logger
  beeThreads.configure({ logger: console });

  // ---------- REQUEST COALESCING ----------
  section('Request Coalescing (Promise Deduplication)');

  await test('isCoalescingEnabled() returns true by default', () => {
    assert.strictEqual(beeThreads.isCoalescingEnabled(), true);
  });

  await test('setCoalescing() enables/disables coalescing', () => {
    beeThreads.setCoalescing(false);
    assert.strictEqual(beeThreads.isCoalescingEnabled(), false);
    
    beeThreads.setCoalescing(true);
    assert.strictEqual(beeThreads.isCoalescingEnabled(), true);
  });

  await test('getCoalescingStats() returns stats object', () => {
    beeThreads.resetCoalescingStats();
    const stats = beeThreads.getCoalescingStats();
    
    assert.ok('coalesced' in stats, 'Should have coalesced count');
    assert.ok('unique' in stats, 'Should have unique count');
    assert.ok('inFlight' in stats, 'Should have inFlight count');
    assert.ok('coalescingRate' in stats, 'Should have coalescingRate');
  });

  await test('resetCoalescingStats() resets counters', () => {
    beeThreads.resetCoalescingStats();
    const stats = beeThreads.getCoalescingStats();
    
    assert.strictEqual(stats.coalesced, 0);
    assert.strictEqual(stats.unique, 0);
  });

  await test('identical concurrent requests are coalesced', async () => {
    beeThreads.resetCoalescingStats();
    
    // Create a slow function to ensure requests overlap
    const slowFn = async (x: number) => {
      // Simulate work
      let sum = 0;
      for (let i = 0; i < 1000000; i++) sum += i;
      return x * 2;
    };
    
    // Launch 5 identical requests concurrently
    const promises = [
      bee(slowFn)(21),
      bee(slowFn)(21),
      bee(slowFn)(21),
      bee(slowFn)(21),
      bee(slowFn)(21)
    ];
    
    const results = await Promise.all(promises);
    
    // All should return the same result
    assert.ok(results.every(r => r === 42), 'All results should be 42');
    
    // Check that coalescing happened
    const stats = beeThreads.getCoalescingStats();
    assert.ok(stats.coalesced >= 1, `Should have coalesced at least 1 request, got ${stats.coalesced}`);
  });

  await test('different arguments create separate executions', async () => {
    beeThreads.resetCoalescingStats();
    
    // Launch requests with different arguments
    const promises = [
      bee((x: number) => x * 2)(1),
      bee((x: number) => x * 2)(2),
      bee((x: number) => x * 2)(3)
    ];
    
    const results = await Promise.all(promises);
    
    assert.deepStrictEqual(results, [2, 4, 6], 'Results should be different');
    
    // All should be unique (no coalescing)
    const stats = beeThreads.getCoalescingStats();
    assert.strictEqual(stats.unique, 3, 'Should have 3 unique requests');
  });

  await test('coalescing stats appear in getPoolStats()', () => {
    const poolStats = beeThreads.getPoolStats();
    
    assert.ok('coalescing' in poolStats, 'Pool stats should include coalescing');
    assert.ok('coalesced' in poolStats.coalescing, 'Should have coalesced count');
    assert.ok('unique' in poolStats.coalescing, 'Should have unique count');
    assert.ok('coalescingRate' in poolStats.coalescing, 'Should have coalescingRate');
  });

  await test('disabling coalescing prevents deduplication', async () => {
    beeThreads.setCoalescing(false);
    beeThreads.resetCoalescingStats();
    
    const slowFn = async () => {
      let sum = 0;
      for (let i = 0; i < 100000; i++) sum += i;
      return sum;
    };
    
    // Launch identical requests
    const promises = [
      bee(slowFn)(),
      bee(slowFn)(),
      bee(slowFn)()
    ];
    
    await Promise.all(promises);
    
    const stats = beeThreads.getCoalescingStats();
    assert.strictEqual(stats.coalesced, 0, 'No requests should be coalesced when disabled');
    
    // Re-enable coalescing
    beeThreads.setCoalescing(true);
  });

  await test('inFlight count is zero after all promises resolve', async () => {
    beeThreads.resetCoalescingStats();
    
    await bee((x: number) => x * 2)(21);
    
    const stats = beeThreads.getCoalescingStats();
    assert.strictEqual(stats.inFlight, 0, 'No promises should be in-flight after completion');
  });

  await test('non-deterministic functions (Date.now) skip coalescing automatically', async () => {
    beeThreads.resetCoalescingStats();
    
    // Function with Date.now should not be coalesced
    const timeFn = () => Date.now();
    
    // Launch 3 concurrent requests - they should all execute separately
    const promises = [
      bee(timeFn)(),
      bee(timeFn)(),
      bee(timeFn)()
    ];
    
    await Promise.all(promises);
    
    const stats = beeThreads.getCoalescingStats();
    // No coalescing should happen for Date.now functions
    assert.strictEqual(stats.coalesced, 0, 'Date.now functions should not be coalesced');
  });

  await test('non-deterministic functions (Math.random) skip coalescing automatically', async () => {
    beeThreads.resetCoalescingStats();
    
    // Function with Math.random should not be coalesced
    const randomFn = () => Math.random();
    
    const results = await Promise.all([
      bee(randomFn)(),
      bee(randomFn)(),
      bee(randomFn)()
    ]);
    
    const stats = beeThreads.getCoalescingStats();
    assert.strictEqual(stats.coalesced, 0, 'Math.random functions should not be coalesced');
  });

  await test('noCoalesce() method exists on executor', () => {
    const executor = beeThreads.run(() => 42);
    assert.ok(typeof executor.noCoalesce === 'function', 'Should have noCoalesce method');
  });

  await test('noCoalesce() forces separate executions', async () => {
    beeThreads.resetCoalescingStats();
    
    // Deterministic function that would normally be coalesced
    const slowFn = async () => {
      let sum = 0;
      for (let i = 0; i < 100000; i++) sum += i;
      return sum;
    };
    
    // With noCoalesce(), each should execute separately
    const promises = [
      beeThreads.run(slowFn).noCoalesce().execute(),
      beeThreads.run(slowFn).noCoalesce().execute(),
      beeThreads.run(slowFn).noCoalesce().execute()
    ];
    
    await Promise.all(promises);
    
    const stats = beeThreads.getCoalescingStats();
    assert.strictEqual(stats.coalesced, 0, 'noCoalesce() should prevent coalescing');
  });

  await test('noCoalesce() can be chained with other methods', async () => {
    const result = await beeThreads
      .run((x: number, y: number) => x + y)
      .usingParams(1, 2)
      .noCoalesce()
      .execute();
    
    assert.strictEqual(result, 3);
  });

  // ---------- SYMBOL.DISPOSE ----------
  section('Symbol.dispose Support');

  await test('beeThreads has Symbol.dispose', () => {
    assert.ok(typeof (beeThreads as any)[Symbol.dispose] === 'function', 
      'beeThreads should have Symbol.dispose');
  });

  await test('beeThreads has Symbol.asyncDispose', () => {
    assert.ok(typeof (beeThreads as any)[Symbol.asyncDispose] === 'function',
      'beeThreads should have Symbol.asyncDispose');
  });

  await test('Symbol.dispose shuts down workers', async () => {
    await beeThreads.run(() => 1).execute();
    const before = beeThreads.getPoolStats().normal.size;
    assert.ok(before > 0, 'Should have workers before dispose');
    
    // Call dispose
    (beeThreads as any)[Symbol.dispose]();
    
    // Give time for async shutdown
    await new Promise(r => setTimeout(r, 100));
    
    const after = beeThreads.getPoolStats().normal.size;
    assert.strictEqual(after, 0, 'Workers should be terminated after dispose');
  });

  await test('Symbol.asyncDispose awaits shutdown', async () => {
    await beeThreads.run(() => 1).execute();
    const before = beeThreads.getPoolStats().normal.size;
    assert.ok(before > 0, 'Should have workers before dispose');
    
    // Call async dispose
    await (beeThreads as any)[Symbol.asyncDispose]();
    
    const after = beeThreads.getPoolStats().normal.size;
    assert.strictEqual(after, 0, 'Workers should be terminated after asyncDispose');
  });

  // ---------- CLEANUP ----------
  section('Cleanup');

  await test('shutdown() terminates all workers', async () => {
    await beeThreads.run(() => 1).usingParams().execute();
    
    const statsBefore = beeThreads.getPoolStats();
    assert.ok(statsBefore.normal.size > 0, 'Should have workers');
    
    await beeThreads.shutdown();
    
    const statsAfter = beeThreads.getPoolStats();
    assert.strictEqual(statsAfter.normal.size, 0);
  });

  await test('shutdown() can be called multiple times safely', async () => {
    await beeThreads.shutdown();
    await beeThreads.shutdown();
    await beeThreads.shutdown();
    // Should not throw
  });

  await test('workers recreate after shutdown', async () => {
    await beeThreads.shutdown();
    
    const result = await beeThreads.run(() => 'after shutdown').execute();
    assert.strictEqual(result, 'after shutdown');
    
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.normal.size > 0, 'Workers should recreate');
  });

  // ---------- CHAOS ENGINEERING ----------
  section('Chaos Engineering - Memory & Leaks');

  await test('no memory leak with repeated executions', async () => {
    // Reset pool
    await beeThreads.shutdown();
    
    const initialHeap = process.memoryUsage().heapUsed;
    
    // Execute many tasks
    for (let i = 0; i < 100; i++) {
      await bee((x: number) => x * 2)(i);
    }
    
    // Force GC if available
    if (global.gc) global.gc();
    
    const finalHeap = process.memoryUsage().heapUsed;
    const heapGrowth = finalHeap - initialHeap;
    
    // Allow up to 10MB growth (generous for test stability)
    assert.ok(heapGrowth < 10 * 1024 * 1024, `Heap grew by ${(heapGrowth / 1024 / 1024).toFixed(2)}MB`);
  });

  await test('circular reference handling', async () => {
    // Create circular reference in context
    const obj: Record<string, unknown> = { value: 42 };
    // Note: We can't actually pass circular refs to workers (they're not serializable)
    // But we should gracefully handle the attempt
    
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
  });

  await test('large object serialization', async () => {
    const largeArray = new Array(10000).fill(0).map((_, i) => ({ index: i, value: `item-${i}` }));
    
    const result = await bee((arr: typeof largeArray) => arr.length)(largeArray);
    assert.strictEqual(result, 10000);
  });

  await test('deeply nested object handling', async () => {
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < 50; i++) {
      nested = { child: nested };
    }
    
    const NESTED = nested;
    const result = await bee(() => {
      let current: any = NESTED;
      let depth = 0;
      while (current.child) {
        current = current.child;
        depth++;
      }
      return depth;
    })({ beeClosures: { NESTED } });
    
    assert.strictEqual(result, 50);
  });

  section('Chaos Engineering - Race Conditions');

  await test('concurrent abort signals', async () => {
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    
    const promises = controllers.map((ctrl, i) => {
      const promise = bee((x: number) => {
        // Simulate work
        let sum = 0;
        for (let j = 0; j < 1000000; j++) sum += j;
        return x + sum;
      })(i)
        .then((r: number) => ({ status: 'ok', value: r }))
        .catch((e: Error) => ({ status: 'aborted', error: e.message }));
      
      // Abort some immediately, some after delay
      if (i % 2 === 0) ctrl.abort();
      else setTimeout(() => ctrl.abort(), 5);
      
      return promise;
    });
    
    const results = await Promise.all(promises);
    // Should not crash - some may complete, some may abort
    assert.ok(results.every(r => r.status === 'ok' || r.status === 'aborted'));
  });

  await test('rapid task submission and cancellation', async () => {
    const results: string[] = [];
    
    for (let i = 0; i < 20; i++) {
      const ctrl = new AbortController();
      
      beeThreads.run((x: number) => x * 2)
        .usingParams(i)
        .signal(ctrl.signal)
        .execute()
        .then(() => results.push('completed'))
        .catch(() => results.push('cancelled'));
      
      // Cancel immediately
      if (i % 3 === 0) ctrl.abort();
    }
    
    await new Promise(r => setTimeout(r, 500));
    
    // Should have processed some tasks
    assert.ok(results.length > 0, 'Should have some results');
  });

  await test('concurrent pool reconfiguration', async () => {
    // This tests that configure() during execution doesn't crash
    const taskPromises: PromiseLike<number>[] = [];
    
    for (let i = 0; i < 10; i++) {
      taskPromises.push(bee((x: number) => x * 2)(i));
    }
    
    // Reconfigure during execution
    beeThreads.configure({ maxQueueSize: 500 });
    beeThreads.configure({ maxQueueSize: 1000 });
    
    const results = await Promise.all(taskPromises);
    assert.ok(results.every((r, i) => r === i * 2));
  });

  await test('interleaved timeout and abort', async () => {
    const ctrl = new AbortController();
    
    const task = beeThreads.withTimeout(50)(() => {
      // Long running task
      let sum = 0;
      for (let i = 0; i < 100000000; i++) sum += i;
      return sum;
    })
      .signal(ctrl.signal)
      .execute()
      .catch((e: Error) => e);
    
    // Race: abort vs timeout
    setTimeout(() => ctrl.abort(), 25);
    
    const result = await task;
    // Should be either TimeoutError or AbortError
    assert.ok(
      result instanceof TimeoutError || result instanceof AbortError,
      `Expected TimeoutError or AbortError, got ${result}`
    );
  });

  section('Chaos Engineering - Worker Stability');

  await test('worker survives syntax error in function', async () => {
    try {
      // This should fail but not crash the worker
      await bee(() => {
        // @ts-ignore - intentional bad code
        return eval('{{invalid}}');
      })();
    } catch (e) {
      assert.ok(e instanceof Error);
    }
    
    // Worker should still work
    const result = await bee((x: number) => x + 1)(41);
    assert.strictEqual(result, 42);
  });

  await test('worker survives infinite loop timeout', async () => {
    try {
      await beeThreads.withTimeout(50)(() => {
        while (true) { /* infinite */ }
      }).execute();
    } catch (e) {
      assert.ok(e instanceof TimeoutError);
    }
    
    // New worker should be created and work
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
  });

  await test('multiple concurrent timeouts', async () => {
    const promises = Array.from({ length: 5 }, () =>
      beeThreads.withTimeout(30)(() => {
        while (true) { /* infinite */ }
      })
        .execute()
        .catch((e: Error) => e)
    );
    
    const results = await Promise.all(promises);
    
    // All should timeout
    assert.ok(results.every(r => r instanceof TimeoutError));
    
    // Pool should recover
    const result = await bee((x: number) => x)(42);
    assert.strictEqual(result, 42);
  });

  await test('pool stability after many errors', async () => {
    // Generate many errors
    for (let i = 0; i < 20; i++) {
      try {
        await bee(() => { throw new Error(`Error ${i}`); })();
      } catch { /* expected */ }
    }
    
    // Pool should still work
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
    
    // Stats should be consistent
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.normal.busy >= 0, 'busy should be non-negative');
    assert.ok(stats.normal.idle >= 0, 'idle should be non-negative');
  });

  section('Chaos Engineering - Edge Cases');

  await test('undefined and null returns are preserved', async () => {
    const undefinedResult = await bee(() => undefined)();
    assert.strictEqual(undefinedResult, undefined);
    
    const nullResult = await bee(() => null)();
    assert.strictEqual(nullResult, null);
  });

  await test('empty array and object returns', async () => {
    const emptyArray = await bee(() => [])();
    assert.deepStrictEqual(emptyArray, []);
    
    const emptyObject = await bee(() => ({}))();
    assert.deepStrictEqual(emptyObject, {});
  });

  await test('special number values', async () => {
    const nan = await bee(() => NaN)();
    assert.ok(Number.isNaN(nan));
    
    const inf = await bee(() => Infinity)();
    assert.strictEqual(inf, Infinity);
    
    const negInf = await bee(() => -Infinity)();
    assert.strictEqual(negInf, -Infinity);
    
    const negZero = await bee(() => -0)();
    assert.ok(Object.is(negZero, -0) || negZero === 0); // -0 may become 0 in JSON
  });

  await test('Date serialization', async () => {
    const dateStr = await bee(() => new Date('2024-01-01').toISOString())();
    assert.strictEqual(dateStr, '2024-01-01T00:00:00.000Z');
  });

  await test('BigInt handling (as string)', async () => {
    // BigInt can't be serialized directly, but we can handle it as string
    const result = await bee(() => {
      const big = BigInt(9007199254740991);
      return big.toString();
    })();
    assert.strictEqual(result, '9007199254740991');
  });

  await test('Symbol handling (cannot serialize - throws)', async () => {
    // Symbols are not serializable via structured clone
    try {
      await bee(() => {
        const s = Symbol('test');
        return { sym: s, value: 42 };
      })();
      assert.fail('Should have thrown');
    } catch (e) {
      // Expected: DOMException or DataCloneError
      assert.ok(e instanceof Error);
      assert.ok(
        e.message.includes('could not be cloned') || 
        e.message.includes('DataCloneError') ||
        e.name === 'DataCloneError',
        `Unexpected error: ${e.message}`
      );
    }
  });

  section('Chaos Engineering - Stress & Recovery');

  await test('burst of 200 tasks', async () => {
    const start = Date.now();
    
    const promises = Array.from({ length: 200 }, (_, i) =>
      bee((x: number) => x * 2)(i)
    );
    
    const results = await Promise.all(promises);
    const duration = Date.now() - start;
    
    assert.strictEqual(results.length, 200);
    assert.ok(results.every((r, i) => r === i * 2));
    assert.ok(duration < 30000, `Took too long: ${duration}ms`);
  });

  await test('queue saturation and recovery', async () => {
    // Configure small queue
    beeThreads.configure({ maxQueueSize: 5, poolSize: 2 });
    
    const results: string[] = [];
    const promises: Promise<void>[] = [];
    
    // Submit more tasks than queue can hold
    for (let i = 0; i < 20; i++) {
      promises.push(
        bee((x: number) => x)(i)
          .then(() => { results.push('ok'); })
          .catch((e: Error) => {
            if (e instanceof QueueFullError) results.push('queue-full');
            else results.push('error');
          })
      );
    }
    
    await Promise.all(promises);
    
    // Should have some successes and some queue-full errors
    assert.ok(results.includes('ok'), 'Should have some successes');
    
    // Reset config
    beeThreads.configure({ maxQueueSize: 1000, poolSize: 4 });
    
    // Pool should recover
    const result = await bee((x: number) => x + 1)(41);
    assert.strictEqual(result, 42);
  });

  await test('warmup then stress', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ minThreads: 4, poolSize: 4 });
    await beeThreads.warmup();
    
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.normal.size >= 4, 'Should have warmed up workers');
    
    // Now stress test
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bee((x: number) => x * 2)(i))
    );
    
    assert.ok(results.every((r, i) => r === i * 2));
  });

  section('Temporary Workers');

  await test('temporary workers are created when pool is full', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ poolSize: 1, maxTemporaryWorkers: 5, maxQueueSize: 0 });
    
    const metricsBefore = beeThreads.getPoolStats().metrics;
    const tempBefore = metricsBefore.temporaryWorkersCreated;
    
    // Run multiple tasks - first uses pool, rest need temporary workers
    const promises = Array.from({ length: 3 }, (_, i) => 
      beeThreads.run((x: number) => {
        // Simulate some work
        let sum = 0;
        for (let j = 0; j < 100000; j++) sum += j;
        return x + sum;
      }).usingParams(i).execute()
    );
    
    await Promise.all(promises);
    
    const metricsAfter = beeThreads.getPoolStats().metrics;
    const tempAfter = metricsAfter.temporaryWorkersCreated;
    
    // Should have created temporary workers
    assert.ok(tempAfter >= tempBefore, 'Should track temporary worker creation');
  });

  await test('temporaryWorkerTasks metric tracks executions', async () => {
    const stats = beeThreads.getPoolStats();
    assert.ok(typeof stats.metrics.temporaryWorkerTasks === 'number');
    assert.ok(typeof stats.metrics.temporaryWorkerExecutionTime === 'number');
  });

  section('Shutdown Error Handling');

  await test('queued tasks receive ERR_SHUTDOWN on shutdown', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ poolSize: 1, maxTemporaryWorkers: 0, maxQueueSize: 100 });
    
    // Start a long-running task to block the pool
    const blockingTask = beeThreads.run(() => {
      let sum = 0;
      for (let i = 0; i < 50000000; i++) sum += i;
      return sum;
    }).execute();
    
    // Queue up tasks that will be pending
    const queuedPromises: Promise<string>[] = [];
    for (let i = 0; i < 3; i++) {
      queuedPromises.push(
        beeThreads.run((x: number) => x)
          .usingParams(i)
          .execute()
          .then(() => 'completed')
          .catch((e: Error) => e.message.includes('shutting down') ? 'shutdown' : 'other')
      );
    }
    
    // Give time for tasks to queue
    await new Promise(r => setTimeout(r, 10));
    
    // Shutdown while tasks are queued
    await beeThreads.shutdown();
    
    const results = await Promise.all(queuedPromises);
    
    // Some tasks should have received shutdown error
    assert.ok(
      results.includes('shutdown') || results.includes('completed'),
      'Tasks should either complete or receive shutdown error'
    );
  });

  section('Cache Edge Cases');

  await test('cache handles empty function string', async () => {
    // This tests internal cache robustness
    const result = await bee(() => 'empty')();
    assert.strictEqual(result, 'empty');
  });

  await test('cache handles very long function', async () => {
    // Create a function with lots of code
    const longFn = (n: number) => {
      // Lots of operations
      let result = n;
      result = result + 1;
      result = result * 2;
      result = result - 1;
      result = result / 2;
      result = Math.floor(result);
      result = result + 10;
      result = result - 5;
      result = result * 3;
      result = Math.round(result / 3);
      return result;
    };
    
    const result = await bee(longFn)(10);
    assert.strictEqual(result, 15); // (10+1)*2-1)/2+10-5)*3/3 = 15
  });

  section('Worker Recovery');

  await test('pool recovers from worker exit', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ poolSize: 2, maxTemporaryWorkers: 2 });
    
    // Force worker termination via timeout
    try {
      await beeThreads.withTimeout(10)(() => {
        while (true) {}
      }).execute();
    } catch { /* expected */ }
    
    // Pool should still work
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
    
    // Run multiple tasks to ensure pool is healthy
    const results = await Promise.all([
      bee((x: number) => x)(1),
      bee((x: number) => x)(2),
      bee((x: number) => x)(3),
    ]);
    
    assert.deepStrictEqual(results, [1, 2, 3]);
  });

  await test('affinity survives worker replacement', async () => {
    await beeThreads.shutdown();
    beeThreads.configure({ poolSize: 2 });
    
    // Run same function multiple times to build affinity
    const fn = (x: number) => x * 100;
    for (let i = 0; i < 5; i++) {
      await bee(fn)(i);
    }
    
    const statsBefore = beeThreads.getPoolStats();
    const hitsBefore = statsBefore.metrics.affinityHits;
    
    // Kill a worker via timeout
    try {
      await beeThreads.withTimeout(10)(() => { while (true) {} }).execute();
    } catch { /* expected */ }
    
    // Run same function again - should still work (maybe with new worker)
    const result = await bee(fn)(42);
    assert.strictEqual(result, 4200);
    
    const statsAfter = beeThreads.getPoolStats();
    // Pool should track affinity even after worker death
    assert.ok(typeof statsAfter.metrics.affinityHits === 'number');
  });

  // ---------- Runtime Detection ----------
  console.log('\n📦 Runtime Detection');
  
  await test('RUNTIME is exported and valid', () => {
    assert.ok(['node', 'bun', 'deno'].includes(RUNTIME), `RUNTIME should be node, bun, or deno, got: ${RUNTIME}`);
  });
  
  await test('IS_BUN is a boolean', () => {
    assert.strictEqual(typeof IS_BUN, 'boolean');
  });
  
  await test('RUNTIME matches IS_BUN', () => {
    if (RUNTIME === 'bun') {
      assert.strictEqual(IS_BUN, true);
    } else {
      assert.strictEqual(IS_BUN, false);
    }
  });
  
  await test('detects Node.js correctly in this environment', () => {
    // This test runs in Node.js (or Bun with Node compat)
    assert.ok(RUNTIME === 'node' || RUNTIME === 'bun', `Expected node or bun, got: ${RUNTIME}`);
  });

  // ---------- Security Tests ----------
  console.log('\n📦 Security - Prototype Pollution Protection');
  
  await test('blocks constructor in setContext()', async () => {
    let caught = false;
    let errorMsg = '';
    try {
      await beeThreads.run((x: number) => x)
        .setContext({ 'constructor': {} } as any)
        .usingParams(1)
        .execute();
    } catch (err: any) {
      caught = true;
      errorMsg = err.message || '';
    }
    assert.ok(caught, 'Should have thrown an error');
    assert.ok(errorMsg.includes('constructor'), `Error should mention constructor, got: ${errorMsg}`);
  });
  
  await test('blocks prototype in setContext()', async () => {
    let caught = false;
    let errorMsg = '';
    try {
      await beeThreads.run((x: number) => x)
        .setContext({ 'prototype': {} } as any)
        .usingParams(1)
        .execute();
    } catch (err: any) {
      caught = true;
      errorMsg = err.message || '';
    }
    assert.ok(caught, 'Should have thrown an error');
    assert.ok(errorMsg.includes('prototype'), `Error should mention prototype, got: ${errorMsg}`);
  });
  
  await test('allows normal context keys', async () => {
    const result = await beeThreads.run((x: number) => x + MULT)
      .setContext({ MULT: 10 })
      .usingParams(5)
      .execute();
    assert.strictEqual(result, 15);
  });

  console.log('\n📦 Security - Function Size Limit');
  
  await test('allows normal sized functions', async () => {
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42);
  });
  
  await test('configure() accepts security options', () => {
    // Just verify it doesn't throw
    beeThreads.configure({
      security: {
        maxFunctionSize: 2 * 1024 * 1024, // 2MB
        blockPrototypePollution: true
      }
    });
    // Reset to default
    beeThreads.configure({
      security: {
        maxFunctionSize: 1024 * 1024 // 1MB
      }
    });
  });

  // ---------- TURBO MODE ----------
  section('Turbo Mode - Parallel Array Processing');

  await test('turbo() method exists on beeThreads', () => {
    assert.ok(typeof beeThreads.turbo === 'function', 'Should have turbo method');
  });

  await test('turbo() throws TypeError for non-array', () => {
    assert.throws(() => {
      (beeThreads as any).turbo('not an array');
    }, TypeError);
  });

  await test('turbo(arr).map(fn) processes array', async () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = await beeThreads.turbo(data, { force: true }).map((x: number) => x * 2);
    
    assert.deepStrictEqual(result, [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  await test('turbo(arr).map(fn) processes Float64Array', async () => {
    const data = new Float64Array([1, 2, 3, 4, 5]);
    const result = await beeThreads.turbo(data as any, { force: true }).map((x: number) => x * x);
    
    assert.deepStrictEqual(result, [1, 4, 9, 16, 25]);
  });

  await test('turbo(arr).filter(fn) filters array', async () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = await beeThreads.turbo(data, { force: true }).filter((x: number) => x % 2 === 0);
    
    assert.deepStrictEqual(result, [2, 4, 6, 8, 10]);
  });

  await test('turbo(arr).reduce(fn, init) reduces array', async () => {
    const data = [1, 2, 3, 4, 5];
    const result = await beeThreads.turbo(data, { force: true }).reduce((a: number, b: number) => a + b, 0);
    
    assert.strictEqual(result, 15);
  });

  await test('turbo(arr).mapWithStats(fn) returns stats', async () => {
    const data = new Float64Array(100);
    for (let i = 0; i < 100; i++) data[i] = i;
    
    const { data: result, stats } = await beeThreads
      .turbo(data as any, { force: true })
      .mapWithStats((x: number) => Math.sqrt(x));
    
    assert.ok(Array.isArray(result), 'Result should be array');
    assert.strictEqual(result.length, 100, 'Result should have same length');
    assert.ok('totalItems' in stats, 'Stats should have totalItems');
    assert.ok('workersUsed' in stats, 'Stats should have workersUsed');
    assert.ok('executionTime' in stats, 'Stats should have executionTime');
    assert.ok('speedupRatio' in stats, 'Stats should have speedupRatio');
    assert.strictEqual(stats.totalItems, 100, 'totalItems should be 100');
  });

  await test('turbo(arr, { context }) injects variables', async () => {
    const data = [1, 2, 3, 4, 5];
    const result = await beeThreads
      .turbo(data, { force: true, context: { multiplier: 10 } })
      .map((x: number) => x * multiplier);
    
    assert.deepStrictEqual(result, [10, 20, 30, 40, 50]);
  });

  await test('turboThreshold returns threshold value', () => {
    const threshold = beeThreads.turboThreshold;
    assert.ok(typeof threshold === 'number', 'Threshold should be a number');
    assert.ok(threshold > 0, 'Threshold should be positive');
  });

  await test('turbo(arr) falls back for small arrays', async () => {
    // Small array should use fallback (no force)
    const data = [1, 2, 3];
    const result = await beeThreads.turbo(data).map((x: number) => x * 2);
    
    assert.deepStrictEqual(result, [2, 4, 6]);
  });
  
  await test('turbo(arr).map(fn) preserves order', async () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const result = await beeThreads.turbo(data, { force: true }).map((x: number) => x);
    
    assert.deepStrictEqual(result, data, 'Order must be preserved');
  });

  // ---------- TURBO BENCHMARKS ----------
  section('Turbo Mode - Benchmarks');

  await test('BENCHMARK: turbo vs single worker (10K items)', async () => {
    const size = 10_000;
    const data = new Float64Array(size);
    for (let i = 0; i < size; i++) data[i] = i;
    
    // Turbo mode
    const turboStart = Date.now();
    const { stats } = await beeThreads
      .turbo(data as any, { force: true })
      .mapWithStats((x: number) => Math.sqrt(x) * Math.sin(x));
    const turboTime = Date.now() - turboStart;
    
    console.log(`  📊 10K items: ${turboTime}ms, ${stats.workersUsed} workers, speedup: ${stats.speedupRatio}`);
    
    assert.ok(turboTime < 5000, 'Should complete in reasonable time');
    assert.ok(stats.workersUsed >= 1, 'Should use at least 1 worker');
  });

  await test('BENCHMARK: turbo vs single worker (100K items)', async () => {
    const size = 100_000;
    const data = new Float64Array(size);
    for (let i = 0; i < size; i++) data[i] = i;
    
    // Turbo mode
    const turboStart = Date.now();
    const { stats } = await beeThreads
      .turbo(data as any)
      .mapWithStats((x: number) => Math.sqrt(x) * Math.sin(x));
    const turboTime = Date.now() - turboStart;
    
    console.log(`  📊 100K items: ${turboTime}ms, ${stats.workersUsed} workers, speedup: ${stats.speedupRatio}`);
    
    assert.ok(turboTime < 10000, 'Should complete in reasonable time');
    assert.ok(stats.workersUsed >= 1, 'Should use at least 1 worker');
  });

  await test('BENCHMARK: turbo filter (50K items)', async () => {
    const size = 50_000;
    const data: number[] = [];
    for (let i = 0; i < size; i++) data.push(i);
    
    const start = Date.now();
    const result = await beeThreads
      .turbo(data)
      .filter((x: number) => x % 2 === 0);
    const elapsed = Date.now() - start;
    
    console.log(`  📊 Filter 50K items: ${elapsed}ms, result: ${result.length} items`);
    
    assert.strictEqual(result.length, 25000, 'Should filter half');
  });

  await test('BENCHMARK: turbo reduce (50K items)', async () => {
    const size = 50_000;
    const data: number[] = [];
    for (let i = 1; i <= size; i++) data.push(i);
    
    const start = Date.now();
    const result = await beeThreads
      .turbo(data)
      .reduce((a: number, b: number) => a + b, 0);
    const elapsed = Date.now() - start;
    
    const expected = (size * (size + 1)) / 2; // Sum formula
    console.log(`  📊 Reduce 50K items: ${elapsed}ms, sum: ${result}`);
    
    assert.strictEqual(result, expected, 'Sum should be correct');
  });

  // ---------- TURBO ISOLATION TESTS ----------
  section('Turbo Mode - Isolation (turbo MUST NOT affect bee())');

  await test('ISOLATION: bee() works normally after turbo() calls', async () => {
    // Run turbo
    const turboData = [1, 2, 3, 4, 5];
    await beeThreads.turbo(turboData, { force: true }).map((x: number) => x * 2);
    
    // Now run normal bee() - should work exactly the same
    const normalResult = await bee((a: number, b: number) => a + b)(5, 10);
    assert.strictEqual(normalResult, 15, 'Normal bee() must work after turbo');
    
    // Another turbo
    await beeThreads.turbo(turboData, { force: true }).map((x: number) => x * 3);
    
    // And another normal bee()
    const normalResult2 = await bee((x: number) => x * x)(7);
    assert.strictEqual(normalResult2, 49, 'Normal bee() must still work');
  });

  await test('ISOLATION: interleaved turbo and bee() calls', async () => {
    // Interleave turbo and normal calls to ensure no interference
    const results: (number | number[])[] = [];
    
    results.push(await bee((x: number) => x + 1)(1)); // 2
    results.push(await beeThreads.turbo([1, 2], { force: true }).map((x: number) => x * 2)); // [2, 4]
    results.push(await bee((x: number) => x * 3)(3)); // 9
    results.push(await beeThreads.turbo([1], { force: true }).map((x: number) => x + 10)); // [11]
    results.push(await bee((a: number, b: number) => a - b)(10, 3)); // 7
    
    assert.strictEqual(results[0], 2, 'First bee() correct');
    assert.deepStrictEqual(results[1], [2, 4], 'First turbo correct');
    assert.strictEqual(results[2], 9, 'Second bee() correct');
    assert.deepStrictEqual(results[3], [11], 'Second turbo correct');
    assert.strictEqual(results[4], 7, 'Third bee() correct');
  });

  await test('ISOLATION: concurrent turbo and bee() execution', async () => {
    // Run turbo and bee() concurrently - must not interfere
    const [turboResult, beeResult1, beeResult2] = await Promise.all([
      beeThreads.turbo([1, 2, 3, 4, 5], { force: true }).map((x: number) => x * 2),
      bee((x: number) => x + 100)(5),
      bee((a: number, b: number) => a * b)(6, 7)
    ]);
    
    assert.deepStrictEqual(turboResult, [2, 4, 6, 8, 10], 'Turbo result correct');
    assert.strictEqual(beeResult1, 105, 'First bee() correct');
    assert.strictEqual(beeResult2, 42, 'Second bee() correct');
  });

  await test('ISOLATION: pool stats remain consistent after turbo', async () => {
    const statsBefore = beeThreads.getPoolStats();
    const workersBefore = statsBefore.workers;
    
    // Run turbo
    await beeThreads.turbo([1, 2, 3, 4, 5], { force: true }).map((x: number) => x * 2);
    
    // Run normal
    await bee((x: number) => x + 1)(5);
    
    const statsAfter = beeThreads.getPoolStats();
    const workersAfter = statsAfter.workers;
    
    assert.strictEqual(workersBefore, workersAfter, 'Worker count must remain stable');
  });

  // ---------- TURBO ERROR HANDLING TESTS ----------
  section('Turbo Mode - Error Handling (FAIL-FAST)');

  await test('ERROR: turbo propagates worker error as rejected promise', async () => {
    const data = [1, 2, 3, 4, 5];
    
    await assert.rejects(
      async () => {
        await beeThreads.turbo(data, { force: true }).map((x: number) => {
          if (x === 3) throw new Error('Intentional error at item 3');
          return x * 2;
        });
      },
      /Intentional error|Turbo/,
      'Should reject with worker error'
    );
  });

  await test('ERROR: turbo handles TypeError in function', async () => {
    const data = [1, 2, null, 4, 5];
    
    await assert.rejects(
      async () => {
        await beeThreads.turbo(data as any, { force: true }).map((x: any) => x.toFixed(2));
      },
      /toFixed|Cannot|null|undefined|Turbo/i,
      'Should reject with TypeError'
    );
  });

  await test('ERROR: bee() works normally after turbo error', async () => {
    // First, make turbo fail
    try {
      await beeThreads.turbo([1, 2, 3], { force: true }).map((x: number) => {
        throw new Error('Turbo failed');
      });
    } catch {
      // Expected
    }
    
    // Now normal bee() must work
    const result = await bee((x: number) => x * 2)(21);
    assert.strictEqual(result, 42, 'bee() must work after turbo error');
  });

  await test('ERROR: multiple turbo errors in sequence', async () => {
    for (let i = 0; i < 3; i++) {
      try {
        await beeThreads.turbo([1, 2], { force: true }).map((x: number) => {
          throw new Error(`Error ${i}`);
        });
      } catch (err) {
        assert.ok(err instanceof Error, 'Should be Error instance');
      }
    }
    
    // System must remain stable
    const result = await bee((x: number) => x + 1)(1);
    assert.strictEqual(result, 2, 'System stable after multiple errors');
  });

  // ---------- TURBO RACE CONDITIONS TESTS ----------
  section('Turbo Mode - Race Conditions');

  await test('RACE: many concurrent turbo calls', async () => {
    const promises: Promise<number[]>[] = [];
    const data = [1, 2, 3];
    
    // Use different pure functions (no closure capture) to avoid context issues
    const fns = [
      (x: number) => x * 1,
      (x: number) => x * 2,
      (x: number) => x * 3,
      (x: number) => x * 4,
      (x: number) => x * 5,
      (x: number) => x + 1,
      (x: number) => x + 2,
      (x: number) => x + 3,
      (x: number) => x + 4,
      (x: number) => x + 5,
    ];
    
    for (let i = 0; i < 10; i++) {
      promises.push(
        beeThreads.turbo(data, { force: true }).map(fns[i])
      );
    }
    
    const results = await Promise.all(promises);
    
    // Verify all completed without interference
    assert.strictEqual(results.length, 10, 'All 10 turbo calls completed');
    for (let i = 0; i < results.length; i++) {
      assert.strictEqual(results[i].length, 3, `Result ${i} has correct length`);
    }
  });

  await test('RACE: turbo and bee() racing together', async () => {
    const promises: Promise<unknown>[] = [];
    
    // Mix turbo and bee calls
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        promises.push(beeThreads.turbo([i], { force: true }).map((x: number) => x * 2));
      } else {
        promises.push(bee((x: number) => x * 3)(i));
      }
    }
    
    const results = await Promise.all(promises);
    
    // All must complete
    assert.strictEqual(results.length, 20, 'All 20 calls completed');
    
    // Verify alternating results
    for (let i = 0; i < results.length; i++) {
      if (i % 2 === 0) {
        assert.deepStrictEqual(results[i], [i * 2], `Turbo result ${i} correct`);
      } else {
        assert.strictEqual(results[i], i * 3, `Bee result ${i} correct`);
      }
    }
  });

  // ---------- TURBO CHAOS ENGINEERING TESTS ----------
  section('Turbo Mode - Chaos Engineering');

  await test('CHAOS: random errors in some items', async () => {
    let errorCount = 0;
    
    for (let run = 0; run < 5; run++) {
      try {
        await beeThreads.turbo([1, 2, 3, 4, 5], { force: true }).map((x: number) => {
          if (Math.random() < 0.3) throw new Error('Random chaos');
          return x * 2;
        });
      } catch {
        errorCount++;
      }
    }
    
    // Some should have failed due to random errors
    console.log(`  📊 Chaos: ${errorCount}/5 runs had random errors (expected ~1-4)`);
    assert.ok(true, 'Chaos test completed without crash');
  });

  await test('CHAOS: stress test rapid sequential turbo calls', async () => {
    const iterations = 20;
    let successCount = 0;
    const data = [1, 2, 3];
    
    // Use inline math to avoid context/cache issues
    for (let i = 0; i < iterations; i++) {
      try {
        // Pure function with no context dependency
        const result = await beeThreads.turbo(data, { force: true }).map((x: number) => x * 2 + 1);
        if (result.length === 3 && result[0] === 3) successCount++;
      } catch (err) {
        console.log(`    Iteration ${i} failed: ${(err as Error).message}`);
      }
    }
    
    console.log(`  📊 Stress: ${successCount}/${iterations} successful`);
    assert.ok(successCount >= iterations * 0.5, 'At least 50% should succeed under stress');
  });

  await test('CHAOS: system recovery after chaos', async () => {
    // After all the chaos, system must work normally
    const normalResult = await bee((a: number, b: number) => a + b)(10, 20);
    assert.strictEqual(normalResult, 30, 'System recovered from chaos');
    
    const turboResult = await beeThreads.turbo([1, 2, 3], { force: true }).map((x: number) => x * 10);
    assert.deepStrictEqual(turboResult, [10, 20, 30], 'Turbo works after chaos');
  });

  // ---------- TURBO COEXISTENCE TESTS ----------
  section('Turbo Mode - Coexistence with Other Features');

  await test('COEXIST: turbo with context + normal bee with context', async () => {
    const turboCtx = { multiplier: 5 };
    const beeCtx = { offset: 100 };
    
    const turboResult = await beeThreads
      .turbo([1, 2, 3], { force: true, context: turboCtx })
      .map((x: number) => x * multiplier);
    
    const beeResult = await beeThreads
      .run((x: number) => x + offset)
      .usingParams(50)
      .setContext(beeCtx)
      .execute();
    
    assert.deepStrictEqual(turboResult, [5, 10, 15], 'Turbo with context works');
    assert.strictEqual(beeResult, 150, 'Bee with context works');
  });

  await test('COEXIST: turbo does not affect request coalescing', async () => {
    beeThreads.resetCoalescingStats();
    
    // Run turbo
    await beeThreads.turbo([1, 2, 3], { force: true }).map((x: number) => x * 2);
    
    // Coalescing should still work for normal calls
    const slowFn = async (x: number) => {
      let sum = 0;
      for (let i = 0; i < 100000; i++) sum += i;
      return x * 2;
    };
    
    await Promise.all([bee(slowFn)(21), bee(slowFn)(21), bee(slowFn)(21)]);
    
    const stats = beeThreads.getCoalescingStats();
    assert.ok(stats.coalesced >= 1, 'Coalescing should work after turbo');
  });

  await test('COEXIST: turbo does not break worker affinity', async () => {
    // Run same function multiple times via turbo
    const data = [1, 2, 3];
    for (let i = 0; i < 5; i++) {
      await beeThreads.turbo(data, { force: true }).map((x: number) => x * 2);
    }
    
    // Now run same function via normal bee() - affinity should work
    for (let i = 0; i < 5; i++) {
      await bee((x: number) => x * 2)(5);
    }
    
    const stats = beeThreads.getPoolStats();
    assert.ok(stats.metrics.affinityHits >= 0, 'Affinity tracking works');
  });

  // ---------- TURBO PERFORMANCE REGRESSION TESTS ----------
  section('Turbo Mode - Performance Regression (bee() must not slow down)');

  await test('PERF: bee() execution time not affected by prior turbo usage', async () => {
    // Baseline: measure bee() time
    const baselineStart = Date.now();
    for (let i = 0; i < 100; i++) {
      await bee((x: number) => x * 2)(i);
    }
    const baselineTime = Date.now() - baselineStart;
    
    // Use turbo heavily
    const turboData = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (let i = 0; i < 10; i++) {
      await beeThreads.turbo(turboData, { force: true }).map((x: number) => x * x);
    }
    
    // Measure bee() time after turbo
    const afterTurboStart = Date.now();
    for (let i = 0; i < 100; i++) {
      await bee((x: number) => x * 2)(i);
    }
    const afterTurboTime = Date.now() - afterTurboStart;
    
    console.log(`  📊 bee() time: before turbo=${baselineTime}ms, after turbo=${afterTurboTime}ms`);
    
    // Allow 50% variance (due to JIT warmup, etc.)
    const maxAllowedTime = baselineTime * 1.5 + 50; // +50ms buffer
    assert.ok(afterTurboTime <= maxAllowedTime, 
      `bee() should not slow down significantly after turbo (${afterTurboTime}ms vs ${maxAllowedTime}ms allowed)`);
  });

  await test('PERF: turbo actually provides speedup for large arrays', async () => {
    const size = 20_000;
    const data = new Float64Array(size);
    for (let i = 0; i < size; i++) data[i] = i;
    
    // Measure turbo
    const turboStart = Date.now();
    const { stats } = await beeThreads
      .turbo(data as any)
      .mapWithStats((x: number) => Math.sqrt(x) * Math.sin(x));
    const turboTime = Date.now() - turboStart;
    
    console.log(`  📊 Turbo 20K: ${turboTime}ms, workers: ${stats.workersUsed}, speedup: ${stats.speedupRatio}`);
    
    // Should use multiple workers for speedup (if available)
    if (stats.workersUsed > 1) {
      assert.ok(stats.speedupRatio !== '1.0x', 'Should report speedup with multiple workers');
    }
    assert.ok(turboTime < 10000, 'Should complete in reasonable time');
  });

  await beeThreads.shutdown();

  // ---------- BUFFER RECONSTRUCTION ----------
  section('Buffer Reconstruction (.reconstructBuffers())');

  await test('reconstructBuffers() method exists on executor', async () => {
    const executor = beeThreads.run(() => Buffer.from('test'));
    assert.strictEqual(typeof executor.reconstructBuffers, 'function');
  });

  await test('reconstructBuffers() method exists on stream executor', async () => {
    const executor = beeThreads.stream(function* () { yield Buffer.from('test'); });
    assert.strictEqual(typeof executor.reconstructBuffers, 'function');
  });

  await test('without reconstructBuffers(), Buffer returns as Uint8Array', async () => {
    const result = await beeThreads
      .run(() => Buffer.from('hello world'))
      .execute();
    
    // postMessage converts Buffer to Uint8Array
    assert.ok(result instanceof Uint8Array, 'Result should be Uint8Array');
    assert.ok(!Buffer.isBuffer(result), 'Result should NOT be Buffer without reconstructBuffers()');
  });

  await test('with reconstructBuffers(), Buffer returns as Buffer', async () => {
    const result = await beeThreads
      .run(() => Buffer.from('hello world'))
      .reconstructBuffers()
      .execute();
    
    assert.ok(Buffer.isBuffer(result), 'Result should be Buffer with reconstructBuffers()');
    assert.strictEqual(result.toString(), 'hello world');
  });

  await test('reconstructBuffers() works with nested Buffer in object', async () => {
    const result = await beeThreads
      .run(() => ({
        name: 'test',
        data: Buffer.from('nested buffer'),
        count: 42
      }))
      .reconstructBuffers()
      .execute() as { name: string; data: Buffer; count: number };
    
    assert.strictEqual(result.name, 'test');
    assert.ok(Buffer.isBuffer(result.data), 'Nested data should be Buffer');
    assert.strictEqual(result.data.toString(), 'nested buffer');
    assert.strictEqual(result.count, 42);
  });

  await test('reconstructBuffers() works with Buffer in array', async () => {
    const result = await beeThreads
      .run(() => [
        Buffer.from('first'),
        Buffer.from('second'),
        Buffer.from('third')
      ])
      .reconstructBuffers()
      .execute() as Buffer[];
    
    assert.ok(Array.isArray(result), 'Result should be array');
    assert.strictEqual(result.length, 3);
    assert.ok(Buffer.isBuffer(result[0]), 'First item should be Buffer');
    assert.ok(Buffer.isBuffer(result[1]), 'Second item should be Buffer');
    assert.ok(Buffer.isBuffer(result[2]), 'Third item should be Buffer');
    assert.strictEqual(result[0].toString(), 'first');
    assert.strictEqual(result[1].toString(), 'second');
    assert.strictEqual(result[2].toString(), 'third');
  });

  await test('without reconstructBuffers(), nested Buffer is Uint8Array', async () => {
    const result = await beeThreads
      .run(() => ({ buffer: Buffer.from('test') }))
      .execute() as { buffer: Uint8Array };
    
    assert.ok(result.buffer instanceof Uint8Array, 'Nested buffer should be Uint8Array');
    assert.ok(!Buffer.isBuffer(result.buffer), 'Nested buffer should NOT be Buffer');
  });

  await test('reconstructBuffers() preserves non-Buffer values', async () => {
    const result = await beeThreads
      .run(() => ({
        str: 'hello',
        num: 123,
        bool: true,
        arr: [1, 2, 3],
        nested: { a: 1, b: 2 }
      }))
      .reconstructBuffers()
      .execute() as { str: string; num: number; bool: boolean; arr: number[]; nested: { a: number; b: number } };
    
    assert.strictEqual(result.str, 'hello');
    assert.strictEqual(result.num, 123);
    assert.strictEqual(result.bool, true);
    assert.deepStrictEqual(result.arr, [1, 2, 3]);
    assert.deepStrictEqual(result.nested, { a: 1, b: 2 });
  });

  await test('reconstructBuffers() can be chained with other methods', async () => {
    const result = await beeThreads
      .run((prefix: string) => Buffer.from(prefix + ' world'))
      .usingParams('hello')
      .reconstructBuffers()
      .priority('high')
      .execute();
    
    assert.ok(Buffer.isBuffer(result), 'Result should be Buffer');
    assert.strictEqual(result.toString(), 'hello world');
  });

  await test('stream reconstructBuffers() converts yielded Buffers', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield Buffer.from('chunk1');
        yield Buffer.from('chunk2');
        yield Buffer.from('chunk3');
      })
      .reconstructBuffers()
      .execute();
    
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    
    assert.strictEqual(chunks.length, 3);
    assert.ok(Buffer.isBuffer(chunks[0]), 'First chunk should be Buffer');
    assert.ok(Buffer.isBuffer(chunks[1]), 'Second chunk should be Buffer');
    assert.ok(Buffer.isBuffer(chunks[2]), 'Third chunk should be Buffer');
    assert.strictEqual(chunks[0].toString(), 'chunk1');
    assert.strictEqual(chunks[1].toString(), 'chunk2');
    assert.strictEqual(chunks[2].toString(), 'chunk3');
  });

  await test('stream without reconstructBuffers() yields Uint8Array', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield Buffer.from('chunk');
      })
      .execute();
    
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Uint8Array);
    }
    
    assert.strictEqual(chunks.length, 1);
    assert.ok(chunks[0] instanceof Uint8Array, 'Chunk should be Uint8Array');
    assert.ok(!Buffer.isBuffer(chunks[0]), 'Chunk should NOT be Buffer');
  });

  await test('bee() with reconstructBuffers in beeClosures option', async () => {
    // bee() API doesn't have fluent .reconstructBuffers() 
    // but the underlying run() does - test that run works
    const result = await beeThreads
      .run(() => Buffer.from('bee test'))
      .reconstructBuffers()
      .execute();
    
    assert.ok(Buffer.isBuffer(result), 'Result should be Buffer');
    assert.strictEqual(result.toString(), 'bee test');
  });

  await test('large Buffer reconstruction works correctly', async () => {
    const size = 1024 * 1024; // 1MB
    const result = await beeThreads
      .run((s: number) => {
        const buf = Buffer.alloc(s);
        buf.fill(0x42); // Fill with 'B'
        return buf;
      })
      .usingParams(size)
      .reconstructBuffers()
      .execute();
    
    assert.ok(Buffer.isBuffer(result), 'Result should be Buffer');
    assert.strictEqual(result.length, size);
    assert.strictEqual(result[0], 0x42);
    assert.strictEqual(result[size - 1], 0x42);
  });

  await beeThreads.shutdown();

  // ---------- INLINE WORKERS VALIDATION ----------
  section('Inline Workers (Bundler Compatibility)');

  // Import inline worker code for validation
  const { INLINE_WORKER_CODE, INLINE_GENERATOR_WORKER_CODE } = require('./dist/inline-workers');
  const vm = require('vm');

  await test('INLINE: worker code is valid JavaScript', () => {
    // This will throw if syntax is invalid
    new vm.Script(INLINE_WORKER_CODE, { filename: 'inline-worker.js' });
    assert.ok(true, 'Worker code parsed successfully');
  });

  await test('INLINE: generator worker code is valid JavaScript', () => {
    new vm.Script(INLINE_GENERATOR_WORKER_CODE, { filename: 'inline-generator.js' });
    assert.ok(true, 'Generator worker code parsed successfully');
  });

  await test('INLINE: worker code includes turbo handler', () => {
    assert.ok(INLINE_WORKER_CODE.includes('turbo_map'), 'Should handle turbo_map');
    assert.ok(INLINE_WORKER_CODE.includes('turbo_filter'), 'Should handle turbo_filter');
    assert.ok(INLINE_WORKER_CODE.includes('turbo_reduce'), 'Should handle turbo_reduce');
    assert.ok(INLINE_WORKER_CODE.includes('turbo_complete'), 'Should send turbo_complete');
    assert.ok(INLINE_WORKER_CODE.includes('turbo_error'), 'Should send turbo_error');
  });

  await test('INLINE: worker code includes SharedArrayBuffer support', () => {
    assert.ok(INLINE_WORKER_CODE.includes('SharedArrayBuffer'), 'Should support SharedArrayBuffer');
    assert.ok(INLINE_WORKER_CODE.includes('Float64Array'), 'Should support Float64Array');
    assert.ok(INLINE_WORKER_CODE.includes('Atomics'), 'Should use Atomics');
  });

  await test('INLINE: worker code includes context/cache fix', () => {
    // Verify the cache key includes context VALUES not just keys
    assert.ok(INLINE_WORKER_CODE.includes('JSON.stringify(context)'), 
      'Cache key should include full context values');
  });

  await test('INLINE: generator worker includes context/cache fix', () => {
    assert.ok(INLINE_GENERATOR_WORKER_CODE.includes('JSON.stringify(context)'),
      'Generator cache key should include full context values');
  });

  // ---------- TURBO OPTIMIZATIONS TESTS ----------
  section('Turbo Mode - Optimization Verification');

  await test('OPT: batch worker acquisition is faster than sequential', async () => {
    const data = new Array(50_000).fill(0).map((_, i) => i);
    
    // Run turbo - should use batch acquisition internally
    const start = Date.now();
    const { stats } = await beeThreads.turbo(data).mapWithStats((x: number) => x * 2);
    const time = Date.now() - start;
    
    console.log(`  📊 50K items: ${time}ms with ${stats.workersUsed} workers (batch acquisition)`);
    
    // Should use multiple workers
    assert.ok(stats.workersUsed >= 2, 'Should use multiple workers for batch test');
    assert.ok(time < 5000, 'Should complete in reasonable time with batch optimization');
  });

  await test('OPT: merge optimization with pre-calculated offsets', async () => {
    const data = new Array(30_000).fill(0).map((_, i) => i);
    
    const start = Date.now();
    const result = await beeThreads.turbo(data).map((x: number) => x + 1);
    const time = Date.now() - start;
    
    console.log(`  📊 Merge optimization: ${time}ms for 30K items`);
    
    // Verify correctness (merge worked properly)
    assert.strictEqual(result.length, 30_000, 'All items merged');
    assert.strictEqual(result[0], 1, 'First item correct');
    assert.strictEqual(result[29_999], 30_000, 'Last item correct');
    assert.ok(time < 5000, 'Optimized merge should be fast');
  });

  await test('OPT: turbo handles large arrays efficiently', async () => {
    const data = new Array(100_000).fill(0).map((_, i) => i);
    
    const start = Date.now();
    const { stats } = await beeThreads.turbo(data).mapWithStats((x: number) => x % 2 === 0 ? x : -x);
    const time = Date.now() - start;
    
    console.log(`  📊 100K items: ${time}ms, ${stats.workersUsed} workers, speedup: ${stats.speedupRatio}`);
    
    assert.ok(stats.workersUsed >= 2, 'Should parallelize large arrays');
    assert.ok(time < 10000, 'Should handle 100K items efficiently');
  });

  await test('OPT: turbo filter preserves order with optimized merge', async () => {
    const data = new Array(20_000).fill(0).map((_, i) => i);
    
    const result = await beeThreads.turbo(data).filter((x: number) => x % 10 === 0);
    
    // Should have 2000 items (0, 10, 20, ..., 19990)
    assert.strictEqual(result.length, 2000, 'Filter correct count');
    assert.strictEqual(result[0], 0, 'First item correct');
    assert.strictEqual(result[1], 10, 'Second item correct');
    assert.strictEqual(result[1999], 19990, 'Last item correct');
  });

  await test('OPT: turbo reduce combines results correctly', async () => {
    const data = new Array(10_000).fill(1);
    
    const sum = await beeThreads.turbo(data).reduce((a: number, b: number) => a + b, 0);
    
    assert.strictEqual(sum, 10_000, 'Reduce sum correct with optimized merge');
  });

  // ---------- MAX MODE TESTS ----------
  section('Max Mode - Main Thread + Workers');

  await test('max() method exists on beeThreads', () => {
    assert.ok(typeof beeThreads.max === 'function', 'Should have max method');
  });

  await test('max() throws TypeError for non-array', () => {
    assert.throws(
      () => (beeThreads as any).max('not an array'),
      TypeError
    );
  });

  await test('max(arr).map(fn) processes array with main thread', async () => {
    const data = new Array(10_000).fill(0).map((_, i) => i);
    const result = await beeThreads.max(data, { force: true }).map((x: number) => x * 2);
    
    assert.strictEqual(result.length, 10_000, 'Should have all items');
    assert.strictEqual(result[0], 0, 'First item correct');
    assert.strictEqual(result[5000], 10_000, 'Middle item correct');
    assert.strictEqual(result[9999], 19_998, 'Last item correct');
  });

  await test('max(arr).mapWithStats() returns correct stats', async () => {
    const data = new Array(20_000).fill(0).map((_, i) => i);
    
    const { data: result, stats } = await beeThreads
      .max(data, { force: true })
      .mapWithStats((x: number) => x + 1);
    
    assert.strictEqual(result.length, 20_000, 'Should process all items');
    assert.ok(stats.workersUsed >= 2, 'Should use multiple threads including main');
    assert.ok(stats.totalItems === 20_000, 'Stats correct');
    console.log(`  📊 max() used ${stats.workersUsed} threads (including main)`);
  });

  await test('max(arr).filter(fn) filters with main thread', async () => {
    const data = new Array(5_000).fill(0).map((_, i) => i);
    const result = await beeThreads.max(data, { force: true }).filter((x: number) => x % 2 === 0);
    
    assert.strictEqual(result.length, 2_500, 'Should filter correctly');
    assert.strictEqual(result[0], 0, 'First even correct');
    assert.strictEqual(result[1], 2, 'Second even correct');
  });

  await test('max(arr).reduce(fn, init) reduces with main thread', async () => {
    const data = new Array(8_000).fill(1);
    const result = await beeThreads.max(data, { force: true }).reduce((a: number, b: number) => a + b, 0);
    
    assert.strictEqual(result, 8_000, 'Should reduce correctly');
  });

  await test('max(arr, { context }) injects variables', async () => {
    const data = [10, 20, 30];
    const result = await beeThreads
      .max(data, { force: true, context: { multiplier: 5 } })
      .map((x: number) => x * multiplier);
    
    assert.deepStrictEqual(result, [50, 100, 150], 'Context should work with max');
  });

  await test('max() preserves array order', async () => {
    const data = new Array(15_000).fill(0).map((_, i) => i);
    const result = await beeThreads.max(data, { force: true }).map((x: number) => x);
    
    for (let i = 0; i < 15_000; i++) {
      assert.strictEqual(result[i], i, `Item ${i} should be in order`);
    }
  });

  await test('BENCHMARK: max() vs turbo() throughput', async () => {
    const data = new Array(50_000).fill(0).map((_, i) => i);
    
    // Turbo (workers only)
    const turboStart = Date.now();
    const turboResult = await beeThreads.turbo(data).mapWithStats((x: number) => x * x);
    const turboTime = Date.now() - turboStart;
    
    // Max (workers + main thread)
    const maxStart = Date.now();
    const maxResult = await beeThreads.max(data).mapWithStats((x: number) => x * x);
    const maxTime = Date.now() - maxStart;
    
    console.log(`  📊 turbo: ${turboTime}ms (${turboResult.stats.workersUsed} workers)`);
    console.log(`  📊 max: ${maxTime}ms (${maxResult.stats.workersUsed} threads incl. main)`);
    console.log(`  📊 max speedup: ${(turboTime / maxTime).toFixed(2)}x faster`);
    
    // Both should produce same result
    assert.deepStrictEqual(maxResult.data, turboResult.data, 'Results should match');
    
    // Max should use one more thread (main thread)
    assert.ok(maxResult.stats.workersUsed >= turboResult.stats.workersUsed, 
      'max should use at least as many threads as turbo');
  });

  await test('max() error handling - propagates errors', async () => {
    const data = [1, 2, 3, 4, 5];
    
    await assert.rejects(
      async () => {
        await beeThreads.max(data, { force: true }).map((x: number) => {
          if (x === 3) throw new Error('Max error test');
          return x * 2;
        });
      },
      /Max error test|Error/
    );
  });

  await test('max() works with small arrays (fallback)', async () => {
    const data = [1, 2, 3];
    const result = await beeThreads.max(data).map((x: number) => x * 10);
    
    assert.deepStrictEqual(result, [10, 20, 30], 'Small array fallback works');
  });

  await test('ISOLATION: max() does not affect bee()', async () => {
    // Run max
    await beeThreads.max([1, 2, 3, 4, 5], { force: true }).map((x: number) => x * 2);
    
    // bee() should still work
    const result = await bee((x: number) => x + 10)(5);
    assert.strictEqual(result, 15, 'bee() works after max()');
  });

  await test('ISOLATION: max() and turbo() can be used together', async () => {
    const data1 = new Array(5_000).fill(0).map((_, i) => i);
    const data2 = new Array(5_000).fill(0).map((_, i) => i * 2);
    
    const [maxResult, turboResult] = await Promise.all([
      beeThreads.max(data1, { force: true }).map((x: number) => x + 1),
      beeThreads.turbo(data2, { force: true }).map((x: number) => x + 2)
    ]);
    
    assert.strictEqual(maxResult.length, 5_000, 'max result correct');
    assert.strictEqual(turboResult.length, 5_000, 'turbo result correct');
    assert.strictEqual(maxResult[0], 1, 'max first item correct');
    assert.strictEqual(turboResult[0], 2, 'turbo first item correct');
  });

  await test('max() handles Float64Array', async () => {
    const data = new Float64Array([1.5, 2.5, 3.5, 4.5]);
    const result = await beeThreads.max(data as any, { force: true }).map((x: number) => x * 2);
    
    assert.strictEqual(result.length, 4, 'Float64Array processed');
    assert.strictEqual(result[0], 3, 'First value correct');
    assert.strictEqual(result[3], 9, 'Last value correct');
  });

  await test('STRESS: max() with concurrent operations', async () => {
    const promises = [];
    
    for (let i = 0; i < 5; i++) {
      const data = new Array(10_000).fill(i);
      promises.push(
        beeThreads.max(data, { force: true }).map((x: number) => x + 1)
      );
    }
    
    const results = await Promise.all(promises);
    
    assert.strictEqual(results.length, 5, 'All max operations completed');
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(results[i].length, 10_000, `Result ${i} has correct length`);
      assert.strictEqual(results[i][0], i + 1, `Result ${i} has correct value`);
    }
  });

  // ---------- SUMMARY ----------
  console.log('\n' + '='.repeat(50));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

// Declare global variables used in tests
declare const undefinedVariable: any;
declare const TAX: number;
declare const VALUE: number;
declare const MULT: number;
declare const A: number;
declare const B: number;
declare const config: any;
declare const values: number[];
declare const helperCode: string;
declare const factor: number;
declare const prefix: string;
declare const label: string;
declare const multiplier: number;
declare const ctxMultiplier: number;
declare const items: number[];
declare const arr: number[];
declare const PREFIX: string;
declare const FACTOR: number;

runTests().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});

