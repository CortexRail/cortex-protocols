/**
 * Shared numeric helpers for the detectors.
 *
 * Every detector reports a `rawScore` in [0, 1] so AnomalyScorer can weigh
 * them against each other. `normalizeAbove` is how each one gets there: below
 * the threshold a measurement is not evidence at all and scores exactly 0,
 * at saturation it scores 1, and it ramps linearly in between. Keeping that
 * mapping in one place is what makes the tuning knobs in config/fraud.js
 * mean the same thing across detectors.
 */

function clamp(value, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Map a measurement onto [0, 1] relative to a threshold and a saturation
 * point. Returns 0 for anything at or below the threshold.
 */
function normalizeAbove(value, threshold, saturation) {
  if (!Number.isFinite(value) || value <= threshold) return 0;
  if (saturation <= threshold) return 1;
  return clamp((value - threshold) / (saturation - threshold));
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Sample standard deviation (n-1). Returns 0 for fewer than two points, which
 * callers must floor before dividing by it.
 */
function stdDev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Round a score to the 4 decimals the fraud_signals NUMERIC(6,4) column
 * stores, so what a detector reports and what comes back from the database
 * are the same number.
 */
function roundScore(value) {
  return Math.round(clamp(value) * 10_000) / 10_000;
}

/**
 * Fill in the buckets a grouped SQL query never returned.
 *
 * A subject with no calls in an hour has no row for that hour, but for a
 * baseline "no calls" is a real and important observation — without this the
 * mean is computed only over active hours and every idle asset looks like it
 * has a high, stable baseline.
 *
 * @param {Array<{bucketStart: number, calls: number}>} rows
 * @param {number} from - window start, epoch ms
 * @param {number} to - window end, epoch ms
 * @param {number} bucketSeconds
 * @returns {Array<{bucketStart: number, calls: number}>} ascending, gap-free
 */
function densifyBuckets(rows, from, to, bucketSeconds) {
  const widthMs = bucketSeconds * 1000;
  const byBucket = new Map(rows.map((row) => [row.bucketStart, row.calls]));

  // Align to the same absolute epoch boundaries the SQL bucketed on.
  const firstBucket = Math.floor(from / widthMs) * widthMs;
  const series = [];

  for (let start = firstBucket; start < to; start += widthMs) {
    series.push({ bucketStart: start, calls: byBucket.get(start) || 0 });
  }
  return series;
}

module.exports = {
  clamp,
  normalizeAbove,
  mean,
  stdDev,
  roundScore,
  densifyBuckets,
};
