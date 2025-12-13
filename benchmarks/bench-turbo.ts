/**
 * BENCHMARK 1: RAW vs BEE.TURBO vs BEE.WORKER.TURBO vs PISCINA
 * 
 * Objetivo: Comparar performance de processamento paralelo de arrays
 * 
 * Métodos testados:
 * - RAW: Array.prototype.map (baseline, single-thread)
 * - BEE.TURBO: beeThreads.turbo(arr).map(fn)
 * - BEE.WORKER.TURBO: beeThreads.worker('./worker').turbo(arr)
 * - PISCINA: Pool de workers externo (comparação com lib popular)
 * 
 * Cenários:
 * - CPU-LIGHT: Operações simples (x * 2)
 * - CPU-HEAVY: Operações pesadas (1000 iterações de Math)
 * - OBJECT: Transformação de objetos
 */

import { performance } from 'perf_hooks';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ============================================================================
// CONFIG
// ============================================================================

const RUNS = 5;
const WARMUP = 2;
const WORKERS = Math.max(2, cpus().length - 1);

// Bun has some worker issues with very large arrays, so we use smaller sizes
const isBun = typeof (globalThis as any).Bun !== 'undefined';
const SIZES = {
  small: 10_000,
  medium: 100_000,
  large: isBun ? 500_000 : 1_000_000,
};

// ============================================================================
// TYPES
// ============================================================================

interface BenchResult {
  name: string;
  size: number;
  scenario: string;
  mean: number;
  std: number;
  min: number;
  max: number;
  opsPerSec: number;
}

interface TestObject {
  id: number;
  value: number;
  score: number;
  name: string;
  active: boolean;
}

// ============================================================================
// STATS
// ============================================================================

function stats(times: number[]): { mean: number; std: number; min: number; max: number } {
  const n = times.length;
  const mean = times.reduce((a, b) => a + b, 0) / n;
  const variance = times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / n;
  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(Math.sqrt(variance) * 100) / 100,
    min: Math.round(Math.min(...times) * 100) / 100,
    max: Math.round(Math.max(...times) * 100) / 100,
  };
}

// ============================================================================
// DATA GENERATORS
// ============================================================================

function generateNumbers(size: number): number[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) arr[i] = Math.random() * 1000;
  return arr;
}

function generateObjects(size: number): TestObject[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = {
      id: i,
      value: Math.random() * 1000,
      score: Math.random() * 100,
      name: `user_${i}`,
      active: i % 2 === 0,
    };
  }
  return arr;
}

// ============================================================================
// TEST FUNCTIONS
// ============================================================================

// CPU-LIGHT: Operação simples
const lightFn = (x: number) => x * 2 + 1;

// CPU-HEAVY: Operação pesada (1000 iterações)
const heavyFn = (x: number) => {
  let result = x;
  for (let i = 0; i < 1000; i++) {
    result = Math.sin(result) * Math.cos(result) + Math.sqrt(Math.abs(result));
  }
  return result;
};

// OBJECT: Transformação de objeto
const objectFn = (obj: TestObject) => ({
  ...obj,
  computed: obj.value * obj.score,
  tier: obj.active ? 'premium' : 'standard',
  hash: obj.id * 31,
});

// ============================================================================
// BENCHMARK RUNNERS
// ============================================================================

async function benchRaw<T, R>(data: T[], fn: (x: T) => R): Promise<number[]> {
  const times: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) data.map(fn);
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    data.map(fn);
    times.push(performance.now() - start);
  }
  
  return times;
}

async function benchBeeTurbo<T, R>(
  beeThreads: any,
  data: T[],
  fn: (x: T) => R
): Promise<number[]> {
  const times: number[] = [];
  
  // Use fewer workers on Bun due to potential issues
  const numWorkers = typeof (globalThis as any).Bun !== 'undefined' ? Math.min(4, WORKERS) : WORKERS;
  
  try {
    // Warmup with timeout
    for (let i = 0; i < WARMUP; i++) {
      const result = await Promise.race([
        beeThreads.turbo(data).setWorkers(numWorkers).map(fn),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Warmup timeout')), 30000))
      ]);
    }
    
    // Runs
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      await beeThreads.turbo(data).setWorkers(numWorkers).map(fn);
      times.push(performance.now() - start);
    }
  } catch (e) {
    console.error(`\n   TURBO ERROR: ${(e as Error).message}`);
    throw e;
  }
  
  return times;
}

async function benchBeeWorkerTurbo<T>(
  beeThreads: any,
  workerPath: string,
  data: T[]
): Promise<number[]> {
  const times: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await beeThreads.worker(workerPath).turbo(data, { workers: WORKERS });
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    await beeThreads.worker(workerPath).turbo(data, { workers: WORKERS });
    times.push(performance.now() - start);
  }
  
  return times;
}

