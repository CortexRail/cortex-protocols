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
