/**
 * Report service — files community moderation reports against assets and
 * auto-flags an asset once its report count crosses FLAG_THRESHOLD.
 *
 * fileReport mirrors licenseService.purchaseLicense: the report insert and
 * the (conditional) asset flag update happen inside one transaction, so a
 * failure in either leaves the database exactly as it was.
 */

const { withTransaction } = require("../db/connection");
const assetRepository = require("../repositories/assetRepository");
const reportRepository = require("../repositories/reportRepository");

// Matches the `reason` CHECK constraint on the reports table.
const REPORT_REASONS = [
  "Spam",
  "Plagiarism",
  "Malicious",
  "Misleading",
  "PolicyViolation",
  "Other",
];

// An asset is auto-flagged once it has strictly more than this many reports.
const FLAG_THRESHOLD = 5;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * File a moderation report against an asset.
 *
 * @returns {Promise<{ report: object, flagged: boolean }>}
 */
async function fileReport({ assetId, reporter, reason, details }) {
  return withTransaction(async (client) => {
    const asset = await assetRepository.findById(
      assetId,
      { includeInactive: true },
      client
    );
    if (!asset) {
      throw httpError(404, `Asset ${assetId} not found`);
    }

    let report;
    try {
      report = await reportRepository.create(
        { assetId, reporter, reason, details },
        client
      );
    } catch (err) {
      if (err.code === "23505") {
        throw httpError(
          409,
          "You already have an open report for this asset"
        );
      }
      if (err.code === "23514") {
        throw httpError(422, "Invalid report reason");
      }
      throw err;
    }

    let flagged = asset.flagged;
    if (!flagged) {
      const total = await reportRepository.countForAsset(assetId, client);
      if (total > FLAG_THRESHOLD) {
        const flaggedAsset = await assetRepository.flagAsset(assetId, client);
        flagged = flaggedAsset.flagged;
      }
    }

    return { report, flagged };
  });
}

/**
 * List moderation reports for the admin dashboard, with the related asset
 * attached to each report.
 */
async function listReportsForAdmin({
  status,
  assetId,
  page = 1,
  limit = 20,
} = {}) {
  const result = await reportRepository.findAll(
    { status, assetId },
    { page, limit }
  );

  const uniqueAssetIds = [...new Set(result.data.map((r) => r.assetId))];
  const assets = await Promise.all(
    uniqueAssetIds.map((id) =>
      assetRepository.findById(id, { includeInactive: true })
    )
  );
  const assetById = new Map(assets.filter(Boolean).map((a) => [a.id, a]));

  return {
    ...result,
    data: result.data.map((report) => ({
      ...report,
      asset: assetById.get(report.assetId) || null,
    })),
  };
}

module.exports = {
  fileReport,
  listReportsForAdmin,
  REPORT_REASONS,
  FLAG_THRESHOLD,
};
