const { Keypair } = require("@stellar/stellar-sdk");
const assetRepository = require("../../repositories/assetRepository");
const reportRepository = require("../../repositories/reportRepository");
const reportService = require("../../services/reportService");
const { truncateAll, closePool, buildAsset } = require("../helpers/testDb");

let asset;

// A fresh, checksum-valid reporter key — each report needs a distinct
// reporter to avoid the one-open-report-per-reporter unique index.
function reporter() {
  return Keypair.random().publicKey();
}

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(buildAsset());
});

afterAll(async () => {
  await closePool();
});

describe("reportService.fileReport", () => {
  it("files a report without flagging the asset below the threshold", async () => {
    const result = await reportService.fileReport({
      assetId: asset.id,
      reporter: reporter(),
      reason: "Spam",
      details: "Looks like spam.",
    });

    expect(result.report.assetId).toBe(asset.id);
    expect(result.report.status).toBe("Pending");
    expect(result.flagged).toBe(false);
  });

  it("flags the asset once report count crosses the threshold", async () => {
    let result;
    for (let i = 0; i < reportService.FLAG_THRESHOLD; i++) {
      result = await reportService.fileReport({
        assetId: asset.id,
        reporter: reporter(),
        reason: "Spam",
      });
      expect(result.flagged).toBe(false);
    }

    // One more report crosses the threshold (count > FLAG_THRESHOLD).
    result = await reportService.fileReport({
      assetId: asset.id,
      reporter: reporter(),
      reason: "Spam",
    });
    expect(result.flagged).toBe(true);

    const flaggedAsset = await assetRepository.findById(asset.id, {
      includeInactive: true,
    });
    expect(flaggedAsset.flagged).toBe(true);
    expect(flaggedAsset.flaggedAt).not.toBeNull();
  });

  it("does not remove or deactivate a flagged asset", async () => {
    for (let i = 0; i <= reportService.FLAG_THRESHOLD; i++) {
      await reportService.fileReport({
        assetId: asset.id,
        reporter: reporter(),
        reason: "Spam",
      });
    }

    const flaggedAsset = await assetRepository.findById(asset.id);
    expect(flaggedAsset).not.toBeNull();
    expect(flaggedAsset.isActive).toBe(true);
  });

  it("persists the report row exactly as submitted", async () => {
    const rep = reporter();
    const { report } = await reportService.fileReport({
      assetId: asset.id,
      reporter: rep,
      reason: "Malicious",
      details: "Contains a prompt injection payload.",
    });

    const found = await reportRepository.findById(report.id);
    expect(found.reporter).toBe(rep);
    expect(found.reason).toBe("Malicious");
    expect(found.details).toBe("Contains a prompt injection payload.");
  });

  it("throws a 404 for an unknown asset", async () => {
    await expect(
      reportService.fileReport({
        assetId: 999_999,
        reporter: reporter(),
        reason: "Spam",
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("throws a 409 on a duplicate open report from the same reporter", async () => {
    const rep = reporter();
    await reportService.fileReport({ assetId: asset.id, reporter: rep, reason: "Spam" });

    await expect(
      reportService.fileReport({ assetId: asset.id, reporter: rep, reason: "Other" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("throws a 422 for an unrecognized reason", async () => {
    await expect(
      reportService.fileReport({
        assetId: asset.id,
        reporter: reporter(),
        reason: "NotARealReason",
      })
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("reportService.listReportsForAdmin", () => {
  it("attaches the related asset to each report", async () => {
    await reportService.fileReport({ assetId: asset.id, reporter: reporter(), reason: "Spam" });

    const { data } = await reportService.listReportsForAdmin();
    expect(data).toHaveLength(1);
    expect(data[0].asset).not.toBeNull();
    expect(data[0].asset.id).toBe(asset.id);
  });

  it("filters by status and assetId", async () => {
    const other = await assetRepository.create(buildAsset());
    await reportService.fileReport({ assetId: asset.id, reporter: reporter(), reason: "Spam" });
    await reportService.fileReport({ assetId: other.id, reporter: reporter(), reason: "Other" });

    const { data, meta } = await reportService.listReportsForAdmin({ assetId: asset.id });
    expect(data).toHaveLength(1);
    expect(data[0].assetId).toBe(asset.id);
    expect(meta.total).toBe(1);
  });
});
