/**
 * Fraud detection parameters.
 *
 * Every threshold a detector consults lives here rather than inline, so tuning
 * after a wave of false positives is a config change and the backtest harness
 * can sweep values without touching detector code.
 *
 * The getConfig/setConfig shape mirrors services/reputationEngine.js, which is
 * the existing precedent for runtime-tunable engine parameters.
 */

const DEFAULT_CONFIG = Object.freeze({
  /** Rolling window every scan runs over. */
  window: {
    lookbackHours: 24,
    bucketSeconds: 3600,
  },

  velocity: {
    // Buckets that must have shown ACTUAL activity before a baseline means
    // anything. Counted over observed traffic, not over the zero-filled
    // window: below this a brand-new asset has no "normal" to deviate from.
    minBaselineBuckets: 6,
    // A spike from 1 call to 4 is not a spike. Volume floor before flagging.
    minCurrentCalls: 20,
    // Floor on the baseline standard deviation. Without it, a perfectly flat
    // history (stdev 0) turns any activity at all into an infinite z-score.
    minStdDev: 1,
    zThreshold: 3,
    // z at which the normalized score saturates to 1.
    zSaturation: 10,
    maxSignals: 200,
  },

  sybil: {
    minClusterSize: 3,
    // A healthy marketplace is one big connected component: everybody is
    // linked through popular sellers. Components above this are the organic
    // core, not a ring, and are skipped rather than flagged.
    maxClusterSize: 50,
    // Ring size at which the size sub-score saturates. Deliberately small:
    // an operator running 10 wallets is already the pattern we care about,
    // and scaling to maxClusterSize would score every real ring near zero.
    sizeSaturation: 10,
    // Density is a *sub-score*, not a gate. A ring shaped like a star — 8
    // wallets all buying from one seller — has density ≈0.22, so gating on
    // density would miss the most common topology outright.
    densityThreshold: 0.15,
    // Wallets driven by one operator tend to wake up together.
    timingWindowMs: 15 * 60 * 1000,
    // Renormalized over whichever sub-signals are actually available: with
    // agent_funding_sources empty (the default), funding drops out of the
    // denominator instead of silently capping every cluster's score.
    weights: {
      size: 0.15,
      density: 0.2,
      funding: 0.35,
      timing: 0.3,
    },
    threshold: 0.5,
    maxSubgraphNodes: 60,
    maxSignals: 500,
  },

  wash: {
    minAssetCalls: 20,
    // How far from the owner an address still counts as "connected".
    ownerHops: 2,
    // Share of usage coming from the owner's own neighbourhood.
    shareThreshold: 0.5,
    shareSaturation: 0.95,
  },

  replay: {
    minCalls: 10,
    ratioThreshold: 0.5,
    ratioSaturation: 0.95,
    // Replaying a cached response only avoids payment where each call is
    // separately chargeable. Perpetual/OpenSource licences bill once, so a
    // repeated payload there is not fraud.
    chargeableLicenseTypes: ["UsageBased"],
  },

  scorer: {
    // Relative trust in each detector. Sybil and wash signals are structural
    // and hard to produce accidentally; velocity and replay have benign
    // explanations (a viral asset, a retry loop) so they carry less.
    weights: {
      velocity: 1,
      sybil_graph: 1.5,
      wash_usage: 1.5,
      replay_abuse: 1,
    },
    // Independent detectors agreeing is stronger evidence than one shouting.
    corroborationBonus: 0.15,
    // Discount applied when a detector fires ALONE. Without it any saturated
    // detector scores 1.0 — the weighted mean of a single value is that value
    // — so one velocity spike would raise a critical flag, which is exactly
    // the "asset went viral" false positive. The discount is per detector
    // because they are not equally trustworthy on their own: a wash or sybil
    // finding is structural and hard to produce by accident, while a velocity
    // spike or a burst of repeated payloads has innocent explanations.
    soloConfidence: {
      velocity: 0.75,
      replay_abuse: 0.85,
      wash_usage: 0.95,
      sybil_graph: 0.95,
    },
    tiers: {
      critical: 0.85,
      high: 0.7,
      medium: 0.4,
    },
  },
});

function clone(config) {
  return JSON.parse(JSON.stringify(config));
}

let activeConfig = clone(DEFAULT_CONFIG);

/** The parameters the detectors are currently running with. */
function getConfig() {
  return clone(activeConfig);
}

/**
 * Override parameters, section by section. Unknown sections are ignored;
 * known ones are merged one level deep so a caller can change a single
 * threshold without restating the whole block.
 */
function setConfig(patch = {}) {
  for (const section of Object.keys(activeConfig)) {
    if (!patch[section] || typeof patch[section] !== "object") continue;

    for (const key of Object.keys(activeConfig[section])) {
      if (patch[section][key] === undefined) continue;

      const current = activeConfig[section][key];
      const next = patch[section][key];

      // Nested objects (weights, tiers) merge key by key.
      if (current && typeof current === "object" && !Array.isArray(current)) {
        activeConfig[section][key] = { ...current, ...next };
      } else {
        activeConfig[section][key] = next;
      }
    }
  }
  return getConfig();
}

/** Restore the shipped defaults (used between backtest scenarios). */
function resetConfig() {
  activeConfig = clone(DEFAULT_CONFIG);
  return getConfig();
}

module.exports = { DEFAULT_CONFIG, getConfig, setConfig, resetConfig };
