/**
 * BENCHMARK 2: SERIALIZATION STRATEGIES
 * 
 * Objetivo: Comparar diferentes métodos de serialização para workers
 * 
 * Métodos testados:
 * - structuredClone: Nativo do V8 (baseline para postMessage)
 * - AutoPack: Serialização customizada para TypedArrays
 * - SharedArrayBuffer: Zero-copy para TypedArrays numéricos
 * - JSON: Fallback tradicional
 * 
 * Cenários:
 * - NUMBER[]: Array de números
 * - STRING[]: Array de strings
 * - OBJECT[]: Array de objetos simples
 * - NESTED[]: Array de objetos aninhados
 */

import { performance } from 'perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// ============================================================================
// CONFIG
// ============================================================================

const RUNS = 10;
const WARMUP = 3;

const SIZES = {
  '1K': 1_000,
  '10K': 10_000,
  '100K': 100_000,
  '500K': 500_000,
};

// ============================================================================
// TYPES
// ============================================================================

interface BenchResult {
  method: string;
  dataType: string;
  size: number;
  packTime: number;
  unpackTime: number;
  totalTime: number;
  throughputMBps: number;
}

interface TestObject {
  id: number;
  value: number;
  name: string;
  active: boolean;
}

interface NestedObject {
  id: number;
  user: { name: string; age: number };
  meta: { score: number; active: boolean };
}

// ============================================================================
// STATS
// ============================================================================

