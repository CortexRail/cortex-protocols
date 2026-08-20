/**
 * AnomalyScorer — combines detector output into one weighted risk score per
 * agent/asset pair, and renders the explanation a moderator actually reads.
 *
 * ── How signals are grouped ──────────────────────────────────────────────────
 *
 * Detectors emit two shapes: asset-scoped findings (wash usage on asset 42)
 * and address-scoped ones (this address sits in a sybil cluster). An address
 * finding is context for every asset that address touches, so:
 *
 *   • an agent with asset-level signals gets one composite per asset, with
 *     its address-level signals folded in as corroboration
 *   • an agent with only address-level signals gets a single address-level
 *     composite
 *
 * Nothing is emitted twice — a sybil member who also washes an asset appears
 * once, on the asset, carrying both signals.
 *
 * ── How the score is built ───────────────────────────────────────────────────
 *
 * A weighted mean over the detectors that FIRED (not over all detectors):
 * dividing by the total weight would make it arithmetically impossible for a
 * single detector to raise a critical flag no matter how blatant the
 * evidence. Independent agreement is then rewarded with a corroboration
 * bonus, because two unrelated detectors pointing at the same address is much
 * stronger evidence than one detector shouting.
 */

const fraudConfig = require("../config/fraud");
const { clamp, roundScore } = require("./scoring");

const DETECTOR = "composite";

/** Which risk tier a score falls into. */
function riskTierFor(score, tiers) {
  if (score >= tiers.critical) return "critical";
  if (score >= tiers.high) return "high";
  if (score >= tiers.medium) return "medium";
  return "low";
}

/**
 * Reduce several signals from the same detector to its strongest.
 *
 * VelocityDetector can fire on both an asset and its owner's address in one
 * scan; the pair is one piece of evidence, not two.
 */
function strongestPerDetector(signals) {
  const byDetector = new Map();
  for (const signal of signals) {
    const existing = byDetector.get(signal.detector);
    if (!existing || signal.rawScore > existing.rawScore) {
      byDetector.set(signal.detector, signal);
    }
  }
  return [...byDetector.values()];
}

/**
 * Combine one group of signals into a score. Exported for the unit tests.
 *
 * @param {Array<object>} signals - all signals for one agent/asset pair
 * @param {object} config - the `scorer` section of the fraud config
 */
function combine(signals, config) {
  const contributing = strongestPerDetector(signals);

  let weighted = 0;
  let usedWeight = 0;
  const parts = [];

  for (const signal of contributing) {
    const weight = config.weights[signal.detector] ?? 1;
    weighted += weight * signal.rawScore;
    usedWeight += weight;

    parts.push({
      detector: signal.detector,
      rawScore: signal.rawScore,
      weight,
      contribution: weight * signal.rawScore,
      summary: signal.evidence?.summary || "",
      metrics: signal.evidence?.metrics || {},
    });
  }

  const base = usedWeight > 0 ? weighted / usedWeight : 0;

  // Each additional independent detector adds a fixed bonus.
  const corroboration = 1 + Math.max(0, contributing.length - 1) * config.corroborationBonus;

  // A lone detector is discounted by how much it can be trusted on its own.
  // The weighted mean of one value IS that value, so without this a single
  // saturated detector would always reach the critical tier.
  const soloConfidence =
    contributing.length === 1
      ? config.soloConfidence?.[contributing[0].detector] ?? 1
      : 1;

  const score = roundScore(clamp(base * corroboration * soloConfidence));

  // Strongest evidence first — it is what the explanation leads with.
  parts.sort((a, b) => b.contribution - a.contribution);

  return {
    score,
    base: Number(base.toFixed(4)),
    corroboration: Number(corroboration.toFixed(4)),
    soloConfidence,
    detectorCount: contributing.length,
    parts,
    riskTier: riskTierFor(score, config.tiers),
  };
}

