/**
 * VelocityDetector — flags call rates that spike far beyond their own recent
 * baseline, using a rolling z-score.
 *
 * Two subjects are scored independently:
 *   assets  — a listing whose usage suddenly explodes (inflated popularity)
 *   callers — an address whose spend rate jumps (a drained/compromised key)
 *
 * The interesting part is not the z-score, it is the three guards around it,
 * each of which exists because the naive version fires constantly:
 *
 *   minBaselineBuckets — a listing with two hours of history has no "normal"
 *   minCurrentCalls    — 1 call/hour becoming 4 is not a spike worth a human
 *   minStdDev          — a perfectly flat history has stdev 0, and dividing
 *                        by it turns literally any activity into z = Infinity
 *
 * A quiet asset that wakes up is the single most common false positive in
 * this class of detector, so the volume floor matters more than the maths.
 */

const fraudConfig = require("../config/fraud");
const { normalizeAbove, mean, stdDev, roundScore, densifyBuckets } = require("./scoring");

const DETECTOR = "velocity";

/**
 * Score one subject's series. Exported for the unit tests, which pin the
 * guard behaviour without going near a database.
 *
 * @param {Array<{bucketStart: number, calls: number}>} series - gap-free, ascending
 * @param {object} config - the `velocity` section of the fraud config
 * @returns {{fired: boolean, z: number, current: number, baselineMean: number,
 *   baselineStdDev: number, observedBuckets: number, rawScore: number,
 *   reason: string}}
 */
function scoreSeries(series, config) {
  const result = {
    fired: false,
    z: 0,
    current: 0,
    baselineMean: 0,
    baselineStdDev: 0,
    observedBuckets: 0,
    rawScore: 0,
    reason: "",
  };

  if (series.length < 2) {
    result.reason = "series too short to separate a current bucket from a baseline";
    return result;
  }

  // The most recent bucket is what we are judging; everything before it is
  // the baseline. The current bucket is excluded from its own baseline —
  // otherwise a large spike drags the mean up and hides itself.
  const current = series[series.length - 1].calls;
  const baseline = series.slice(0, -1).map((bucket) => bucket.calls);

  // How much history this subject ACTUALLY has, which is not the same as how
  // many buckets the series contains: densifyBuckets zero-fills the whole
  // window, so `series.length` is always the window width even for an asset
  // listed an hour ago. Gating on the array length let a brand-new asset with
  // one busy hour score z = 60 against a baseline of pure zeros — a launch
  // read as fraud.
  //
  // The zeros still belong in the mean and standard deviation below: for a
  // subject with real history, an idle hour is a genuine observation, and
  // dropping idle hours would make every quiet asset look like it had a high,
  // stable baseline. They just cannot COUNT as history.
  //
  // Trade-off: a dormant subject that wakes up is indistinguishable from a new
  // one here, so neither fires on velocity. Real abuse from a dormant address
  // still surfaces through the wash, sybil, and replay detectors.
  const observedBuckets = baseline.filter((calls) => calls > 0).length;

  const baselineMean = mean(baseline);
  const rawStdDev = stdDev(baseline);
  const baselineStdDev = Math.max(rawStdDev, config.minStdDev);

  Object.assign(result, { current, baselineMean, baselineStdDev, observedBuckets });

  if (observedBuckets < config.minBaselineBuckets) {
    result.reason =
      `only ${observedBuckets} bucket(s) of observed activity in the baseline ` +
      `(need ${config.minBaselineBuckets} before a spike means anything)`;
    return result;
  }

  if (current < config.minCurrentCalls) {
    result.reason = `only ${current} calls in the current bucket (floor is ${config.minCurrentCalls})`;
    return result;
  }

  const z = (current - baselineMean) / baselineStdDev;
  result.z = z;

  const rawScore = normalizeAbove(z, config.zThreshold, config.zSaturation);
  if (rawScore <= 0) {
    result.reason = `z-score ${z.toFixed(2)} is within the normal band`;
    return result;
  }

  result.fired = true;
  result.rawScore = roundScore(rawScore);
  result.reason =
    `${current} calls in the last bucket against a baseline of ` +
    `${baselineMean.toFixed(1)} ± ${baselineStdDev.toFixed(1)} (z = ${z.toFixed(2)})`;
  return result;
}

