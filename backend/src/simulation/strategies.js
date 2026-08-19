/**
 * Behaviour strategies for synthetic agents.
 *
 * Every strategy is a plain object of pure decision functions. Nothing here
 * touches the network, the clock, or `Math.random` — randomness arrives as an
 * injected `rng`, so each strategy's decision logic is unit-testable in
 * isolation and a whole swarm run replays identically from its seed.
 *
 * A strategy answers five questions:
 *
 *   chooseAsset(candidates, memory)  → which asset to buy from next
 *   depositXlm(asset)                → how much to escrow when opening a stream
 *   callDelayMs(rng)                 → how long to wait between metered calls
 *   responseDelayMs(rng)             → extra latency this agent injects itself
 *   shouldDropCall(rng)              → whether this agent drops its own call
 *
 * The last two model a badly-behaved counterparty. `FlakySeller` is the only
 * strategy that returns anything but zero/false for them.
 */

const { intBetween } = require("./rng");

/** @typedef {{ id: number|string, price: number, owner: string }} Candidate */
/** @typedef {{ sellersUsed: Set<string>, callsMade: number }} AgentMemory */

/** Shared no-op behaviour every strategy inherits unless it overrides it. */
const baseStrategy = {
  depositXlm() {
    return 1;
  },
  callDelayMs(rng) {
    return intBetween(rng, 50, 250);
  },
  responseDelayMs() {
    return 0;
  },
  shouldDropCall() {
    return false;
  },
  maxCalls() {
    return 20;
  },
};

/** Returns the cheapest candidate, breaking ties on the lowest id. */
function cheapest(candidates) {
  if (!candidates || candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => {
    if (candidate.price < best.price) return candidate;
    if (candidate.price === best.price && String(candidate.id) < String(best.id)) {
      return candidate;
    }
    return best;
  });
}

/**
 * Always takes the cheapest quote on offer.
 *
 * Models the price-sensitive buyer that keeps the marketplace's cheapest
 * sellers saturated and never builds a relationship.
 */
const GreedyBuyer = {
  ...baseStrategy,
  name: "GreedyBuyer",
  chooseAsset(candidates) {
    return cheapest(candidates);
  },
};

/**
 * Sticks with sellers it has bought from before.
 *
 * Falls back to the cheapest option only when none of its known sellers are on
 * offer, which is what makes it a different load pattern from `GreedyBuyer`:
 * its traffic concentrates over time instead of chasing price.
 */
const LoyalBuyer = {
  ...baseStrategy,
  name: "LoyalBuyer",
  chooseAsset(candidates, memory) {
    if (!candidates || candidates.length === 0) return null;
    const known = candidates.filter((c) => memory?.sellersUsed?.has(c.owner));
    return known.length > 0 ? cheapest(known) : cheapest(candidates);
  },
};

/**
 * Randomly delays or drops its own protocol calls.
 *
 * Stands in for an unreliable counterparty: roughly a quarter of its calls
 * never complete, and the ones that do carry up to two seconds of extra
 * latency. The swarm should still settle every one of its streams.
 */
const FlakySeller = {
  ...baseStrategy,
  name: "FlakySeller",
  /** Fraction of calls that are dropped rather than answered. */
  dropRate: 0.25,
  chooseAsset(candidates) {
    return cheapest(candidates);
  },
  responseDelayMs(rng) {
    return intBetween(rng, 0, 2000);
  },
  shouldDropCall(rng) {
    return rng() < FlakySeller.dropRate;
  },
  maxCalls() {
    return 10;
  },
};

/**
 * Maximises metered calls per second.
 *
 * No delay between calls and a much larger call budget, so a swarm containing
 * these is what puts the metering engine and the settlement batcher under
 * throughput pressure.
 */
const HighVolumeCaller = {
  ...baseStrategy,
  name: "HighVolumeCaller",
  chooseAsset(candidates) {
    return cheapest(candidates);
  },
  depositXlm() {
    return 5;
  },
  callDelayMs() {
    return 0;
  },
  maxCalls() {
    return 200;
  },
};

/** Every strategy, keyed by the name a swarm config refers to it by. */
const STRATEGIES = {
  GreedyBuyer,
  LoyalBuyer,
  FlakySeller,
  HighVolumeCaller,
};

/**
 * Looks a strategy up by name.
 *
 * @param {string} name
 * @returns {object}
 * @throws {Error} When no strategy is registered under `name`.
 */
function getStrategy(name) {
  const strategy = STRATEGIES[name];
  if (!strategy) {
    throw new Error(
      `Unknown strategy "${name}". Available: ${Object.keys(STRATEGIES).join(", ")}`
    );
  }
  return strategy;
}

/**
 * Expands a strategy mix into one strategy per agent.
 *
 * Weights are relative, not percentages, and the remainder is handed to the
 * heaviest entry so the returned array is always exactly `count` long.
 *
 * @param {Record<string, number>} mix - e.g. `{ GreedyBuyer: 3, FlakySeller: 1 }`
 * @param {number} count - Number of agents to produce.
 * @returns {object[]}
 */
function expandMix(mix, count) {
  const entries = Object.entries(mix ?? {}).filter(([, weight]) => weight > 0);
  if (entries.length === 0) {
    throw new Error("Strategy mix must name at least one strategy with a positive weight");
  }

  const totalWeight = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const assigned = [];

  for (const [name, weight] of entries) {
    const share = Math.floor((weight / totalWeight) * count);
    for (let i = 0; i < share; i++) assigned.push(getStrategy(name));
  }

  // Rounding leaves a few slots; give them to the heaviest strategy.
  const heaviest = entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  while (assigned.length < count) assigned.push(getStrategy(heaviest));

  return assigned.slice(0, count);
}

module.exports = {
  STRATEGIES,
  GreedyBuyer,
  LoyalBuyer,
  FlakySeller,
  HighVolumeCaller,
  getStrategy,
  expandMix,
  cheapest,
};