/**
 * Render the human-readable explanation.
 *
 * The fraud_signals table rejects an empty explanation by CHECK constraint,
 * so this must always produce text — the acceptance criterion is "never a
 * bare score", and this function is where that is honoured.
 */
function explain(combined, { agentAddress, assetId }) {
  const subject =
    assetId === null || assetId === undefined
      ? `address ${agentAddress}`
      : `asset ${assetId} (owner/actor ${agentAddress})`;

  const lines = [
    `Risk ${combined.riskTier.toUpperCase()} (score ${combined.score.toFixed(2)}) for ${subject}.`,
    `${combined.detectorCount} detector${combined.detectorCount === 1 ? "" : "s"} fired:`,
  ];

  for (const part of combined.parts) {
    lines.push(
      `• ${part.detector} scored ${part.rawScore.toFixed(2)} (weight ${part.weight}): ` +
        (part.summary || "no summary supplied by the detector")
    );
  }

  if (combined.detectorCount > 1) {
    const bonusPct = Math.round((combined.corroboration - 1) * 100);
    lines.push(
      `Corroboration: ${combined.detectorCount} independent detectors agreed, ` +
        `raising the weighted mean of ${combined.base.toFixed(2)} by ${bonusPct}%.`
    );
  } else {
    const discountPct = Math.round((1 - combined.soloConfidence) * 100);
    lines.push(
      `Single-detector finding: no corroboration, and the raw ${combined.base.toFixed(2)} ` +
        `is discounted ${discountPct}% because this detector fired alone.`
    );
  }

  return lines.join("\n");
}

/** Group signals as described in the module header. */
function groupSignals(signals) {
  const byAgent = new Map();

  for (const signal of signals) {
    if (!byAgent.has(signal.agentAddress)) {
      byAgent.set(signal.agentAddress, { byAsset: new Map(), addressLevel: [] });
    }
    const bucket = byAgent.get(signal.agentAddress);

    if (signal.assetId === null || signal.assetId === undefined) {
      bucket.addressLevel.push(signal);
    } else {
      if (!bucket.byAsset.has(signal.assetId)) bucket.byAsset.set(signal.assetId, []);
      bucket.byAsset.get(signal.assetId).push(signal);
    }
  }

  const groups = [];
  for (const [agentAddress, bucket] of byAgent) {
    if (bucket.byAsset.size > 0) {
      for (const [assetId, assetSignals] of bucket.byAsset) {
        groups.push({
          agentAddress,
          assetId,
          // Address-level findings are context on every asset this agent touches.
          signals: [...assetSignals, ...bucket.addressLevel],
        });
      }
    } else if (bucket.addressLevel.length) {
      groups.push({ agentAddress, assetId: null, signals: bucket.addressLevel });
    }
  }

  return groups;
}

/**
 * Score every subject present in the detector output.
 *
 * @param {Array<object>} signals - the concatenated output of all detectors
 * @param {{from: number, to: number}} window - epoch ms, stamped onto results
 * @param {object} [config]
 * @returns {Array<object>} rows shaped for fraudSignalRepository.upsertActive,
 *   each carrying the individual detector signals that produced it
 */
function score(signals, window, config = fraudConfig.getConfig()) {
  const settings = config.scorer;

  return groupSignals(signals)
    .map((group) => {
      const combined = combine(group.signals, settings);

      return {
        detector: DETECTOR,
        agentAddress: group.agentAddress,
        assetId: group.assetId,
        score: combined.score,
        riskTier: combined.riskTier,
        explanation: explain(combined, group),
        windowStart: window.from,
        windowEnd: window.to,
        evidence: {
          base: combined.base,
          corroboration: combined.corroboration,
          detectorCount: combined.detectorCount,
          weights: settings.weights,
          signals: combined.parts,
        },
        // Kept out of the persisted row; the scan pipeline stores these as
        // their own fraud_signals rows alongside the composite.
        sourceSignals: group.signals,
      };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  DETECTOR,
  score,
  combine,
  explain,
  groupSignals,
  strongestPerDetector,
  riskTierFor,
};
