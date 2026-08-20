/**
 * Fraud detection backtest.
 *
 * Seeds each synthetic scenario into a real database, runs ONE production scan
 * cycle over it via fraudService, and scores the signals it produced against
 * the corpus labels. CI fails when detection quality drops below the recorded
 * floors.
 *
 * ── How the metrics are defined ──────────────────────────────────────────────
 *
 * recall     per detector: of the detections the corpus demands, how many did
 *            that detector actually make.
 * precision  per detector: of the addresses that detector flagged, how many
 *            were fraudulent AT ALL — not "fraudulent according to this
 *            detector". A wash-trading ring is genuinely also a sybil cluster,
 *            and docking the sybil detector for noticing would be scoring the
 *            corpus rather than the code.
 * routed     over composite findings at the high/critical tiers, which is what
 *            actually consumes a moderator's time.
 *
 * ── About the thresholds ─────────────────────────────────────────────────────
 *
 * These are REGRESSION FLOORS, not aspirations. Each was measured from this
 * corpus and then rounded down, so the suite catches quality sliding backwards
 * without pretending the detectors are better than they are. Raising a floor
 * after a genuine improvement is expected and welcome; lowering one needs a
 * reason in the commit message.
 *
 * Velocity's precision floor is deliberately the lowest in the set. A genuine
 * launch and an inflated one have the same shape in a usage log, so the
 * `viral-asset` control produces a velocity signal by design. That signal is a
 * "somebody look at this", not a verdict, which is what the solo-detector
 * discount in AnomalyScorer encodes.
 *
 * Scenarios tied to an open entry in KNOWN_GAPS are reported separately and do
 * NOT gate CI — see knownGaps.test.js for the guard that keeps that register
 * honest.
 */

const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const streamRepository = require("../../repositories/streamRepository");
const usageEventRepository = require("../../repositories/usageEventRepository");
const agentFundingRepository = require("../../repositories/agentFundingRepository");
const fraudSignalRepository = require("../../repositories/fraudSignalRepository");
const fraudService = require("../../services/fraudService");
const fraudConfig = require("../../config/fraud");
const { truncateAll, closePool } = require("../helpers/testDb");
const {
  ENFORCED_CORPUS,
  GAP_CORPUS,
  KNOWN_GAPS,
} = require("./syntheticFraudScenarios");

// ── Documented quality floors ────────────────────────────────────────────────

// Measured on this corpus 2026-08-19, then rounded down:
//   sybil_graph  precision 1.000  recall 1.000
//   wash_usage   precision 1.000  recall 1.000
//   replay_abuse precision 1.000  recall 1.000
//   velocity     precision 0.667  recall 1.000   (the viral-asset control is
//                                                 the single false positive)
//   routed       precision 0.929  recall 1.000
//
// PROPOSED, PENDING MAINTAINER CONFIRMATION. The issue states no target
// precision/recall numbers and the question is still open, so these floors are
// what this corpus actually measures, not an agreed contract. If the maintainer
// comes back with different targets, change the constants below — no detector
// logic depends on them.
const THRESHOLDS = Object.freeze({
  sybil_graph: { precision: 0.9, recall: 0.85 },
  wash_usage: { precision: 0.9, recall: 0.85 },
  replay_abuse: { precision: 0.9, recall: 0.85 },
  velocity: { precision: 0.65, recall: 0.85 },
  routed: { precision: 0.85, recall: 0.9 },
});

const REPORTABLE_TIERS = new Set(["high", "critical"]);
const TIER_ORDER = ["low", "medium", "high", "critical"];

// ── Harness ──────────────────────────────────────────────────────────────────

async function seedScenario(scenario) {
  for (const asset of scenario.assets || []) {
    await assetRepository.create(asset);
  }
  for (const license of scenario.licenses || []) {
    await licenseRepository.create(license);
  }
  for (const stream of scenario.streams || []) {
    await streamRepository.create(stream);
  }
  for (const funding of scenario.funding || []) {
    await agentFundingRepository.upsert(funding);
  }
  for (const event of scenario.usageEvents || []) {
    await usageEventRepository.record(event);
  }
}

/** Wipe, seed, run exactly one scan cycle, and collect what it produced. */
async function runScenario(scenario) {
  await truncateAll();
  await seedScenario(scenario);

  const summary = await fraudService.runScan({ now: scenario.window.to });
  const stored = await fraudSignalRepository.findAll({}, { page: 1, limit: 100 });

  return { scenario, summary, signals: stored.data };
}

