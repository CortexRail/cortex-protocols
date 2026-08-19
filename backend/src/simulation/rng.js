/**
 * Deterministic pseudo-random number generation for simulation runs.
 *
 * Every random decision a synthetic agent makes goes through one of these, so a
 * run is fully reproducible from its seed. A failing nightly run can be replayed
 * locally by passing the seed it printed.
 */

/**
 * Creates a seeded PRNG (mulberry32).
 *
 * @param {number} seed - Any 32-bit integer.
 * @returns {() => number} A function returning a float in [0, 1).
 */
function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derives an independent child stream from a parent seed and an index.
 *
 * Agents in a swarm each get their own stream so adding an agent does not
 * reshuffle the decisions every other agent makes.
 *
 * @param {number} seed
 * @param {number} index
 * @returns {() => number}
 */
function deriveRng(seed, index) {
  return createRng((Math.imul(seed >>> 0, 0x9e3779b1) + Math.imul(index + 1, 0x85ebca6b)) >>> 0);
}

/**
 * Returns an integer in [min, max] inclusive.
 *
 * @param {() => number} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function intBetween(rng, min, max) {
  if (max <= min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Picks one element of `items` uniformly at random.
 *
 * @template T
 * @param {() => number} rng
 * @param {T[]} items
 * @returns {T | null}
 */
function pick(rng, items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(rng() * items.length) % items.length];
}

module.exports = { createRng, deriveRng, intBetween, pick };
