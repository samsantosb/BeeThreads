/**
 * Object transformation worker for bee.worker().turbo()
 * 
 * Exports a function that processes object arrays
 */

function objectFn(obj) {
  return {
    ...obj,
    computed: obj.value * obj.score,
    tier: obj.active ? 'premium' : 'standard',
    hash: obj.id * 31,
  };
}

// Default export: processes array chunk
module.exports = function(chunk) {
  return chunk.map(objectFn);
};