/**
 * Score one scenario's signals against its labels.
 *
 * Counted per distinct (detector, address) pair: a sybil ring emits one signal
 * per member, and treating each as an independent verdict would let one large
 * cluster dominate the whole corpus metric.
 */
function evaluate({ scenario, signals }) {
  const fraudAddresses = new Set(scenario.labels.fraudAddresses);

  const flagged = new Map(); // detector -> Set(address)
  for (const signal of signals) {
    if (signal.detector === "composite") continue;
    if (!flagged.has(signal.detector)) flagged.set(signal.detector, new Set());
    flagged.get(signal.detector).add(signal.agentAddress);
  }

  const perDetector = {};
  const touch = (detector) => {
    perDetector[detector] ||= { truePositives: 0, falsePositives: 0, expected: 0, missed: 0 };
    return perDetector[detector];
  };

  for (const [detector, addresses] of flagged) {
    const stats = touch(detector);
    for (const address of addresses) {
      if (fraudAddresses.has(address)) stats.truePositives += 1;
      else stats.falsePositives += 1;
    }
  }

  for (const label of scenario.labels.fraud) {
    const stats = touch(label.detector);
    stats.expected += 1;
    if (!flagged.get(label.detector)?.has(label.agentAddress)) stats.missed += 1;
  }

  // Composite findings that would reach a human.
  const routed = { truePositives: 0, falsePositives: 0, expected: 0, missed: 0 };
  const routedAddresses = new Set(
    signals
      .filter((s) => s.detector === "composite" && REPORTABLE_TIERS.has(s.riskTier))
      .map((s) => s.agentAddress)
  );
  for (const address of routedAddresses) {
    if (fraudAddresses.has(address)) routed.truePositives += 1;
    else routed.falsePositives += 1;
  }
  if (scenario.labels.fraud.length > 0) {
    // At least the subject of each demanded detection must reach moderation.
    const subjects = new Set(scenario.labels.fraud.map((l) => l.agentAddress));
    for (const subject of subjects) {
      routed.expected += 1;
      if (!routedAddresses.has(subject)) routed.missed += 1;
    }
  }

  const highestTier = signals
    .filter((s) => s.detector === "composite")
    .reduce((worst, s) => Math.max(worst, TIER_ORDER.indexOf(s.riskTier)), -1);

  return { perDetector, routed, highestTier: TIER_ORDER[highestTier] || "none" };
}

function merge(target, source) {
  for (const [key, stats] of Object.entries(source)) {
    target[key] ||= { truePositives: 0, falsePositives: 0, expected: 0, missed: 0 };
    for (const field of Object.keys(stats)) target[key][field] += stats[field];
  }
  return target;
}

const precisionOf = (s) =>
  s.truePositives + s.falsePositives === 0
    ? 1
    : s.truePositives / (s.truePositives + s.falsePositives);

const recallOf = (s) => (s.expected === 0 ? 1 : (s.expected - s.missed) / s.expected);

// ── Run the corpus once, assert over the results ─────────────────────────────

const now = Date.now();
const results = new Map();
const evaluations = new Map();
let aggregate;

beforeAll(async () => {
  fraudConfig.resetConfig();

  for (const build of [...ENFORCED_CORPUS, ...GAP_CORPUS]) {
    const scenario = build({ now });
    const result = await runScenario(scenario);
    results.set(scenario.name, result);
    evaluations.set(scenario.name, evaluate(result));
  }

  aggregate = { perDetector: {}, routed: { truePositives: 0, falsePositives: 0, expected: 0, missed: 0 } };
  for (const build of ENFORCED_CORPUS) {
    const name = build({ now }).name;
    const evaluation = evaluations.get(name);
    merge(aggregate.perDetector, evaluation.perDetector);
    merge({ routed: aggregate.routed }, { routed: evaluation.routed });
  }

  // The measured numbers belong in the run output: a threshold nobody can see
  // the actual value behind is a threshold nobody maintains.
  const lines = ["", "── fraud backtest ──────────────────────────────"];
  for (const [detector, stats] of Object.entries(aggregate.perDetector)) {
    lines.push(
      `  ${detector.padEnd(13)} precision ${precisionOf(stats).toFixed(3)} ` +
        `recall ${recallOf(stats).toFixed(3)}  ` +
        `(tp ${stats.truePositives}, fp ${stats.falsePositives}, missed ${stats.missed}/${stats.expected})`
    );
  }
  lines.push(
    `  ${"routed".padEnd(13)} precision ${precisionOf(aggregate.routed).toFixed(3)} ` +
      `recall ${recallOf(aggregate.routed).toFixed(3)}`
  );
  lines.push("  open gaps (reported, not enforced):");
  for (const gap of Object.values(KNOWN_GAPS)) {
    const evaluation = evaluations.get(gap.scenario);
    const fired = evaluation
      ? Object.values(evaluation.perDetector).some((s) => s.truePositives + s.falsePositives > 0)
      : false;
    lines.push(`    ${gap.id} ${gap.status.padEnd(6)} ${gap.detector} — signals produced: ${fired}`);
  }
  lines.push("────────────────────────────────────────────────", "");
  console.info(lines.join("\n"));
}, 600_000);