async function benchPiscina<T>(
  Piscina: any,
  workerPath: string,
  data: T[],
  fnName: string
): Promise<number[]> {
  const times: number[] = [];
  const pool = new Piscina({
    filename: workerPath,
    maxThreads: WORKERS,
  });
  
  // Chunk data for Piscina (it doesn't auto-chunk)
  const chunkSize = Math.ceil(data.length / WORKERS);
  const chunks: T[][] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    await Promise.all(chunks.map(chunk => pool.run({ chunk, fnName })));
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    const results = await Promise.all(chunks.map(chunk => pool.run({ chunk, fnName })));
    // Flatten results
    results.flat();
    times.push(performance.now() - start);
  }
  
  await pool.destroy();
  return times;
}

// ============================================================================
// MAIN
// ============================================================================

async function runScenario(
  name: string,
  scenario: string,
  size: number,
  beeThreads: any,
  Piscina: any,
  dataGenerator: () => any[],
  rawFn: (x: any) => any,
  piscinaFnName: string,
  beeWorkerPath: string,
  piscinaWorkerPath: string
): Promise<BenchResult[]> {
  const data = dataGenerator();
  const results: BenchResult[] = [];
  
  console.log(`\n  ${name} (${(size / 1000).toFixed(0)}K items)`);
  console.log('  ' + '-'.repeat(50));
  
  // RAW
  process.stdout.write('    RAW:              ');
  const rawTimes = await benchRaw(data, rawFn);
  const rawStats = stats(rawTimes);
  console.log(`${rawStats.mean.toFixed(2)}ms ± ${rawStats.std.toFixed(2)}ms`);
  results.push({
    name: 'RAW',
    size,
    scenario,
    ...rawStats,
    opsPerSec: Math.round((size / rawStats.mean) * 1000),
  });
  
  // BEE.TURBO
  process.stdout.write('    BEE.TURBO:        ');
  try {
    const turboTimes = await benchBeeTurbo(beeThreads, data, rawFn);
    const turboStats = stats(turboTimes);
    const turboSpeedup = rawStats.mean / turboStats.mean;
    console.log(
      `${turboStats.mean.toFixed(2)}ms ± ${turboStats.std.toFixed(2)}ms ` +
      `${turboSpeedup >= 1 ? '✅' : '❌'} ${turboSpeedup.toFixed(2)}x`
    );
    results.push({
      name: 'BEE.TURBO',
      size,
      scenario,
      ...turboStats,
      opsPerSec: Math.round((size / turboStats.mean) * 1000),
    });
  } catch (e) {
    console.log(`ERROR: ${(e as Error).message}`);
    console.error((e as Error).stack);
  }
  
  // BEE.WORKER.TURBO
  process.stdout.write('    BEE.WORKER.TURBO: ');
  try {
    const workerTurboTimes = await benchBeeWorkerTurbo(beeThreads, beeWorkerPath, data);
    const workerTurboStats = stats(workerTurboTimes);
    const workerTurboSpeedup = rawStats.mean / workerTurboStats.mean;
    console.log(
      `${workerTurboStats.mean.toFixed(2)}ms ± ${workerTurboStats.std.toFixed(2)}ms ` +
      `${workerTurboSpeedup >= 1 ? '✅' : '❌'} ${workerTurboSpeedup.toFixed(2)}x`
    );
    results.push({
      name: 'BEE.WORKER.TURBO',
      size,
      scenario,
      ...workerTurboStats,
      opsPerSec: Math.round((size / workerTurboStats.mean) * 1000),
    });
  } catch (e) {
    console.log(`SKIPPED (${(e as Error).message})`);
  }
  
  // PISCINA - Skip on Bun (compatibility issues)
  const isBunRuntime = typeof (globalThis as any).Bun !== 'undefined';
  if (isBunRuntime) {
    console.log('    PISCINA:          SKIPPED (Bun incompatible)');
  } else {
    process.stdout.write('    PISCINA:          ');
    try {
      const piscinaTimes = await benchPiscina(Piscina, piscinaWorkerPath, data, piscinaFnName);
      const piscinaStats = stats(piscinaTimes);
      const piscinaSpeedup = rawStats.mean / piscinaStats.mean;
      console.log(
        `${piscinaStats.mean.toFixed(2)}ms ± ${piscinaStats.std.toFixed(2)}ms ` +
        `${piscinaSpeedup >= 1 ? '✅' : '❌'} ${piscinaSpeedup.toFixed(2)}x`
      );
      results.push({
        name: 'PISCINA',
        size,
        scenario,
        ...piscinaStats,
        opsPerSec: Math.round((size / piscinaStats.mean) * 1000),
      });
    } catch (e) {
      console.log(`SKIPPED (${(e as Error).message})`);
    }
  }
  
  return results;
}