function stats(times: number[]): { mean: number; std: number } {
  const n = times.length;
  const mean = times.reduce((a, b) => a + b, 0) / n;
  const variance = times.reduce((sum, t) => sum + (t - mean) ** 2, 0) / n;
  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(Math.sqrt(variance) * 100) / 100,
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

function generateStrings(size: number): string[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = `user_${i}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return arr;
}

function generateObjects(size: number): TestObject[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = {
      id: i,
      value: Math.random() * 1000,
      name: `user_${i}`,
      active: i % 2 === 0,
    };
  }
  return arr;
}

function generateNestedObjects(size: number): NestedObject[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) {
    arr[i] = {
      id: i,
      user: { name: `User_${i}`, age: 20 + (i % 50) },
      meta: { score: Math.random() * 100, active: i % 2 === 0 },
    };
  }
  return arr;
}

// ============================================================================
// ESTIMATE DATA SIZE
// ============================================================================

function estimateSize(data: unknown[]): number {
  // Rough estimate in bytes
  const sample = JSON.stringify(data.slice(0, 100));
  return (sample.length / 100) * data.length;
}

// ============================================================================
// BENCHMARK FUNCTIONS
// ============================================================================

async function benchStructuredClone(data: unknown[]): Promise<{ packTime: number; unpackTime: number }> {
  const packTimes: number[] = [];
  const unpackTimes: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const cloned = structuredClone(data);
    structuredClone(cloned);
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    // Pack (serialize)
    let start = performance.now();
    const cloned = structuredClone(data);
    packTimes.push(performance.now() - start);
    
    // Unpack (deserialize) - simulate receiving
    start = performance.now();
    structuredClone(cloned);
    unpackTimes.push(performance.now() - start);
  }
  
  return {
    packTime: stats(packTimes).mean,
    unpackTime: stats(unpackTimes).mean,
  };
}

async function benchJSON(data: unknown[]): Promise<{ packTime: number; unpackTime: number }> {
  const packTimes: number[] = [];
  const unpackTimes: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const json = JSON.stringify(data);
    JSON.parse(json);
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    let start = performance.now();
    const json = JSON.stringify(data);
    packTimes.push(performance.now() - start);
    
    start = performance.now();
    JSON.parse(json);
    unpackTimes.push(performance.now() - start);
  }
  
  return {
    packTime: stats(packTimes).mean,
    unpackTime: stats(unpackTimes).mean,
  };
}

async function benchAutoPack(
  data: unknown[],
  autoPack: any,
  autoUnpack: any
): Promise<{ packTime: number; unpackTime: number }> {
  const packTimes: number[] = [];
  const unpackTimes: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const packed = autoPack(data);
    autoUnpack(packed);
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    let start = performance.now();
    const packed = autoPack(data);
    packTimes.push(performance.now() - start);
    
    start = performance.now();
    autoUnpack(packed);
    unpackTimes.push(performance.now() - start);
  }
  
  return {
    packTime: stats(packTimes).mean,
    unpackTime: stats(unpackTimes).mean,
  };
}

async function benchPackNumberArray(
  data: number[],
  packNumberArray: any,
  unpackNumberArray: any
): Promise<{ packTime: number; unpackTime: number }> {
  const packTimes: number[] = [];
  const unpackTimes: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const packed = packNumberArray(data);
    unpackNumberArray(packed);
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    let start = performance.now();
    const packed = packNumberArray(data);
    packTimes.push(performance.now() - start);
    
    start = performance.now();
    unpackNumberArray(packed);
    unpackTimes.push(performance.now() - start);
  }
  
  return {
    packTime: stats(packTimes).mean,
    unpackTime: stats(unpackTimes).mean,
  };
}

async function benchPackStringArray(
  data: string[],
  packStringArray: any,
  unpackStringArray: any
): Promise<{ packTime: number; unpackTime: number }> {
  const packTimes: number[] = [];
  const unpackTimes: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const packed = packStringArray(data);
    unpackStringArray(packed);
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    let start = performance.now();
    const packed = packStringArray(data);
    packTimes.push(performance.now() - start);
    
    start = performance.now();
    unpackStringArray(packed);
    unpackTimes.push(performance.now() - start);
  }
  
  return {
    packTime: stats(packTimes).mean,
    unpackTime: stats(unpackTimes).mean,
  };
}

async function benchSharedArrayBuffer(data: number[]): Promise<{ packTime: number; unpackTime: number }> {
  const packTimes: number[] = [];
  const unpackTimes: number[] = [];
  
  // Warmup
  for (let i = 0; i < WARMUP; i++) {
    const sab = new SharedArrayBuffer(data.length * 8);
    const view = new Float64Array(sab);
    for (let j = 0; j < data.length; j++) view[j] = data[j];
    // Reading back
    const result = new Array(data.length);
    for (let j = 0; j < data.length; j++) result[j] = view[j];
  }
  
  // Runs
  for (let i = 0; i < RUNS; i++) {
    // Pack: copy to SharedArrayBuffer
    let start = performance.now();
    const sab = new SharedArrayBuffer(data.length * 8);
    const view = new Float64Array(sab);
    for (let j = 0; j < data.length; j++) view[j] = data[j];
    packTimes.push(performance.now() - start);
    
    // Unpack: read from SharedArrayBuffer
    start = performance.now();
    const result = new Array(data.length);
    for (let j = 0; j < data.length; j++) result[j] = view[j];
    unpackTimes.push(performance.now() - start);
  }
  
  return {
    packTime: stats(packTimes).mean,
    unpackTime: stats(unpackTimes).mean,
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function runDataTypeBenchmark(
  dataType: string,
  sizes: Record<string, number>,
  generator: (size: number) => unknown[],
  autoPackModule: any,
  supportsAutoPack: boolean,
  supportsPackArray: boolean,
  supportsSharedArrayBuffer: boolean
): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  
  console.log('\n' + '='.repeat(60));
  console.log(`  DATA TYPE: ${dataType}`);
  console.log('='.repeat(60));
  
  for (const [sizeName, size] of Object.entries(sizes)) {
    const data = generator(size);
    const dataSize = estimateSize(data);
    
    console.log(`\n  Size: ${sizeName} (~${(dataSize / 1024).toFixed(0)}KB)`);
    console.log('  ' + '-'.repeat(50));
    
    // structuredClone
    process.stdout.write('    structuredClone:    ');
    const scResult = await benchStructuredClone(data);
    const scTotal = scResult.packTime + scResult.unpackTime;
    console.log(`pack=${scResult.packTime.toFixed(2)}ms unpack=${scResult.unpackTime.toFixed(2)}ms total=${scTotal.toFixed(2)}ms`);
    results.push({
      method: 'structuredClone',
      dataType,
      size,
      ...scResult,
      totalTime: scTotal,
      throughputMBps: (dataSize / 1024 / 1024) / (scTotal / 1000),
    });
    
    // JSON
    process.stdout.write('    JSON:               ');
    const jsonResult = await benchJSON(data);
    const jsonTotal = jsonResult.packTime + jsonResult.unpackTime;
    const jsonSpeedup = scTotal / jsonTotal;
    console.log(
      `pack=${jsonResult.packTime.toFixed(2)}ms unpack=${jsonResult.unpackTime.toFixed(2)}ms ` +
      `total=${jsonTotal.toFixed(2)}ms ${jsonSpeedup >= 1 ? '✅' : '❌'} ${jsonSpeedup.toFixed(2)}x`
    );
    results.push({
      method: 'JSON',
      dataType,
      size,
      ...jsonResult,
      totalTime: jsonTotal,
      throughputMBps: (dataSize / 1024 / 1024) / (jsonTotal / 1000),
    });
    
    // AutoPack (for objects)
    if (supportsAutoPack) {
      process.stdout.write('    AutoPack:           ');
      try {
        const apResult = await benchAutoPack(data, autoPackModule.autoPack, autoPackModule.autoUnpack);
        const apTotal = apResult.packTime + apResult.unpackTime;
        const apSpeedup = scTotal / apTotal;
        console.log(
          `pack=${apResult.packTime.toFixed(2)}ms unpack=${apResult.unpackTime.toFixed(2)}ms ` +
          `total=${apTotal.toFixed(2)}ms ${apSpeedup >= 1 ? '✅' : '❌'} ${apSpeedup.toFixed(2)}x`
        );
        results.push({
          method: 'AutoPack',
          dataType,
          size,
          ...apResult,
          totalTime: apTotal,
          throughputMBps: (dataSize / 1024 / 1024) / (apTotal / 1000),
        });
      } catch (e) {
        console.log(`SKIPPED (${(e as Error).message})`);
      }
    }
    
    // packNumberArray (for numbers)
    if (supportsPackArray && dataType === 'number[]') {
      process.stdout.write('    packNumberArray:    ');
      const pnaResult = await benchPackNumberArray(
        data as number[],
        autoPackModule.packNumberArray,
        autoPackModule.unpackNumberArray
      );
      const pnaTotal = pnaResult.packTime + pnaResult.unpackTime;
      const pnaSpeedup = scTotal / pnaTotal;
      console.log(
        `pack=${pnaResult.packTime.toFixed(2)}ms unpack=${pnaResult.unpackTime.toFixed(2)}ms ` +
        `total=${pnaTotal.toFixed(2)}ms ${pnaSpeedup >= 1 ? '✅' : '❌'} ${pnaSpeedup.toFixed(2)}x`
      );
      results.push({
        method: 'packNumberArray',
        dataType,
        size,
        ...pnaResult,
        totalTime: pnaTotal,
        throughputMBps: (dataSize / 1024 / 1024) / (pnaTotal / 1000),
      });
    }
    
    // packStringArray (for strings)
    if (supportsPackArray && dataType === 'string[]') {
      process.stdout.write('    packStringArray:    ');
      const psaResult = await benchPackStringArray(
        data as string[],
        autoPackModule.packStringArray,
        autoPackModule.unpackStringArray
      );
      const psaTotal = psaResult.packTime + psaResult.unpackTime;
      const psaSpeedup = scTotal / psaTotal;
      console.log(
        `pack=${psaResult.packTime.toFixed(2)}ms unpack=${psaResult.unpackTime.toFixed(2)}ms ` +
        `total=${psaTotal.toFixed(2)}ms ${psaSpeedup >= 1 ? '✅' : '❌'} ${psaSpeedup.toFixed(2)}x`
      );
      results.push({
        method: 'packStringArray',
        dataType,
        size,
        ...psaResult,
        totalTime: psaTotal,
        throughputMBps: (dataSize / 1024 / 1024) / (psaTotal / 1000),
      });
    }
    
    // SharedArrayBuffer (for numbers only)
    if (supportsSharedArrayBuffer && dataType === 'number[]') {
      process.stdout.write('    SharedArrayBuffer:  ');
      const sabResult = await benchSharedArrayBuffer(data as number[]);
      const sabTotal = sabResult.packTime + sabResult.unpackTime;
      const sabSpeedup = scTotal / sabTotal;
      console.log(
        `pack=${sabResult.packTime.toFixed(2)}ms unpack=${sabResult.unpackTime.toFixed(2)}ms ` +
        `total=${sabTotal.toFixed(2)}ms ${sabSpeedup >= 1 ? '✅' : '❌'} ${sabSpeedup.toFixed(2)}x`
      );
      results.push({
        method: 'SharedArrayBuffer',
        dataType,
        size,
        ...sabResult,
        totalTime: sabTotal,
        throughputMBps: (dataSize / 1024 / 1024) / (sabTotal / 1000),
      });
    }
  }
  
  return results;
}

async function main() {
  const runtime = typeof (globalThis as any).Bun !== 'undefined' ? 'Bun' : 'Node';
  const __dirname = dirname(fileURLToPath(import.meta.url));
  
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  BENCHMARK 2: SERIALIZATION STRATEGIES                     ║');
  console.log(`║  Runtime: ${runtime}`);
  console.log(`║  Runs: ${RUNS} (warmup: ${WARMUP})`);
  console.log('╚════════════════════════════════════════════════════════════╝');
  
  // Import AutoPack
  const autoPackModule = await import('../dist/autopack.js');
  
  const allResults: BenchResult[] = [];
  
  // NUMBER[]
  allResults.push(...await runDataTypeBenchmark(
    'number[]',
    SIZES,
    generateNumbers,
    autoPackModule,
    false, // AutoPack is for objects
    true,  // packNumberArray
    true   // SharedArrayBuffer
  ));
  
  // STRING[]
  allResults.push(...await runDataTypeBenchmark(
    'string[]',
    SIZES,
    generateStrings,
    autoPackModule,
    false, // AutoPack is for objects
    true,  // packStringArray
    false  // SharedArrayBuffer not for strings
  ));
  
  // OBJECT[]
  allResults.push(...await runDataTypeBenchmark(
    'object[]',
    SIZES,
    generateObjects,
    autoPackModule,
    true,  // AutoPack
    false, // packNumberArray not for objects
    false  // SharedArrayBuffer not for objects
  ));
  
  // NESTED OBJECT[]
  allResults.push(...await runDataTypeBenchmark(
    'nested[]',
    SIZES,
    generateNestedObjects,
    autoPackModule,
    true,  // AutoPack
    false,
    false
  ));
  
  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY: Best method per data type and size');
  console.log('='.repeat(60));
  
  const dataTypes = ['number[]', 'string[]', 'object[]', 'nested[]'];
  for (const dt of dataTypes) {
    console.log(`\n  ${dt}:`);
    const dtResults = allResults.filter(r => r.dataType === dt);
    
    for (const [sizeName, size] of Object.entries(SIZES)) {
      const sizeResults = dtResults.filter(r => r.size === size);
      if (sizeResults.length === 0) continue;
      
      // Find best
      sizeResults.sort((a, b) => a.totalTime - b.totalTime);
      const best = sizeResults[0];
      const baseline = sizeResults.find(r => r.method === 'structuredClone')!;
      const speedup = baseline.totalTime / best.totalTime;
      
      console.log(`    ${sizeName}: ${best.method} (${speedup.toFixed(2)}x vs structuredClone)`);
    }
  }
  
  // Export results
  const outputPath = join(__dirname, `serialization-${runtime.toLowerCase()}.json`);
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify({ runtime, results: allResults }, null, 2));
  console.log(`\n📊 Results saved to: ${outputPath}`);
  
  console.log('\n✅ Serialization benchmark complete!');
}

main().catch(console.error);

