/**
 * fraudService end-to-end against a real database.
 *
 * The unit-level detector logic is covered elsewhere; what this file pins is
 * everything that only exists once SQL actually runs: the aggregate queries
 * the detectors read, the upsert conflict resolution, and the routing of a
 * high-risk composite into the moderation queue.
 */

const assetRepository = require("../../repositories/assetRepository");
const usageEventRepository = require("../../repositories/usageEventRepository");
const fraudSignalRepository = require("../../repositories/fraudSignalRepository");
const reportRepository = require("../../repositories/reportRepository");
const fraudService = require("../../services/fraudService");
const reportService = require("../../services/reportService");
const { truncateAll, closePool, buildAsset, OWNER_A, OWNER_B } = require("../helpers/testDb");

const HOUR_MS = 3_600_000;

let asset;
let now;

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(
    buildAsset({ owner: OWNER_A, licenseType: "UsageBased" })
  );
  now = Date.now();
});

afterAll(async () => {
  await closePool();
});

/**
 * Seed a usage spike: a thin baseline over the preceding hours, then a burst
 * in the bucket that is still open. Events land one second before `now` so
 * they always fall inside the final bucket regardless of when the suite runs.
 */
async function seedVelocitySpike({ baselineHours = 10, spikeCalls = 60 } = {}) {
  const bucketStart = Math.floor(now / HOUR_MS) * HOUR_MS;

  for (let hour = 1; hour <= baselineHours; hour += 1) {
    await usageEventRepository.record({
      source: "stream",
      streamId: 1,
      assetId: asset.id,
      caller: OWNER_B,
      counterparty: OWNER_A,
      pricePaid: 100,
      occurredAt: bucketStart - hour * HOUR_MS + 1_000,
    });
  }

  for (let i = 0; i < spikeCalls; i += 1) {
    await usageEventRepository.record({
      source: "stream",
      streamId: 1,
      assetId: asset.id,
      caller: OWNER_B,
      counterparty: OWNER_A,
      payloadHash: `hash-${i}`,
      pricePaid: 100,
      occurredAt: now - 1_000,
    });
  }
}

describe("fraudService.runScan", () => {
  it("scores nothing on an empty database", async () => {
    const summary = await fraudService.runScan({ now });

    expect(summary.errors).toEqual([]);
    expect(summary.rawSignals).toBe(0);
    expect(summary.composites).toBe(0);
    expect(summary.reportsRouted).toBe(0);
  });

  it("detects a usage spike and persists an explained signal", async () => {
    await seedVelocitySpike();

    const summary = await fraudService.runScan({ now });

    expect(summary.errors).toEqual([]);
    expect(summary.detectorCounts.velocity).toBeGreaterThan(0);

    const stored = await fraudSignalRepository.findAll(
      { detector: "velocity" },
      { page: 1, limit: 20 }
    );
    expect(stored.meta.total).toBeGreaterThan(0);

    const signal = stored.data[0];
    expect(signal.score).toBeGreaterThan(0);
    // The acceptance criterion: never a bare score.
    expect(signal.explanation.length).toBeGreaterThan(20);
    expect(signal.evidence.metrics.zScore).toBeGreaterThan(3);
  });

  it("routes a high-risk composite into the moderation queue", async () => {
    await seedVelocitySpike();

    const summary = await fraudService.runScan({ now });

    expect(summary.reportsRouted).toBeGreaterThan(0);

    const reports = await reportRepository.findAll({}, { page: 1, limit: 20 });
    expect(reports.meta.total).toBe(1);

    const report = reports.data[0];
    expect(report.source).toBe("automated");
    expect(report.reason).toBe("AutomatedFraud");
    expect(report.reporter).toBe(reportService.AUTOMATED_REPORTER);
    expect(report.details).toContain("Risk");
    expect(report.evidence.signals.length).toBeGreaterThan(0);

    // The composite that raised it is linked back to the report.
    const composites = await fraudSignalRepository.findAll(
      { detector: "composite" },
      { page: 1, limit: 20 }
    );
    const routed = composites.data.find((s) => s.status === "reported");
    expect(routed).toBeDefined();
    expect(routed.reportId).toBe(report.id);
  });

  it("is idempotent: re-scanning the same window creates no duplicates", async () => {
    await seedVelocitySpike();

    await fraudService.runScan({ now });
    const afterFirst = await fraudSignalRepository.findAll({}, { page: 1, limit: 100 });
    const reportsAfterFirst = await reportRepository.findAll({}, { page: 1, limit: 50 });

    await fraudService.runScan({ now });
    const afterSecond = await fraudSignalRepository.findAll({}, { page: 1, limit: 100 });
    const reportsAfterSecond = await reportRepository.findAll({}, { page: 1, limit: 50 });

    expect(afterSecond.meta.total).toBe(afterFirst.meta.total);
    expect(reportsAfterSecond.meta.total).toBe(reportsAfterFirst.meta.total);

    // The already-reported composite kept its report rather than duplicating.
    const reported = afterSecond.data.filter((s) => s.status === "reported");
    expect(reported.length).toBe(
      afterFirst.data.filter((s) => s.status === "reported").length
    );
    expect(reported.every((s) => s.reportId !== null)).toBe(true);
  });

  it("writes nothing on a dry run", async () => {
    await seedVelocitySpike();

    const summary = await fraudService.runScan({ now, dryRun: true });

    expect(summary.composites).toBeGreaterThan(0);
    expect(summary.preview.length).toBeGreaterThan(0);

    const stored = await fraudSignalRepository.findAll({}, { page: 1, limit: 20 });
    const reports = await reportRepository.findAll({}, { page: 1, limit: 20 });
    expect(stored.meta.total).toBe(0);
    expect(reports.meta.total).toBe(0);
  });

  it("leaves a quiet asset alone", async () => {
    // Steady, unremarkable traffic from an unrelated buyer.
    const bucketStart = Math.floor(now / HOUR_MS) * HOUR_MS;
    for (let hour = 0; hour < 12; hour += 1) {
      for (let i = 0; i < 5; i += 1) {
        await usageEventRepository.record({
          source: "stream",
          streamId: 2,
          assetId: asset.id,
          caller: OWNER_B,
          counterparty: OWNER_A,
          payloadHash: `unique-${hour}-${i}`,
          pricePaid: 100,
          occurredAt: bucketStart - hour * HOUR_MS + 1_000,
        });
      }
    }

    const summary = await fraudService.runScan({ now });

    expect(summary.errors).toEqual([]);
    expect(summary.composites).toBe(0);
    expect(summary.reportsRouted).toBe(0);
  });
});

describe("fraudService.getScanStats", () => {
  it("summarises the open queue", async () => {
    await seedVelocitySpike();
    await fraudService.runScan({ now });

    const stats = await fraudService.getScanStats();

    expect(stats.openByTier).toEqual(
      expect.objectContaining({ low: expect.any(Number), critical: expect.any(Number) })
    );
    expect(stats.openTotal).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(stats.recent)).toBe(true);
  });
});