async function main() {
  const runtime = typeof (globalThis as any).Bun !== 'undefined' ? 'Bun' : 'Node';
  const __dirname = dirname(fileURLToPath(import.meta.url));
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  BENCHMARK 1: RAW vs BEE.TURBO vs BEE.WORKER.TURBO vs PISCINA');
  console.log(`║  Runtime: ${runtime}`);
  console.log(`║  Workers: ${WORKERS}`);
  console.log(`║  Runs: ${RUNS} (warmup: ${WARMUP})`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  // Import dependencies
  const { beeThreads } = await import('../dist/index.js');
  let Piscina: any;
  try {
    Piscina = (await import('piscina')).default;
  } catch {
    console.log('\n⚠️  Piscina not installed. Run: npm install piscina');
    Piscina = null;
  }
  
  const allResults: BenchResult[] = [];
  
  // Paths
  const beeWorkerHeavy = join(__dirname, 'workers', 'heavy-worker.js');
  const beeWorkerObject = join(__dirname, 'workers', 'object-worker.js');
  const piscinaWorker = join(__dirname, 'workers', 'piscina-worker.js');
  
  // =========================================================================
  // SCENARIO 1: CPU-HEAVY (onde paralelismo DEVE ganhar)
  // =========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('  SCENARIO: CPU-HEAVY (1000 Math iterations per item)');
  console.log('='.repeat(60));
  
  for (const [sizeName, size] of Object.entries(SIZES)) {
    const results = await runScenario(
      `CPU-HEAVY ${sizeName}`,
      'cpu-heavy',
      size,
      beeThreads,
      Piscina,
      () => generateNumbers(size),
      heavyFn,
      'heavyFn',
      beeWorkerHeavy,
      piscinaWorker
    );
    allResults.push(...results);
  }
  
  // =========================================================================
  // SCENARIO 2: CPU-LIGHT (onde overhead pode dominar)
  // =========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('  SCENARIO: CPU-LIGHT (simple x * 2 + 1)');
  console.log('='.repeat(60));
  
  for (const [sizeName, size] of Object.entries(SIZES)) {
    const results = await runScenario(
      `CPU-LIGHT ${sizeName}`,
      'cpu-light',
      size,
      beeThreads,
      Piscina,
      () => generateNumbers(size),
      lightFn,
      'lightFn',
      beeWorkerHeavy, // Same worker, different fn
      piscinaWorker
    );
    allResults.push(...results);
  }
  
  // =========================================================================
  // SCENARIO 3: OBJECT (AutoPack territory)
  // =========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('  SCENARIO: OBJECT TRANSFORM (AutoPack)');
  console.log('='.repeat(60));
  
  for (const [sizeName, size] of Object.entries(SIZES)) {
    const results = await runScenario(
      `OBJECT ${sizeName}`,
      'object',
      size,
      beeThreads,
      Piscina,
      () => generateObjects(size),
      objectFn,
      'objectFn',
      beeWorkerObject,
      piscinaWorker
    );
    allResults.push(...results);
  }
  
  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  
  // Group by scenario
  const scenarios = ['cpu-heavy', 'cpu-light', 'object'];
  for (const scenario of scenarios) {
    console.log(`\n  ${scenario.toUpperCase()}:`);
    const scenarioResults = allResults.filter(r => r.scenario === scenario);
    
    for (const size of Object.values(SIZES)) {
      const sizeResults = scenarioResults.filter(r => r.size === size);
      const raw = sizeResults.find(r => r.name === 'RAW');
      if (!raw) continue;
      
      console.log(`    ${(size / 1000).toFixed(0)}K items:`);
      for (const r of sizeResults) {
        if (r.name === 'RAW') continue;
        const speedup = raw.mean / r.mean;
        console.log(`      ${r.name.padEnd(20)} ${speedup.toFixed(2)}x ${speedup >= 1.2 ? '✅' : speedup >= 1 ? '→' : '❌'}`);
      }
    }
  }
  
  // Export results as JSON
  const outputPath = join(__dirname, `results-${runtime.toLowerCase()}.json`);
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify({ runtime, workers: WORKERS, results: allResults }, null, 2));
  console.log(`\n📊 Results saved to: ${outputPath}`);
  
  // Shutdown
  await beeThreads.shutdown();
  console.log('\n✅ Benchmark complete!');
}

main().catch(console.error);

