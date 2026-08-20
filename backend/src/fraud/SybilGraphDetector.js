/**
 * SybilGraphDetector — finds clusters of addresses that look like one
 * operator behind many wallets.
 *
 * It unions the stream, licence, and usage relationship edges into one
 * undirected graph (see graph.js), splits it into connected components, and
 * scores each small component on four independent sub-signals:
 *
 *   size    — how many wallets move together
 *   density — how tightly they transact with each other
 *   funding — do they share a first-funding source
 *   timing  — did they all wake up within minutes of each other
 *
 * Two design decisions worth knowing before tuning this:
 *
 * 1. Components larger than `maxClusterSize` are SKIPPED, not flagged. In a
 *    healthy marketplace almost everyone ends up in one giant component via
 *    popular sellers; flagging it would flag the whole market.
 *
 * 2. Sub-signals that cannot be measured are dropped from the weighted
 *    average rather than scored as zero. `agent_funding_sources` ships empty,
 *    so funding is usually unmeasurable — counting it as "no evidence of
 *    sharing" would cap every real cluster below the firing threshold and the
 *    detector would look like it worked while never firing.
 */

const fraudConfig = require("../config/fraud");
const { buildGraph, subgraphFor } = require("./graph");
const { clamp, normalizeAbove, roundScore } = require("./scoring");

const DETECTOR = "sybil_graph";

/**
 * Share of a cluster funded from the same source.
 * Returns null when fewer than two members have a known funding source —
 * "unknown", not "unrelated".
 */
function scoreFunding(members, fundingByAddress) {
  const known = members
    .map((address) => fundingByAddress.get(address))
    .filter(Boolean);

  if (known.length < 2) return null;

  const counts = new Map();
  for (const source of known) {
    counts.set(source, (counts.get(source) || 0) + 1);
  }

  let topSource = null;
  let topCount = 0;
  for (const [source, count] of counts) {
    if (count > topCount) {
      topCount = count;
      topSource = source;
    }
  }

  // A single shared funder among a pair is coincidence-prone; require at
  // least two wallets on the same source before it counts as evidence.
  if (topCount < 2) return null;

  return {
    score: clamp(topCount / known.length),
    topSource,
    sharedCount: topCount,
    knownCount: known.length,
  };
}

/**
 * How tightly the cluster's first activity is bunched in time.
 * Returns null when fewer than two members have any recorded activity.
 */
function scoreTiming(members, timingByAddress, timingWindowMs) {
  const firstSeen = members
    .map((address) => timingByAddress.get(address))
    .filter((value) => Number.isFinite(value));

  if (firstSeen.length < 2) return null;

  const spanMs = Math.max(...firstSeen) - Math.min(...firstSeen);

  return {
    score: clamp(1 - spanMs / timingWindowMs),
    spanMs,
    measuredCount: firstSeen.length,
  };
}

/**
 * Combine the sub-signals, renormalizing over the ones that were measurable.
 *
 * @returns {{score: number, parts: object[], usedWeight: number}}
 */
function combineSubSignals(parts, weights) {
  let weighted = 0;
  let usedWeight = 0;

  for (const part of parts) {
    if (part.score === null) continue;
    const weight = weights[part.name] || 0;
    weighted += weight * part.score;
    usedWeight += weight;
  }

  return {
    score: usedWeight > 0 ? weighted / usedWeight : 0,
    usedWeight,
  };
}

/**
 * Score a single component. Exported so the unit tests can drive it directly
 * with a hand-built graph.
 */
function scoreComponent(component, context, config) {
  const { fundingByAddress, timingByAddress } = context;

  const size = { name: "size", score: normalizeAbove(component.size, config.minClusterSize - 1, config.sizeSaturation) };
  const density = { name: "density", score: normalizeAbove(component.density, config.densityThreshold, 1) };

  const fundingDetail = scoreFunding(component.members, fundingByAddress);
  const timingDetail = scoreTiming(component.members, timingByAddress, config.timingWindowMs);

  const parts = [
    size,
    density,
    { name: "funding", score: fundingDetail ? fundingDetail.score : null, detail: fundingDetail },
    { name: "timing", score: timingDetail ? timingDetail.score : null, detail: timingDetail },
  ];

  const { score, usedWeight } = combineSubSignals(parts, config.weights);

  return {
    fired: score >= config.threshold,
    rawScore: roundScore(score),
    parts,
    usedWeight,
    fundingDetail,
    timingDetail,
  };
}

