/**
 * BENCHMARK DIAGNÓSTICO: Onde está o overhead?
 * 
 * Objetivo: Isolar cada etapa do pipeline beeThreads.turbo() para entender
 * por que AutoPack performa bem sozinho mas mal integrado.
 * 
 * Etapas do pipeline beeThreads.turbo():
 * 1. Chunking (dividir array em N partes)
 * 2. AutoPack (serializar cada chunk)
 * 3. postMessage (enviar para worker)
 * 4. Worker: receber + deserializar
 * 5. Worker: compilar função (new Function)
 * 6. Worker: executar map()
 * 7. Worker: serializar resultado
 * 8. postMessage (enviar de volta)
 * 9. Main: receber + deserializar
 * 10. Concatenar resultados
 * 
 * Este benchmark mede cada etapa isoladamente!
 */

import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// CONFIG
// ============================================================================

const RUNS = 5;
const SIZE = 100_000;
const WORKERS = 4;

// ============================================================================
// DATA
// ============================================================================

interface TestObject {
  id: number;
  value: number;
  name: string;
  active: boolean;
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

function generateNumbers(size: number): number[] {
  const arr = new Array(size);
  for (let i = 0; i < size; i++) arr[i] = Math.random() * 1000;
  return arr;
}

// ============================================================================
// TRANSFORM FUNCTIONS
// ============================================================================

const objectFn = (obj: TestObject) => ({
  ...obj,
  computed: obj.value * 2,
  tier: obj.active ? 'premium' : 'standard',
});

const heavyFn = (x: number) => {
  let result = x;
  for (let i = 0; i < 500; i++) {
    result = Math.sin(result) * Math.cos(result) + Math.sqrt(Math.abs(result));
  }
  return result;
};

// ============================================================================
// BENCHMARK HELPERS
// ============================================================================

function measure(name: string, fn: () => void, runs = RUNS): number {
  // Warmup
  for (let i = 0; i < 2; i++) fn();
  
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return Math.round(mean * 100) / 100;
}

async function measureAsync(name: string, fn: () => Promise<void>, runs = RUNS): Promise<number> {
  // Warmup
  for (let i = 0; i < 2; i++) await fn();
  
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return Math.round(mean * 100) / 100;
}

// ============================================================================
// ETAPA 1: CHUNKING
// ============================================================================

function benchChunking<T>(data: T[]): number {
  return measure('Chunking', () => {
    const chunkSize = Math.ceil(data.length / WORKERS);
    const chunks: T[][] = [];
    for (let i = 0; i < data.length; i += chunkSize) {
      chunks.push(data.slice(i, i + chunkSize));
    }
  });
}

// ============================================================================
// ETAPA 2: AUTOPACK SERIALIZATION
// ============================================================================

async function benchAutoPack(data: TestObject[]): Promise<{ pack: number; unpack: number }> {
  const { autoPack, autoUnpack } = await import('../dist/autopack.js');
  
  let packed: any;
  const packTime = measure('AutoPack.pack', () => {
    packed = autoPack(data);
  });
  
  const unpackTime = measure('AutoPack.unpack', () => {
    autoUnpack(packed);
  });
  
  return { pack: packTime, unpack: unpackTime };
}

// ============================================================================
// ETAPA 3: STRUCTURED CLONE (simula postMessage)
// ============================================================================

function benchStructuredClone<T>(data: T[]): { pack: number; unpack: number } {
  let cloned: any;
  const packTime = measure('structuredClone', () => {
    cloned = structuredClone(data);
  });
  
  const unpackTime = measure('structuredClone (back)', () => {
    structuredClone(cloned);
  });
  
  return { pack: packTime, unpack: unpackTime };
}

// ============================================================================
// ETAPA 4: AUTOPACK + STRUCTURED CLONE (como beeThreads faz)
// ============================================================================

async function benchAutoPackPlusClone(data: TestObject[]): Promise<{ total: number }> {
  const { autoPack, autoUnpack, getTransferables } = await import('../dist/autopack.js');
  
  const total = measure('AutoPack + structuredClone', () => {
    // Pack
    const packed = autoPack(data);
    // Clone (simula postMessage sem transferables)
    const cloned = structuredClone(packed);
    // Unpack
    autoUnpack(cloned);
  });
  
  return { total };
}

// ============================================================================
// ETAPA 5: FUNCTION SERIALIZATION
// ============================================================================

function benchFunctionSerialization(): { serialize: number; compile: number } {
  const fn = (x: number) => x * 2 + Math.sin(x);
  
  let fnString: string;
  const serializeTime = measure('Function.toString', () => {
    fnString = fn.toString();
  });
  
  const compileTime = measure('new Function', () => {
    new Function('return ' + fnString)();
  });
  
  return { serialize: serializeTime, compile: compileTime };
}

// ============================================================================
// ETAPA 6: RAW MAP (baseline)
// ============================================================================

function benchRawMap<T, R>(data: T[], fn: (x: T) => R): number {
  return measure('Array.map', () => {
    data.map(fn);
  });
}

// ============================================================================
// ETAPA 7: WORKER ROUND-TRIP (real postMessage)
// ============================================================================

async function benchWorkerRoundTrip<T>(data: T[]): Promise<number> {
  // Create a simple echo worker
  const workerCode = `
    const { parentPort } = require('worker_threads');
    parentPort.on('message', (msg) => {
      parentPort.postMessage(msg);
    });
  `;
  
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  const worker = new Worker(
    `data:application/javascript,${encodeURIComponent(workerCode)}`,
    { eval: true }
  );
  
  const roundTrip = async () => {
    return new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
      worker.postMessage(data);
    });
  };
  
  const time = await measureAsync('Worker round-trip', roundTrip);
  
  worker.terminate();
  return time;
}

