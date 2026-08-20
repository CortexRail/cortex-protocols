/**
 * ReplayAbuseDetector — flags callers whose metered payloads hash-match
 * earlier calls at a rate that suggests they are replaying cached responses
 * rather than paying for new work.
 *
 * Eligibility matters as much as the ratio. Repeating a request is only
 * abusive where each call is separately chargeable:
 *
 *   • stream-metered calls always are — the stream bills per call by
 *     construction, whatever the asset's licence says
 *   • licence-metered calls only are for the licence types in
 *     `chargeableLicenseTypes` (UsageBased by default). Under a Perpetual or
 *     OpenSource licence the buyer already paid once and repeating a payload
 *     costs them nothing to avoid — flagging it would be noise.
 *
 * Calls that carried no payload are excluded upstream in SQL: a client that
 * meters without a body is not repeating anything, and hashing an empty body
 * would make every such caller look like a perfect replayer.
 */

const fraudConfig = require("../config/fraud");
const { normalizeAbove, roundScore } = require("./scoring");

const DETECTOR = "replay_abuse";

/**
 * Score one (asset, caller) repetition row. Exported for the unit tests.
 *
 * Two ratios are considered and the larger wins:
 *
 *   repetitionRatio — how much of the traffic is *not* unique overall
 *   topHashShare    — how much of it is one single payload
 *
 * They catch different shapes: a client cycling 3 cached responses has a high
 * repetition ratio but a modest top share, while one hammering a single
 * cached response has both.
 */
function scoreRepetition(row, config) {
  const total = row.totalCalls;
  if (!total) {
    return { fired: false, rawScore: 0, repetitionRatio: 0, topHashShare: 0 };
  }

  const repetitionRatio = 1 - row.distinctHashes / total;
  const topHashShare = row.topHashCalls / total;
  const worst = Math.max(repetitionRatio, topHashShare);

  const rawScore = normalizeAbove(worst, config.ratioThreshold, config.ratioSaturation);

  return {
    fired: total >= config.minCalls && rawScore > 0,
    rawScore: roundScore(rawScore),
    repetitionRatio,
    topHashShare,
    worst,
  };
}

/**
 * Is this traffic billed per call?
 *
 * @param {string[]} sources - 'stream' and/or 'license'
 * @param {object|null} asset - the asset row, when one could be loaded
 */
function isChargeable(sources, asset, config) {
  if (sources.includes("stream")) return true;
  if (!asset) return false;
  return config.chargeableLicenseTypes.includes(asset.licenseType);
}

/**
 * Run the detector over a window.
 *
 * @param {{from: number, to: number}} window - epoch ms
 * @param {object} deps - usageEventRepository, assetRepository
 * @param {object} [config]
 */
async function detect(window, deps, config = fraudConfig.getConfig()) {
  const { usageEventRepository, assetRepository } = deps;
  const settings = config.replay;

  const rows = await usageEventRepository.payloadRepetitionStats({
    from: window.from,
    to: window.to,
    minCalls: settings.minCalls,
  });

  const signals = [];
  // Several callers usually hit the same asset; load each one once.
  const assetCache = new Map();

  for (const row of rows) {
    const scored = scoreRepetition(row, settings);
    if (!scored.fired) continue;

    if (!assetCache.has(row.assetId)) {
      assetCache.set(
        row.assetId,
        await assetRepository.findById(row.assetId, { includeInactive: true })
      );
    }
    const asset = assetCache.get(row.assetId);

    if (!isChargeable(row.sources || [], asset, settings)) continue;

    const uniquePct = ((row.distinctHashes / row.totalCalls) * 100).toFixed(1);
    const topPct = (scored.topHashShare * 100).toFixed(1);
    const summary =
      `${row.caller} made ${row.totalCalls} metered calls against asset ${row.assetId} ` +
      `but only ${row.distinctHashes} distinct payloads (${uniquePct}% unique); ` +
      `the most-repeated payload accounts for ${topPct}% of them.`;

    signals.push({
      detector: DETECTOR,
      agentAddress: row.caller,
      assetId: Number(row.assetId),
      rawScore: scored.rawScore,
      evidence: {
        summary,
        metrics: {
          totalCalls: row.totalCalls,
          distinctHashes: row.distinctHashes,
          topHashCalls: row.topHashCalls,
          repetitionRatio: Number(scored.repetitionRatio.toFixed(4)),
          topHashShare: Number(scored.topHashShare.toFixed(4)),
          billedVia: row.sources || [],
          licenseType: asset ? asset.licenseType : null,
        },
        samples: [
          {
            payloadHash: row.topHash,
            calls: row.topHashCalls,
          },
        ],
      },
    });
  }

  return signals;
}

module.exports = { DETECTOR, detect, scoreRepetition, isChargeable };
