/**
 * Piscina worker for benchmark comparison
 * 
 * Accepts { chunk, fnName } and processes accordingly
 */

// CPU-HEAVY
function heavyFn(x) {
  let result = x;
  for (let i = 0; i < 1000; i++) {
    result = Math.sin(result) * Math.cos(result) + Math.sqrt(Math.abs(result));
  }
  return result;
}

// CPU-LIGHT
function lightFn(x) {
  return x * 2 + 1;
}

// OBJECT
function objectFn(obj) {
  return {
    ...obj,
    computed: obj.value * obj.score,
    tier: obj.active ? 'premium' : 'standard',
    hash: obj.id * 31,
  };
}

module.exports = function({ chunk, fnName }) {
  switch (fnName) {
    case 'heavyFn':
      return chunk.map(heavyFn);
    case 'lightFn':
      return chunk.map(lightFn);
    case 'objectFn':
      return chunk.map(objectFn);
    default:
      throw new Error(`Unknown function: ${fnName}`);
  }
};

