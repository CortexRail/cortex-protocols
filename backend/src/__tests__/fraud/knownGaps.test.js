/**
 * Known-gap guard.
 *
 * The scenarios in syntheticFraudScenarios.js describe detector behaviour we
 * know is wrong. Data nobody executes rots, so this file runs them and asserts
 * that each gap still reproduces exactly as the register claims.
 *
 * This test failing is not necessarily bad news. There are two ways it fails:
 *
 *   1. A scenario stopped exercising its gap (a threshold moved, a generator
 *      drifted). The scenario is now useless and must be repaired.
 *   2. Somebody FIXED the detector. Then flip that gap's `status` to "closed"
 *      in KNOWN_GAPS and turn the scenario into a normal regression test.
 *
 * Either way the register and the code have diverged, which is the thing this
 * file exists to catch. It runs against injected fakes, not a database.
 */

const SybilGraphDetector = require("../../fraud/SybilGraphDetector");
const { scoreSeries } = require("../../fraud/VelocityDetector");
const { densifyBuckets } = require("../../fraud/scoring");
const fraudConfig = require("../../config/fraud");
const {
  benignSpikeThenFraudSpike,
  largeDenseClusterWithoutStrongSignals,
  alignToHour,
  KNOWN_GAPS,
} = require("./syntheticFraudScenarios");

let config;

beforeEach(() => {
  config = fraudConfig.resetConfig();
});

/** Aggregate raw usage events into the bucket series the detector consumes. */
function bucketSeries(events, window) {
  const counts = new Map();
  for (const event of events) {
    const bucket = alignToHour(event.occurredAt);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }
  const rows = [...counts].map(([bucketStart, calls]) => ({ bucketStart, calls }));
  return densifyBuckets(rows, window.from, window.to, 3600);
}

describe("GAP-B — baseline outliers mask a later genuine spike", () => {
  const scenario = benignSpikeThenFraudSpike();

  it("is still registered as open", () => {
    expect(KNOWN_GAPS.GAP_B.status).toBe("open");
  });

  it("misses the fraud spike when a benign outlier sits in the baseline", () => {
    const scored = scoreSeries(bucketSeries(scenario.usageEvents, scenario.window), config.velocity);

    // If this starts firing, the gap is fixed — close it in KNOWN_GAPS.
    expect(scored.fired).toBe(scenario.expected.currentlyFires);
    expect(scored.z).toBeLessThan(config.velocity.zThreshold);
  });

  it("catches the identical spike once the outlier is removed", () => {
    const scored = scoreSeries(
      bucketSeries(scenario.control.usageEvents, scenario.window),
      config.velocity
    );

    // The control is what attributes the miss to the outlier specifically.
    expect(scored.fired).toBe(scenario.control.expected.velocityFires);
    expect(scored.z).toBeGreaterThan(config.velocity.zThreshold);
  });
});

describe("GAP-C — sybil cluster fires on size and density alone", () => {
  const scenario = largeDenseClusterWithoutStrongSignals();

  const deps = {
    streamRepository: { async edgesInWindow() { return []; } },
    licenseRepository: { async edgesInWindow() { return scenario.licenseEdges; } },
    usageEventRepository: {
      async edgesInWindow() { return []; },
      // No usage events at all, so timing is unmeasurable rather than weak.
      async activityTimingByAddress() { return []; },
    },
    agentFundingRepository: { async findByAddresses() { return []; } },
  };

  it("is still registered as open", () => {
    expect(KNOWN_GAPS.GAP_C.status).toBe("open");
  });

  it("flags every member of a cluster with no corroborating evidence", async () => {
    const signals = await SybilGraphDetector.detect(scenario.window, deps, config);

    // If this stops firing, the gap is fixed — close it in KNOWN_GAPS.
    expect(signals.length > 0).toBe(scenario.expected.currentlyFires);
    expect(signals).toHaveLength(scenario.members.length);

    const metrics = signals[0].evidence.metrics;
    expect(metrics.subScores.funding).toBeNull();
    expect(metrics.subScores.timing).toBeNull();
    // Only size + density weight is in play: the whole of the gap.
    expect(metrics.measuredWeight).toBeCloseTo(
      config.sybil.weights.size + config.sybil.weights.density,
      5
    );
  });

  it("labels every member as clean, so each signal is a false positive", () => {
    // The corpus contract states fraud positively: an address absent from
    // `fraudAddresses` is legitimate, so an empty list means the whole cluster
    // is clean and every signal the detector emits here is a false positive.
    expect(scenario.labels.fraud).toHaveLength(0);
    expect(scenario.labels.fraudAddresses).toHaveLength(0);
    expect(scenario.members).toHaveLength(20);
  });
});
