const assetRepository = require("../../repositories/assetRepository");
const reportRepository = require("../../repositories/reportRepository");
const {
  truncateAll,
  closePool,
  buildAsset,
  OWNER_A,
  OWNER_B,
} = require("../helpers/testDb");

let asset;

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(buildAsset());
});

afterAll(async () => {
  await closePool();
});

function buildReport(overrides = {}) {
  return {
    assetId: asset.id,
    reporter: OWNER_B,
    reason: "Spam",
    details: "This asset is duplicated spam content.",
    ...overrides,
  };
}

describe("reportRepository.create", () => {
  it("files a report in Pending state", async () => {
    const report = await reportRepository.create(buildReport());

    expect(report.id).toBeGreaterThan(0);
    expect(report.assetId).toBe(asset.id);
    expect(report.reporter).toBe(OWNER_B);
    expect(report.reason).toBe("Spam");
    expect(report.status).toBe("Pending");
    expect(report.resolvedAt).toBeNull();
  });

  it("rejects a duplicate open report from the same reporter", async () => {
    await reportRepository.create(buildReport());
    await expect(reportRepository.create(buildReport())).rejects.toThrow();
  });

  it("allows a new report after the previous one was resolved", async () => {
    const first = await reportRepository.create(buildReport());
    await reportRepository.updateStatus(first.id, "Resolved", "removed");
    const second = await reportRepository.create(buildReport());
    expect(second.id).not.toBe(first.id);
  });

  it("rejects an unknown reason", async () => {
    await expect(
      reportRepository.create(buildReport({ reason: "JustVibes" }))
    ).rejects.toThrow();
  });
});

describe("reportRepository.findById / findAll", () => {
  it("finds a report by id", async () => {
    const created = await reportRepository.create(buildReport());
    const found = await reportRepository.findById(created.id);
    expect(found.id).toBe(created.id);
  });

  it("returns null for a missing report", async () => {
    expect(await reportRepository.findById(70_707)).toBeNull();
  });

  it("filters by status and assetId", async () => {
    const other = await assetRepository.create(buildAsset());
    await reportRepository.create(buildReport());
    await reportRepository.create(
      buildReport({ assetId: other.id, reporter: OWNER_A })
    );

    const pendingForAsset = await reportRepository.findAll({
      status: "Pending",
      assetId: asset.id,
    });
    expect(pendingForAsset.data).toHaveLength(1);
    expect(pendingForAsset.data[0].assetId).toBe(asset.id);
  });
});

describe("reportRepository.updateStatus", () => {
  it("moves a report through the moderation flow", async () => {
    const created = await reportRepository.create(buildReport());

    const reviewing = await reportRepository.updateStatus(created.id, "UnderReview");
    expect(reviewing.status).toBe("UnderReview");
    expect(reviewing.resolvedAt).toBeNull();

    const resolved = await reportRepository.updateStatus(
      created.id,
      "Resolved",
      "asset delisted"
    );
    expect(resolved.status).toBe("Resolved");
    expect(resolved.resolutionNote).toBe("asset delisted");
    expect(resolved.resolvedAt).not.toBeNull();
  });

  it("returns null for unknown report", async () => {
    expect(await reportRepository.updateStatus(60_606, "Dismissed")).toBeNull();
  });
});

describe("reportRepository.countForAsset", () => {
  it("counts all reports regardless of status", async () => {
    const first = await reportRepository.create(buildReport({ reporter: OWNER_A }));
    await reportRepository.updateStatus(first.id, "Dismissed");
    await reportRepository.create(buildReport({ reporter: OWNER_B }));

    expect(await reportRepository.countForAsset(asset.id)).toBe(2);
  });

  it("returns 0 for an asset with no reports", async () => {
    const other = await assetRepository.create(buildAsset());
    expect(await reportRepository.countForAsset(other.id)).toBe(0);
  });
});

/**
 * `upsertAutomated` leans on ON CONFLICT inferring the pre-existing partial
 * unique index `idx_reports_one_open_per_reporter`, whose predicate is
 * `status IN ('Pending','UnderReview')`. That index was written to stop humans
 * spamming reports; the scanner reuses it so repeated scans refresh a single
 * queue item per asset instead of filing a new report every cycle.
 */
describe("reportRepository.upsertAutomated", () => {
  const SCANNER = "system:fraud-scan";

  function buildAutomated(overrides = {}) {
    return {
      assetId: asset.id,
      reporter: SCANNER,
      reason: "AutomatedFraud",
      details: "Risk CRITICAL (score 0.92): wash usage and sybil cluster agreed.",
      evidence: { detectorCount: 2, signals: [{ detector: "wash_usage", rawScore: 0.98 }] },
      ...overrides,
    };
  }

  it("files an automated report with source and evidence", async () => {
    const report = await reportRepository.upsertAutomated(buildAutomated());

    expect(report.id).toBeGreaterThan(0);
    expect(report.source).toBe("automated");
    expect(report.reason).toBe("AutomatedFraud");
    expect(report.status).toBe("Pending");
    expect(report.evidence).toEqual({
      detectorCount: 2,
      signals: [{ detector: "wash_usage", rawScore: 0.98 }],
    });
  });

  it("refreshes the open report instead of raising a duplicate-key error", async () => {
    const first = await reportRepository.upsertAutomated(buildAutomated());
    const second = await reportRepository.upsertAutomated(
      buildAutomated({
        details: "Risk CRITICAL (score 0.97): evidence strengthened.",
        evidence: { detectorCount: 3 },
      })
    );

    expect(second.id).toBe(first.id);
    expect(second.details).toContain("0.97");
    expect(second.evidence).toEqual({ detectorCount: 3 });

    const all = await reportRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(1);
  });

  it("files a new report once the previous one has been resolved", async () => {
    const first = await reportRepository.upsertAutomated(buildAutomated());
    await reportRepository.updateStatus(first.id, "Resolved", "not fraud after review");

    // A resolved report leaves the partial index, so a later recurrence opens
    // a genuinely new case rather than silently reopening a closed one.
    const second = await reportRepository.upsertAutomated(buildAutomated());

    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("Pending");

    const all = await reportRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(2);
  });

  it("does not collide with a human report on the same asset", async () => {
    await reportRepository.create(buildReport());
    const automated = await reportRepository.upsertAutomated(buildAutomated());

    expect(automated.source).toBe("automated");

    const all = await reportRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(2);
    expect(all.data.map((r) => r.source).sort()).toEqual(["automated", "user"]);
  });

  it("still rejects an unknown reason", async () => {
    await expect(
      reportRepository.upsertAutomated(buildAutomated({ reason: "NotARealReason" }))
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("defaults reports filed by a human to source 'user'", async () => {
    const report = await reportRepository.create(buildReport());

    expect(report.source).toBe("user");
    expect(report.evidence).toBeNull();
  });
});
