/**
 * Detailed test to diagnose BEE.TURBO on Bun
 */

console.log('=== BEE.TURBO BUN SCALING TEST ===\n');

const runtime = typeof (globalThis as any).Bun !== 'undefined' ? 'Bun' : 'Node';
console.log(`Runtime: ${runtime}`);

// Timeout helper
const withTimeout = <T>(promise: Promise<T>, ms: number, name: string): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error(`${name} timed out after ${ms}ms`)), ms)
    )
  ]);
};

async function testConfig(beeThreads: any, items: number, workers: number): Promise<boolean> {
  const label = `${items} items, ${workers} workers`;
  process.stdout.write(`  Testing ${label}... `);
  
  try {
    const data = Array.from({ length: items }, (_, i) => i);
    const result = await withTimeout(
      beeThreads.turbo(data).setWorkers(workers).map((x: number) => x * 2),
      10000,
      label
    );
    
    const correct = result.length === items && result[0] === 0 && result[items - 1] === (items - 1) * 2;
    if (correct) {
      console.log('✅');
      return true;
    } else {
      console.log(`❌ Wrong result (got ${result.length} items)`);
      return false;
    }
  } catch (e) {
    console.log(`❌ ${(e as Error).message}`);
    return false;
  }
}

async function test() {
  try {
    console.log('1. Importing beeThreads...');
    const { beeThreads } = await import('../dist/index.js');
    console.log('   ✅ Import OK\n');

    console.log('2. Testing different configurations:\n');
    
    // Test scaling
    const configs = [
      { items: 10, workers: 1 },
      { items: 100, workers: 1 },
      { items: 1000, workers: 1 },
      { items: 10, workers: 2 },
      { items: 100, workers: 2 },
      { items: 1000, workers: 2 },
      { items: 10, workers: 4 },
      { items: 100, workers: 4 },
      { items: 1000, workers: 4 },
      { items: 10000, workers: 4 },
      { items: 10000, workers: 8 },
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const { items, workers } of configs) {
      const ok = await testConfig(beeThreads, items, workers);
      if (ok) passed++;
      else failed++;
    }
    
    console.log(`\n3. Results: ${passed} passed, ${failed} failed`);
    
    await beeThreads.shutdown();
    
    if (failed > 0) {
      console.log('\n❌ SOME TESTS FAILED');
      process.exit(1);
    } else {
      console.log('\n✅ ALL TESTS PASSED!');
      process.exit(0);
    }
  } catch (e) {
    console.error('\n❌ ERROR:');
    console.error('Message:', (e as Error).message);
    console.error('Stack:', (e as Error).stack);
    process.exit(1);
  }
}

test();
