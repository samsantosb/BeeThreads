/**
 * Heavy computation worker for bee.worker().turbo()
 * 
 * Exports a function that processes a single item with CPU-heavy operations
 */

// CPU-HEAVY: 1000 iterations of Math operations
function heavyFn(x) {
  let result = x;
  for (let i = 0; i < 1000; i++) {
    result = Math.sin(result) * Math.cos(result) + Math.sqrt(Math.abs(result));
  }
  return result;
}

// CPU-LIGHT: Simple operation
function lightFn(x) {
  return x * 2 + 1;
}

// Default export: processes array chunk
module.exports = function(chunk) {
  // The function name could be passed, but for simplicity we use heavyFn
  return chunk.map(heavyFn);
};

