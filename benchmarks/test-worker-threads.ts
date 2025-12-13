/**
 * Minimal test for worker_threads on Bun
 */

import { Worker, isMainThread, parentPort } from 'worker_threads';

console.log('=== WORKER_THREADS TEST ===');
console.log(`Runtime: ${typeof (globalThis as any).Bun !== 'undefined' ? 'Bun' : 'Node'}`);
console.log(`isMainThread: ${isMainThread}`);

if (isMainThread) {
  console.log('\n1. Creating inline worker...');
  
  const workerCode = `
    const { parentPort } = require('worker_threads');
    console.log('[Worker] Started');
    parentPort.on('message', (msg) => {
      console.log('[Worker] Received:', msg);
      parentPort.postMessage({ result: msg.value * 2 });
    });
  `;

  try {
    const worker = new Worker(workerCode, { eval: true });
    console.log('   ✅ Worker created');

    worker.on('message', (msg) => {
      console.log('2. Received from worker:', msg);
      console.log('   ✅ Worker communication works!');
      worker.terminate();
      console.log('\n✅ ALL TESTS PASSED!');
    });

    worker.on('error', (err) => {
      console.error('   ❌ Worker error:', err);
    });

    worker.on('exit', (code) => {
      console.log(`   Worker exited with code ${code}`);
    });

    console.log('   Sending message to worker...');
    worker.postMessage({ value: 21 });
    
    // Timeout
    setTimeout(() => {
      console.error('\n❌ TIMEOUT: Worker did not respond in 5s');
      worker.terminate();
      process.exit(1);
    }, 5000);

  } catch (e) {
    console.error('❌ Failed to create worker:', e);
  }
}