/**
 * Turn a scored series into a signal.
 */
function buildSignal({ agentAddress, assetId, subject, subjectId, scored, series }) {
  const summary =
    subject === "asset"
      ? `Usage of asset ${subjectId} spiked: ${scored.reason}.`
      : `Call rate for ${subjectId} spiked: ${scored.reason}.`;

  return {
    detector: DETECTOR,
    agentAddress,
    assetId,
    rawScore: scored.rawScore,
    evidence: {
      summary,
      metrics: {
        subject,
        subjectId,
        currentCalls: scored.current,
        baselineMean: Number(scored.baselineMean.toFixed(2)),
        baselineStdDev: Number(scored.baselineStdDev.toFixed(2)),
        zScore: Number(scored.z.toFixed(2)),
      },
      // The tail of the series, so a reviewer sees the shape of the spike.
      samples: series.slice(-12).map((bucket) => ({
        bucketStart: bucket.bucketStart,
        calls: bucket.calls,
      })),
    },
  };
}

/**
 * Run the detector over a window.
 *
 * @param {{from: number, to: number, bucketSeconds?: number}} window - epoch ms
 * @param {object} deps
 * @param {object} deps.usageEventRepository
 * @param {object} deps.assetRepository - only consulted for flagged assets,
 *   to attribute the signal to the asset's owner
 * @param {object} [config] - defaults to the active fraud config
 * @returns {Promise<Array<object>>} signals
 */
async function detect(window, deps, config = fraudConfig.getConfig()) {
  const { usageEventRepository, assetRepository } = deps;
  const settings = config.velocity;
  const bucketSeconds = window.bucketSeconds || config.window.bucketSeconds;

  const signals = [];

  // ── Per-asset spikes ───────────────────────────────────────────────────────
  const assetRows = await usageEventRepository.callCountsByBucket(
    { subject: "asset", from: window.from, to: window.to, bucketSeconds }
  );

  for (const [assetId, rows] of groupBySubject(assetRows)) {
    const series = densifyBuckets(rows, window.from, window.to, bucketSeconds);
    const scored = scoreSeries(series, settings);
    if (!scored.fired) continue;

    // Attribute the spike to whoever owns the listing. Only flagged assets
    // are looked up, so this stays a handful of queries, not one per asset.
    const asset = await assetRepository.findById(
      assetId,
      { includeInactive: true }
    );
    if (!asset) continue;

    signals.push(
      buildSignal({
        agentAddress: asset.owner,
        assetId: Number(assetId),
        subject: "asset",
        subjectId: assetId,
        scored,
        series,
      })
    );

    if (signals.length >= settings.maxSignals) return signals;
  }

  // ── Per-caller spikes ──────────────────────────────────────────────────────
  const callerRows = await usageEventRepository.callCountsByBucket(
    { subject: "caller", from: window.from, to: window.to, bucketSeconds }
  );

  for (const [caller, rows] of groupBySubject(callerRows)) {
    const series = densifyBuckets(rows, window.from, window.to, bucketSeconds);
    const scored = scoreSeries(series, settings);
    if (!scored.fired) continue;

    signals.push(
      buildSignal({
        agentAddress: caller,
        assetId: null,
        subject: "caller",
        subjectId: caller,
        scored,
        series,
      })
    );

    if (signals.length >= settings.maxSignals) return signals;
  }

  return signals;
}

/** Group flat bucket rows into a Map<subject, rows[]>. */
function groupBySubject(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.subject === null || row.subject === undefined) continue;
    if (!grouped.has(row.subject)) grouped.set(row.subject, []);
    grouped.get(row.subject).push(row);
  }
  return grouped;
}

module.exports = { DETECTOR, detect, scoreSeries, groupBySubject };
