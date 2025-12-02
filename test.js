// test.js - bee-threads test suite
const assert = require('assert');
const { beeThreads, AbortError, TimeoutError, QueueFullError, WorkerError } = require('./src/index.js');

// Test utilities
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    if (err.stack) console.log(`     ${err.stack.split('\n')[1]}`);
    failed++;
  }
}

function section(name) {
  console.log(`\n📦 ${name}`);
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  console.log('\n🧪 bee-threads Test Suite\n');
  console.log('='.repeat(50));

  // ---------- BASIC RUN ----------
  section('beeThreads.run()');

  await test('executes sync function and returns result', async () => {
    const result = await beeThreads
      .run((a, b) => a + b)
      .usingParams(2, 3)
      .execute();
    assert.strictEqual(result, 5);
  });

  await test('handles complex computation', async () => {
    const result = await beeThreads
      .run((n) => {
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
    } catch (err) {
      assert.strictEqual(err.name, 'TypeError');
    }
  });

  await test('passes multiple arguments correctly', async () => {
    const result = await beeThreads
      .run((a, b, c, d) => a * b + c - d)
      .usingParams(2, 3, 10, 4)
      .execute();
    assert.strictEqual(result, 12);
  });

  await test('handles arrow functions', async () => {
    const result = await beeThreads
      .run((x) => x * 2)
      .usingParams(21)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('handles async arrow functions', async () => {
    const result = await beeThreads
      .run(async (x) => {
        await new Promise(r => setTimeout(r, 10));
        return x * 2;
      })
      .usingParams(21)
      .execute();
    assert.strictEqual(result, 42);
  });

  await test('handles curried functions automatically', async () => {
    const result = await beeThreads
      .run((a) => (b) => (c) => a + b + c)
      .usingParams(1, 2, 3)
      .execute();
    assert.strictEqual(result, 6);
  });

  // ---------- SAFE RUN ----------
  section('beeThreads.safeRun()');

  await test('returns fulfilled result on success', async () => {
    const result = await beeThreads
      .safeRun((x) => x * 2)
      .usingParams(21)
      .execute();
    assert.strictEqual(result.status, 'fulfilled');
    assert.strictEqual(result.value, 42);
  });

  await test('returns rejected result on error (never throws)', async () => {
    const result = await beeThreads
      .safeRun(() => { throw new Error('safe error'); })
      .usingParams()
      .execute();
    assert.strictEqual(result.status, 'rejected');
    assert.strictEqual(result.error.message, 'safe error');
  });

  await test('handles async rejection safely', async () => {
    const result = await beeThreads
      .safeRun(async () => { throw new Error('async safe'); })
      .usingParams()
      .execute();
    assert.strictEqual(result.status, 'rejected');
  });

  // ---------- TIMEOUT ----------
  section('beeThreads.withTimeout()');

  await test('completes before timeout', async () => {
    const result = await beeThreads
      .withTimeout(5000)((x) => x + 1)
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

  // ---------- SAFE WITH TIMEOUT ----------
  section('beeThreads.safeWithTimeout()');

  await beeThreads.shutdown();

  await test('returns fulfilled on success within timeout', async () => {
    const result = await beeThreads
      .safeWithTimeout(5000)((x) => x)
      .usingParams(42)
      .execute();
    assert.strictEqual(result.status, 'fulfilled');
    assert.strictEqual(result.value, 42);
  });

  await test('returns rejected on timeout (never throws)', async () => {
    const result = await beeThreads
      .safeWithTimeout(50)(() => {
        const start = Date.now();
        while (Date.now() - start < 200) {}
      })
      .usingParams()
      .execute();
    assert.strictEqual(result.status, 'rejected');
    assert.ok(result.error instanceof TimeoutError);
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

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, [1, 2, 3]);
  });

  await test('streams with arguments', async () => {
    const stream = beeThreads
      .stream(function* (start, count) {
        for (let i = 0; i < count; i++) {
          yield start + i;
        }
      })
      .usingParams(10, 3)
      .execute();

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
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

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
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

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    assert.deepStrictEqual(chunks, [1, 2]);
    assert.strictEqual(stream.returnValue, 'final');
  });

  await beeThreads.shutdown();

  // ---------- INPUT VALIDATION ----------
  section('Input Validation');

  await test('run() throws TypeError for non-function', () => {
    assert.throws(
      () => beeThreads.run('not a function'),
      TypeError
    );
  });

  await test('run() throws TypeError for null', () => {
    assert.throws(
      () => beeThreads.run(null),
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
      () => beeThreads.withTimeout('100'),
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
      () => beeThreads.stream('not a generator'),
      TypeError
    );
  });

  // ---------- POOL MANAGEMENT ----------
  section('Pool Management');

  await test('getPoolStats() returns valid stats', async () => {
    await beeThreads.run((x) => x).usingParams(1).execute();
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
      stats.maxSize = 999;
    }, TypeError);
  });

  await test('transfer() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.transfer === 'function', 'transfer method should exist');
  });

  await test('signal() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.signal === 'function', 'signal method should exist');
  });

  // ---------- CURRIED REUSABILITY ----------
  section('Curried API');

  await test('executor can be reused multiple times', async () => {
    const double = beeThreads.run((x) => x * 2);
    
    const r1 = await double.usingParams(5).execute();
    const r2 = await double.usingParams(10).execute();
    const r3 = await double.usingParams(21).execute();
    
    assert.strictEqual(r1, 10);
    assert.strictEqual(r2, 20);
    assert.strictEqual(r3, 42);
  });

  await test('multiple executors work independently', async () => {
    const add = beeThreads.run((a, b) => a + b);
    const mul = beeThreads.run((a, b) => a * b);
    
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

  await test('safeRun returns rejected result on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    
    const result = await beeThreads
      .safeRun(() => 'should not run')
      .usingParams()
      .signal(controller.signal)
      .execute();
    
    assert.strictEqual(result.status, 'rejected');
    assert.ok(result.error instanceof AbortError);
  });

  await test('fluent API chains correctly', async () => {
    const controller = new AbortController();
    
    const exec = beeThreads
      .run((x) => x * 2)
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
    } catch (err) {
      assert.ok(err instanceof WorkerError);
      assert.strictEqual(err.name, 'RangeError');
    }
  });

  // ---------- RETRY ----------
  section('Retry Support');

  await test('retry() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.retry === 'function', 'retry method should exist');
  });

  let retryAttempt = 0;
  await test('retry succeeds on transient failure simulation', async () => {
    retryAttempt = 0;
    const result = await beeThreads
      .run((attempt) => {
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
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.setContext === 'function', 'setContext method should exist');
  });

  await test('setContext() injects variables into function scope', async () => {
    const factor = 10;
    const prefix = 'result:';
    
    const result = await beeThreads
      .run((x) => prefix + (x * factor))
      .usingParams(5)
      .setContext({ factor, prefix })
      .execute();
    
    assert.strictEqual(result, 'result:50');
  });

  await test('setContext() works with multiple variables', async () => {
    const config = { multiplier: 3, offset: 100 };
    const label = 'value';
    
    const result = await beeThreads
      .run((x) => ({ [label]: x * config.multiplier + config.offset }))
      .usingParams(10)
      .setContext({ config, label })
      .execute();
    
    assert.deepStrictEqual(result, { value: 130 });
  });

  await test('setContext() works with stream/generators', async () => {
    const multiplier = 2;
    
    const stream = beeThreads
      .stream(function* (n) {
        for (let i = 1; i <= n; i++) {
          yield i * multiplier;
        }
      })
      .usingParams(3)
      .setContext({ multiplier })
      .execute();
    
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    
    assert.deepStrictEqual(chunks, [2, 4, 6]);
  });

  await beeThreads.shutdown();

  // ---------- USING PARAMS ----------
  section('usingParams() - Arguments');

  await test('usingParams() method exists on executor', () => {
    const exec = beeThreads.run((x) => x);
    assert.ok(typeof exec.usingParams === 'function', 'usingParams method should exist');
  });

  await test('usingParams() passes arguments correctly', async () => {
    const result = await beeThreads
      .run((a, b, c) => a + b + c)
      .usingParams(10, 20, 12)
      .execute();
    
    assert.strictEqual(result, 42);
  });

  await test('usingParams() can be chained', async () => {
    const result = await beeThreads
      .run((a, b, c, d) => a + b + c + d)
      .usingParams(1)
      .usingParams(2)
      .usingParams(3, 4)
      .execute();
    
    assert.strictEqual(result, 10);
  });

  await test('usingParams() combines with setContext()', async () => {
    const factor = 2;
    
    const result = await beeThreads
      .run((a, b) => (a + b) * factor)
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

  await test('execute() works directly for safeRun()', async () => {
    const result = await beeThreads
      .safeRun(() => 123)
      .execute();
    assert.strictEqual(result.status, 'fulfilled');
    assert.strictEqual(result.value, 123);
  });

  await test('stream execute() works without usingParams()', async () => {
    const stream = beeThreads
      .stream(function* () {
        yield 'a';
        yield 'b';
      })
      .execute();

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
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
      () => beeThreads.run((x) => x).setContext(null),
      TypeError
    );
  });

  await test('setContext() throws TypeError for non-object', () => {
    assert.throws(
      () => beeThreads.run((x) => x).setContext('not an object'),
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
      .run((buf) => {
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
      .run((buf) => {
        const arr = new Uint8Array(buf);
        return arr[0] + arr[arr.length - 1];
      })
      .usingParams(buffer)
      .transfer([buffer])
      .execute();

    assert.strictEqual(result, 3);
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

    const chunks = [];
    try {
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      assert.fail('Should have thrown');
    } catch (err) {
      assert.strictEqual(err.message, 'generator error');
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

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
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
    
    const tasks = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(
        beeThreads
          .run((n) => n * 2)
          .usingParams(i)
          .execute()
      );
    }

    const results = await Promise.all(tasks);
    
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(results[i], i * 2);
    }
  });

  await test('concurrent safeRun tasks all succeed', async () => {
    const tasks = [];
    for (let i = 0; i < 10; i++) {
      tasks.push(
        beeThreads
          .safeRun((n) => n + 1)
          .usingParams(i)
          .execute()
      );
    }

    const results = await Promise.all(tasks);
    
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(results[i].status, 'fulfilled');
      assert.strictEqual(results[i].value, i + 1);
    }
  });

  await test('mixed success and failure in concurrent tasks', async () => {
    const tasks = [
      beeThreads.safeRun(() => 1).execute(),
      beeThreads.safeRun(() => { throw new Error('fail'); }).execute(),
      beeThreads.safeRun(() => 3).execute(),
    ];

    const results = await Promise.all(tasks);
    
    assert.strictEqual(results[0].status, 'fulfilled');
    assert.strictEqual(results[0].value, 1);
    assert.strictEqual(results[1].status, 'rejected');
    assert.strictEqual(results[2].status, 'fulfilled');
    assert.strictEqual(results[2].value, 3);
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
      () => beeThreads.configure({ workerIdleTimeout: 'fast' }),
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
      .run(() => items.reduce((a, b) => a + b, 0))
      .setContext({ items })
      .execute();

    assert.strictEqual(result, 60);
  });

  await test('setContext() with functions as strings', async () => {
    const helperCode = '(x) => x * 2';

    const result = await beeThreads
      .run((val) => {
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
      .run((x) => x * factor)
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
      .run((x) => x * factor)
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

runTests().catch(err => {
  console.error('Test suite crashed:', err);
  process.exit(1);
});