/** Human-readable sentence describing why the cluster fired. */
function explainCluster(component, scored) {
  const reasons = [
    `${component.size} addresses transact as one connected cluster`,
    `internal density ${component.density.toFixed(2)}`,
  ];

  if (scored.fundingDetail) {
    reasons.push(
      `${scored.fundingDetail.sharedCount} of ${scored.fundingDetail.knownCount} ` +
        `with a known funder share ${scored.fundingDetail.topSource}`
    );
  } else {
    reasons.push("no funding-source data available for this cluster");
  }

  if (scored.timingDetail) {
    const minutes = (scored.timingDetail.spanMs / 60_000).toFixed(1);
    reasons.push(`first activity spread over ${minutes} minutes`);
  }

  return `Possible sybil cluster: ${reasons.join("; ")}.`;
}

/**
 * Run the detector over a window.
 *
 * @param {{from: number, to: number}} window - epoch ms
 * @param {object} deps - streamRepository, licenseRepository,
 *   usageEventRepository, agentFundingRepository
 * @param {object} [config]
 * @returns {Promise<Array<object>>} one signal per cluster member
 */
async function detect(window, deps, config = fraudConfig.getConfig()) {
  const {
    streamRepository,
    licenseRepository,
    usageEventRepository,
    agentFundingRepository,
  } = deps;
  const settings = config.sybil;

  // The scan pipeline builds the graph once and shares it with the wash pass;
  // standalone callers (and the unit tests) let the detector build its own.
  const [graph, timings] = await Promise.all([
    deps.graph
      ? Promise.resolve(deps.graph)
      : Promise.all([
          streamRepository.edgesInWindow(window),
          licenseRepository.edgesInWindow(window),
          usageEventRepository.edgesInWindow(window),
        ]).then(([streams, licenses, usage]) =>
          buildGraph({ streams, licenses, usage })
        ),
    usageEventRepository.activityTimingByAddress(window),
  ]);

  const timingByAddress = new Map(timings.map((row) => [row.address, row.firstSeen]));

  const candidates = graph.components.filter(
    (component) =>
      component.size >= settings.minClusterSize &&
      component.size <= settings.maxClusterSize
  );

  if (!candidates.length) return [];

  // One funding lookup for every candidate member, not one per cluster.
  const candidateMembers = [...new Set(candidates.flatMap((c) => c.members))];
  const fundingRows = await agentFundingRepository.findByAddresses(candidateMembers);
  const fundingByAddress = new Map(
    fundingRows.map((row) => [row.agentAddress, row.fundingSource])
  );

  const context = { fundingByAddress, timingByAddress };
  const signals = [];

  for (const component of candidates) {
    const scored = scoreComponent(component, context, settings);
    if (!scored.fired) continue;

    const subgraph = subgraphFor(graph, component, settings.maxSubgraphNodes);
    const summary = explainCluster(component, scored);

    for (const address of component.members) {
      signals.push({
        detector: DETECTOR,
        agentAddress: address,
        // A cluster is a property of the addresses, not of any one listing.
        assetId: null,
        rawScore: scored.rawScore,
        evidence: {
          summary,
          metrics: {
            clusterSize: component.size,
            density: Number(component.density.toFixed(4)),
            subScores: Object.fromEntries(
              scored.parts.map((part) => [part.name, part.score])
            ),
            measuredWeight: scored.usedWeight,
            sharedFundingSource: scored.fundingDetail
              ? scored.fundingDetail.topSource
              : null,
            firstActivitySpanMs: scored.timingDetail
              ? scored.timingDetail.spanMs
              : null,
          },
          samples: [],
          subgraph,
        },
      });

      if (signals.length >= settings.maxSignals) return signals;
    }
  }

  return signals;
}

module.exports = {
  DETECTOR,
  detect,
  scoreComponent,
  scoreFunding,
  scoreTiming,
  combineSubSignals,
};
