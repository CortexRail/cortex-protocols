/**
 * VelocityDetector scoring guards.
 *
 * Pure unit tests over scoreSeries — no database, no repositories. What they
 * pin is the set of guards that keep a rolling z-score from firing on every
 * quiet subject that wakes up, which is the dominant false positive for this
 * class of detector.
 */

const { scoreSeries } = require("../../fraud/VelocityDetector");
const { densifyBuckets } = require("../../fraud/scoring");
const fraudConfig = require("../../config/fraud");

const HOUR_MS = 3_600_000;

const to = Math.floor(Date.now() / HOUR_MS) * HOUR_MS + HOUR_MS;
const from = to - 24 * HOUR_MS;

let config;

beforeEach(() => {
  config = fraudConfig.resetConfig().velocity;
});

/** Build a gap-free series the way the detector does, from sparse rows. */
function series(rows) {
  return densifyBuckets(rows, from, to, 3600);
}

function bucket(hoursAgo, calls) {
  return { bucketStart: to - hoursAgo * HOUR_MS, calls };
}

/** `hours` consecutive baseline buckets ending just before the current one. */
function steadyHistory(hours, calls) {
  return Array.from({ length: hours }, (_, i) => bucket(hours + 1 - i, calls));
}

describe("scoreSeries baseline guards", () => {
  it("does not fire on a brand-new subject whose baseline is all zeros", () => {
    // densifyBuckets zero-fills the window, so the series is 24 buckets long
    // even though the subject has existed for one hour. Gating on array
    // length instead of observed activity scored this at z = 60.
    const scored = scoreSeries(series([bucket(1, 60)]), config);

    expect(scored.fired).toBe(false);
    expect(scored.observedBuckets).toBe(0);
    expect(scored.reason).toMatch(/observed activity/);
  });

  it("does not fire just below the observed-history threshold", () => {
    const rows = [...steadyHistory(config.minBaselineBuckets - 1, 5), bucket(1, 60)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.fired).toBe(false);
    expect(scored.observedBuckets).toBe(config.minBaselineBuckets - 1);
  });

  it("fires once the subject has the minimum observed history", () => {
    const rows = [...steadyHistory(config.minBaselineBuckets, 5), bucket(1, 60)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.fired).toBe(true);
    expect(scored.observedBuckets).toBe(config.minBaselineBuckets);
  });

  it("keeps idle hours in the statistics even though they are not history", () => {
    // Seven busy hours and a long idle stretch: the zeros must pull the mean
    // down, otherwise a quiet asset looks like it has a high stable baseline.
    const rows = [...steadyHistory(7, 10), bucket(1, 100)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.observedBuckets).toBe(7);
    expect(scored.baselineMean).toBeLessThan(10);
    expect(scored.fired).toBe(true);
  });

  it("fires on a genuine spike against an established baseline", () => {
    const rows = [...steadyHistory(20, 40), bucket(1, 400)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.fired).toBe(true);
    expect(scored.rawScore).toBe(1);
    expect(scored.z).toBeGreaterThan(config.zThreshold);
  });

  it("respects the volume floor regardless of how extreme the ratio is", () => {
    // 1 call/hour becoming 4 is a 4x jump and still not worth a human.
    const rows = [...steadyHistory(20, 1), bucket(1, 4)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.fired).toBe(false);
    expect(scored.reason).toMatch(/floor is/);
  });

  it("floors the standard deviation so a flat baseline is not a divide-by-zero", () => {
    // Every baseline bucket in the window must carry traffic for the history
    // to be genuinely flat — a partially covered window has zero-filled hours
    // that are themselves variance.
    const rows = [...steadyHistory(23, 50), bucket(1, 60)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.baselineMean).toBe(50);
    // Raw stdev is 0 here; the floor keeps z finite instead of Infinity.
    expect(scored.baselineStdDev).toBe(config.minStdDev);
    expect(Number.isFinite(scored.z)).toBe(true);
  });

  it("stays quiet when traffic is steady", () => {
    const rows = [...steadyHistory(20, 40), bucket(1, 41)];
    const scored = scoreSeries(series(rows), config);

    expect(scored.fired).toBe(false);
    expect(scored.reason).toMatch(/normal band/);
  });

  it("returns early on a series too short to split", () => {
    const scored = scoreSeries([{ bucketStart: to - HOUR_MS, calls: 100 }], config);

    expect(scored.fired).toBe(false);
    expect(scored.reason).toMatch(/too short/);
  });
});