afterAll(async () => {
  await closePool();
});

describe("acceptance criteria", () => {
  it("flags a synthetic sybil ring within one scan cycle", () => {
    const { signals } = results.get("sybil-ring");

    const sybilSignals = signals.filter((s) => s.detector === "sybil_graph");
    expect(sybilSignals.length).toBeGreaterThan(0);

    // Nine addresses move as one operator: eight wallets plus the operator.
    expect(new Set(sybilSignals.map((s) => s.agentAddress)).size).toBe(9);
  });

  it("gives every automated flag a human-readable explanation", () => {
    for (const [, { signals }] of results) {
      for (const signal of signals) {
        expect(typeof signal.explanation).toBe("string");
        expect(signal.explanation.trim().length).toBeGreaterThan(20);
        // Never a bare score.
        expect(signal.explanation).not.toMatch(/^[\d.]+$/);
      }
    }
  });

  it("routes corroborated fraud to the critical tier", () => {
    // The ring trips both the sybil and wash detectors; agreement between two
    // independent detectors is what the corroboration bonus is for.
    expect(evaluations.get("sybil-ring").highestTier).toBe("critical");
  });

  it("keeps a legitimate launch below the critical tier", () => {
    expect(["none", "low", "medium", "high"]).toContain(
      evaluations.get("viral-asset").highestTier
    );
  });
});

describe("detection quality floors", () => {
  it.each(Object.keys(THRESHOLDS).filter((k) => k !== "routed"))(
    "%s meets its precision and recall floor",
    (detector) => {
      const stats = aggregate.perDetector[detector];
      expect(stats).toBeDefined();

      expect(precisionOf(stats)).toBeGreaterThanOrEqual(THRESHOLDS[detector].precision);
      expect(recallOf(stats)).toBeGreaterThanOrEqual(THRESHOLDS[detector].recall);
    }
  );

  it("meets the floor for findings routed to moderation", () => {
    expect(precisionOf(aggregate.routed)).toBeGreaterThanOrEqual(THRESHOLDS.routed.precision);
    expect(recallOf(aggregate.routed)).toBeGreaterThanOrEqual(THRESHOLDS.routed.recall);
  });

  it("raises nothing at all on a plain organic marketplace", () => {
    const { signals } = results.get("organic-marketplace");
    expect(signals).toHaveLength(0);
  });
});

describe("known gaps", () => {
  it("does not let gap scenarios influence the enforced metrics", () => {
    const gapNames = GAP_CORPUS.map((build) => build({ now }).name);
    const enforcedNames = ENFORCED_CORPUS.map((build) => build({ now }).name);

    for (const name of gapNames) {
      expect(enforcedNames).not.toContain(name);
    }
    // Every gap scenario is registered with a reason.
    for (const name of gapNames) {
      expect(Object.values(KNOWN_GAPS).some((gap) => gap.scenario === name)).toBe(true);
    }
  });

  it("still reproduces every open gap end to end", () => {
    for (const gap of Object.values(KNOWN_GAPS)) {
      if (gap.status !== "open") continue;
      const result = results.get(gap.scenario);
      expect(result).toBeDefined();

      const signalsFromDetector = result.signals.filter((s) => s.detector === gap.detector);

      if (gap.kind === "recall") {
        // The gap is that nothing fires when it should.
        expect(signalsFromDetector).toHaveLength(0);
      } else {
        // The gap is that something fires when it should not.
        expect(signalsFromDetector.length).toBeGreaterThan(0);
      }
    }
  });
});
