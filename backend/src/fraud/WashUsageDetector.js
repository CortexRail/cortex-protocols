/**
 * WashUsageDetector — flags an asset whose usage and revenue come
 * disproportionately from addresses tied to the asset's own owner, i.e.
 * self-dealing to inflate visible popularity and reputation.
 *
 * ── The subtlety that defines this detector ──────────────────────────────────
 *
 * "Addresses connected to the owner" cannot mean "adjacent in the graph".
 * Every purchase and every metered call *creates* a buyer→owner edge, so by
 * that definition every customer is connected to the seller and every asset
 * on the marketplace is 100% self-dealt. The measure has to be independent of
 * the transaction being measured.
 *
 * So an address counts as an insider only when it is:
 *
 *   • the owner itself, or
 *   • sharing a first-funding source with the owner, or
 *   • reachable from the owner by a path that does NOT use the direct
 *     owner↔caller edge — a link that exists for some reason other than this
 *     buyer buying from this seller.
 *
 * That last rule is what separates "my customer" from "my other wallet".
 */

const fraudConfig = require("../config/fraud");
const { buildGraph } = require("./graph");
const { normalizeAbove, roundScore } = require("./scoring");

const DETECTOR = "wash_usage";

/**
 * Is `target` reachable from `origin` within `hops`, ignoring the direct
 * origin↔target edge?
 *
 * A 1-hop result is by definition that direct edge, so anything below two
 * hops can never qualify.
 */
function reachableIgnoringDirectEdge(graph, origin, target, hops) {
  if (hops < 2 || !graph.adjacency.has(origin)) return false;

  const visited = new Set([origin]);
  let frontier = [origin];

  for (let depth = 0; depth < hops; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (const neighbor of graph.adjacency.get(node) || []) {
        // Mask the edge under investigation.
        if (node === origin && neighbor === target) continue;
        if (neighbor === target) return true;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        next.push(neighbor);
      }
    }
    if (!next.length) break;
    frontier = next;
  }
  return false;
}

/**
 * Classify one caller against the asset owner.
 *
 * @returns {{insider: boolean, reason: string|null}}
 */
function classifyCaller(graph, owner, caller, hops, fundingByAddress) {
  if (caller === owner) return { insider: true, reason: "owner's own address" };

  const ownerFunding = fundingByAddress.get(owner);
  if (ownerFunding && fundingByAddress.get(caller) === ownerFunding) {
    return { insider: true, reason: `shares funding source ${ownerFunding} with the owner` };
  }

  if (reachableIgnoringDirectEdge(graph, owner, caller, hops)) {
    return { insider: true, reason: "linked to the owner independently of this purchase" };
  }

  return { insider: false, reason: null };
}

/**
 * Score one asset's caller breakdown. Exported for the unit tests.
 *
 * @param {Array<{caller: string, calls: number, revenue: number}>} rows
 * @returns {object} totals, insider split, and the raw score
 */
function scoreAsset(rows, owner, graph, fundingByAddress, config) {
  const totals = { calls: 0, revenue: 0 };
  const insiders = [];
  const outsiders = [];

  for (const row of rows) {
    totals.calls += row.calls;
    totals.revenue += row.revenue;

    const verdict = classifyCaller(graph, owner, row.caller, config.ownerHops, fundingByAddress);
    (verdict.insider ? insiders : outsiders).push({ ...row, reason: verdict.reason });
  }

  const insiderCalls = insiders.reduce((sum, row) => sum + row.calls, 0);
  const insiderRevenue = insiders.reduce((sum, row) => sum + row.revenue, 0);

  const callShare = totals.calls > 0 ? insiderCalls / totals.calls : 0;
  const revenueShare = totals.revenue > 0 ? insiderRevenue / totals.revenue : 0;

  // Call share drives the score. Licence calls carry no per-call revenue
  // (see licenseService), so revenue share is reported as supporting evidence
  // rather than scored, otherwise licence-heavy assets would be unscoreable.
  const rawScore = normalizeAbove(callShare, config.shareThreshold, config.shareSaturation);

  return {
    fired: totals.calls >= config.minAssetCalls && rawScore > 0,
    rawScore: roundScore(rawScore),
    totals,
    insiderCalls,
    insiderRevenue,
    callShare,
    revenueShare,
    insiders,
    outsiders,
  };
}

