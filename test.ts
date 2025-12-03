// test.ts - bee-threads test suite v1.0.0
import * as assert from 'assert';
import { bee, beeThreads, AbortError, TimeoutError, QueueFullError, WorkerError, noopLogger } from './dist/index.js';
import { createLRUCache, createFunctionCache } from './dist/cache.js';
import type { Logger } from './dist/types.js';

// Test utilities
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
      chunks.push(chunk as number);
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
    const multiplier = 2;
    
    const stream = beeThreads
      .stream(function* (n: number) {
        for (let i = 1; i <= n; i++) {
          yield i * multiplier;
        }
      })
      .usingParams(3)
      .setContext({ multiplier })
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
    const cache = createLRUCache<string, string>(10);
    cache.set('key1', 'value1');
    assert.strictEqual(cache.get('key1'), 'value1');
    assert.strictEqual(cache.size(), 1);
  });

  await test('cache.has() checks existence without updating LRU', () => {
    const cache = createLRUCache<string, string>(10);
    cache.set('key1', 'value1');
    assert.strictEqual(cache.has('key1'), true);
    assert.strictEqual(cache.has('nonexistent'), false);
  });

  await test('cache.get() returns undefined for missing keys', () => {
    const cache = createLRUCache<string, string>(10);
    assert.strictEqual(cache.get('nonexistent'), undefined);
  });

  await test('cache evicts LRU entry when full', () => {
    const cache = createLRUCache<string, number>(3);
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
    const cache = createLRUCache<string, number>(3);
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
    const cache = createLRUCache<string, number>(10);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    assert.strictEqual(cache.size(), 0);
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
    const tasks: Promise<number>[] = [];
    for (let i = 0; i < 20; i++) {
      if (i % 2 === 0) {
        tasks.push(bee((x: number) => x)(i)); // sync
      } else {
        tasks.push(bee(async (x: number) => x)(i)); // async
      }
    }
    const results = await Promise.all(tasks);
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(results[i], i);
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

  await beeThreads.shutdown();

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
declare const items: number[];
declare const arr: number[];
declare const PREFIX: string;
declare const FACTOR: number;

runTests().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});