// ============================================================================
// ETAPA 8: WORKER + MAP (real computation)
// ============================================================================

async function benchWorkerMap(data: number[]): Promise<number> {
  const workerCode = `
    const { parentPort } = require('worker_threads');
    parentPort.on('message', (msg) => {
      const result = msg.map(x => {
        let r = x;
        for (let i = 0; i < 500; i++) {
          r = Math.sin(r) * Math.cos(r) + Math.sqrt(Math.abs(r));
        }
        return r;
      });
      parentPort.postMessage(result);
    });
  `;
  
  const worker = new Worker(
    `data:application/javascript,${encodeURIComponent(workerCode)}`,
    { eval: true }
  );
  
  const compute = async () => {
    return new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
      worker.postMessage(data);
    });
  };
  
  const time = await measureAsync('Worker map (heavy)', compute);
  
  worker.terminate();
  return time;
}

// ============================================================================
// ETAPA 9: CONCATENAÇÃO
// ============================================================================

function benchConcat<T>(chunks: T[][]): number {
  return measure('Array.concat', () => {
    const result: T[] = [];
    for (const chunk of chunks) {
      result.push(...chunk);
    }
  });
}

// ============================================================================
// FULL PIPELINE SIMULATION
// ============================================================================

async function benchFullPipeline(data: TestObject[]): Promise<{
  chunking: number;
  packing: number;
  postMessage: number;
  unpacking: number;
  compute: number;
  concat: number;
  total: number;
}> {
  const { autoPack, autoUnpack } = await import('../dist/autopack.js');
  
  const chunkSize = Math.ceil(data.length / WORKERS);
  const chunks: TestObject[][] = [];
  
  // Chunking
  let start = performance.now();
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  const chunking = performance.now() - start;
  
  // Packing (all chunks)
  start = performance.now();
  const packed = chunks.map(chunk => autoPack(chunk));
  const packing = performance.now() - start;
  
  // Simulate postMessage (structuredClone)
  start = performance.now();
  const cloned = packed.map(p => structuredClone(p));
  const postMessage = performance.now() - start;
  
  // Unpacking
  start = performance.now();
  const unpacked = cloned.map(p => autoUnpack(p));
  const unpacking = performance.now() - start;
  
  // Compute
  start = performance.now();
  const results = unpacked.map(chunk => 
    (chunk as TestObject[]).map(obj => ({
      ...obj,
      computed: obj.value * 2,
    }))
  );
  const compute = performance.now() - start;
  
  // Concat
  start = performance.now();
  const final: any[] = [];
  for (const r of results) {
    final.push(...r);
  }
  const concat = performance.now() - start;
  
  return {
    chunking: Math.round(chunking * 100) / 100,
    packing: Math.round(packing * 100) / 100,
    postMessage: Math.round(postMessage * 100) / 100,
    unpacking: Math.round(unpacking * 100) / 100,
    compute: Math.round(compute * 100) / 100,
    concat: Math.round(concat * 100) / 100,
    total: Math.round((chunking + packing + postMessage + unpacking + compute + concat) * 100) / 100,
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  BENCHMARK DIAGNÓSTICO: Onde está o overhead?              ║');
  console.log(`║  Size: ${SIZE.toLocaleString()} items | Workers: ${WORKERS}                       ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  const objects = generateObjects(SIZE);
  const numbers = generateNumbers(SIZE);
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  BASELINE: Raw single-thread');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const rawLight = benchRawMap(objects, objectFn);
  console.log(`  RAW map (light):     ${rawLight}ms`);
  
  const rawHeavy = benchRawMap(numbers, heavyFn);
  console.log(`  RAW map (heavy):     ${rawHeavy}ms`);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ETAPA 1: Chunking');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const chunkTime = benchChunking(objects);
  console.log(`  Chunking ${WORKERS} chunks: ${chunkTime}ms`);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ETAPA 2: Serialização');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const scTimes = benchStructuredClone(objects);
  console.log(`  structuredClone:     pack=${scTimes.pack}ms unpack=${scTimes.unpack}ms total=${scTimes.pack + scTimes.unpack}ms`);
  
  const apTimes = await benchAutoPack(objects);
  console.log(`  AutoPack:            pack=${apTimes.pack}ms unpack=${apTimes.unpack}ms total=${apTimes.pack + apTimes.unpack}ms`);
  
  const comboTimes = await benchAutoPackPlusClone(objects);
  console.log(`  AutoPack+Clone:      total=${comboTimes.total}ms ⚠️  DOUBLE SERIALIZATION!`);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ETAPA 3: Function serialization');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const fnTimes = benchFunctionSerialization();
  console.log(`  fn.toString():       ${fnTimes.serialize}ms`);
  console.log(`  new Function():      ${fnTimes.compile}ms`);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ETAPA 4: Worker communication');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    const workerRT = await benchWorkerRoundTrip(objects);
    console.log(`  Worker round-trip:   ${workerRT}ms (send + receive ${SIZE} objects)`);
    
    const workerMap = await benchWorkerMap(numbers);
    console.log(`  Worker map (heavy):  ${workerMap}ms`);
  } catch (e) {
    console.log(`  Worker test skipped: ${(e as Error).message}`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  ETAPA 5: Concatenação');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const chunkSize = Math.ceil(SIZE / WORKERS);
  const chunks: TestObject[][] = [];
  for (let i = 0; i < objects.length; i += chunkSize) {
    chunks.push(objects.slice(i, i + chunkSize));
  }
  const concatTime = benchConcat(chunks);
  console.log(`  Concat ${WORKERS} chunks:    ${concatTime}ms`);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FULL PIPELINE SIMULATION');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const pipeline = await benchFullPipeline(objects);
  console.log(`  Chunking:            ${pipeline.chunking}ms`);
  console.log(`  Packing (AutoPack):  ${pipeline.packing}ms`);
  console.log(`  postMessage (clone): ${pipeline.postMessage}ms`);
  console.log(`  Unpacking:           ${pipeline.unpacking}ms`);
  console.log(`  Compute:             ${pipeline.compute}ms`);
  console.log(`  Concat:              ${pipeline.concat}ms`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  TOTAL OVERHEAD:      ${pipeline.total}ms`);
  console.log(`  RAW (single-thread): ${rawLight}ms`);
  console.log(`  ─────────────────────────────────`);
  
  const overhead = pipeline.total - pipeline.compute;
  const speedup = rawLight / pipeline.compute;
  console.log(`  Overhead (sem compute): ${overhead.toFixed(2)}ms`);
  console.log(`  Compute speedup:        ${speedup.toFixed(2)}x`);
  
  if (overhead > rawLight) {
    console.log(`\n  ⚠️  OVERHEAD (${overhead.toFixed(2)}ms) > RAW (${rawLight}ms)`);
    console.log(`  🔴 Paralelismo NÃO compensa para operações leves!`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  CONCLUSÃO');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const bottlenecks = [
    { name: 'Chunking', time: pipeline.chunking },
    { name: 'Packing', time: pipeline.packing },
    { name: 'postMessage', time: pipeline.postMessage },
    { name: 'Unpacking', time: pipeline.unpacking },
    { name: 'Concat', time: pipeline.concat },
  ].sort((a, b) => b.time - a.time);
  
  console.log('  Maiores gargalos (overhead):');
  for (const b of bottlenecks) {
    const pct = ((b.time / pipeline.total) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(Number(pct) / 5));
    console.log(`    ${b.name.padEnd(15)} ${b.time.toFixed(2).padStart(8)}ms (${pct.padStart(5)}%) ${bar}`);
  }
  
  console.log('\n  Para paralelismo compensar, compute deve ser >> overhead');
  console.log(`  Compute atual:   ${pipeline.compute}ms`);
  console.log(`  Overhead atual:  ${overhead.toFixed(2)}ms`);
  console.log(`  Ratio:           ${(pipeline.compute / overhead).toFixed(2)}x`);
  
  if (pipeline.compute < overhead) {
    console.log(`\n  💡 RECOMENDAÇÃO: Use operações mais pesadas (CPU-heavy)`);
    console.log(`     ou arrays maiores para compensar o overhead.`);
  }
  
  console.log('\n✅ Diagnóstico completo!');
}

main().catch(console.error);