/** Group flat rows into Map<assetId, {owner, rows[]}>. */
function groupByAsset(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.assetId)) {
      grouped.set(row.assetId, { owner: row.ownerAddress, rows: [] });
    }
    grouped.get(row.assetId).rows.push(row);
  }
  return grouped;
}

/**
 * Run the detector over a window.
 *
 * @param {{from: number, to: number}} window - epoch ms
 * @param {object} deps - usageEventRepository, streamRepository,
 *   licenseRepository, agentFundingRepository, and optionally a prebuilt
 *   `graph` (the scan pipeline builds one and shares it with the sybil pass)
 * @param {object} [config]
 */
async function detect(window, deps, config = fraudConfig.getConfig()) {
  const {
    usageEventRepository,
    streamRepository,
    licenseRepository,
    agentFundingRepository,
  } = deps;
  const settings = config.wash;

  const rows = await usageEventRepository.assetUsageByCaller({
    from: window.from,
    to: window.to,
    minAssetCalls: settings.minAssetCalls,
  });
  if (!rows.length) return [];

  const graph =
    deps.graph ||
    buildGraph({
      streams: await streamRepository.edgesInWindow(window),
      licenses: await licenseRepository.edgesInWindow(window),
      usage: await usageEventRepository.edgesInWindow(window),
    });

  const byAsset = groupByAsset(rows);

  // Funding sources for every owner and caller in play, in one query.
  const addresses = new Set();
  for (const [, group] of byAsset) {
    if (group.owner) addresses.add(group.owner);
    for (const row of group.rows) addresses.add(row.caller);
  }
  const fundingRows = await agentFundingRepository.findByAddresses([...addresses]);
  const fundingByAddress = new Map(
    fundingRows.map((row) => [row.agentAddress, row.fundingSource])
  );

  const signals = [];

  for (const [assetId, group] of byAsset) {
    // A usage row whose asset has since been deleted has no owner to blame.
    if (!group.owner) continue;

    const scored = scoreAsset(group.rows, group.owner, graph, fundingByAddress, settings);
    if (!scored.fired) continue;

    const sharePct = (scored.callShare * 100).toFixed(1);
    const summary =
      `${sharePct}% of asset ${assetId}'s ${scored.totals.calls} calls in this window ` +
      `came from ${scored.insiders.length} address(es) tied to the owner ` +
      `(${scored.insiderCalls} calls, ${scored.insiderRevenue} in revenue).`;

    signals.push({
      detector: DETECTOR,
      agentAddress: group.owner,
      assetId: Number(assetId),
      rawScore: scored.rawScore,
      evidence: {
        summary,
        metrics: {
          totalCalls: scored.totals.calls,
          totalRevenue: scored.totals.revenue,
          insiderCalls: scored.insiderCalls,
          insiderRevenue: scored.insiderRevenue,
          callShare: Number(scored.callShare.toFixed(4)),
          revenueShare: Number(scored.revenueShare.toFixed(4)),
          insiderCount: scored.insiders.length,
          outsiderCount: scored.outsiders.length,
        },
        // Who the insiders are and *why* each one counted as one.
        samples: scored.insiders
          .slice()
          .sort((a, b) => b.calls - a.calls)
          .slice(0, 10)
          .map((row) => ({
            caller: row.caller,
            calls: row.calls,
            revenue: row.revenue,
            reason: row.reason,
          })),
      },
    });
  }

  return signals;
}

module.exports = {
  DETECTOR,
  detect,
  scoreAsset,
  classifyCaller,
  reachableIgnoringDirectEdge,
  groupByAsset,
};
