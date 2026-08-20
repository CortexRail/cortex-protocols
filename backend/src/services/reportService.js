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

// Matches the `reason` CHECK constraint on the reports table. 'AutomatedFraud'
// is deliberately absent: it is reserved for the fraud scan and is not offered
// to humans filing a report through the API.
const REPORT_REASONS = [
  "Spam",
  "Plagiarism",
  "Malicious",
  "Misleading",
  "PolicyViolation",
  "Other",
];

// Reporter identity every automated flag is filed under. Stable on purpose:
// the one-open-report-per-reporter index then collapses repeated scans of the
// same asset into a single queue item.
const AUTOMATED_REPORTER = "system:fraud-scan";
const AUTOMATED_REASON = "AutomatedFraud";

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
 * Route a high-risk fraud signal into the existing moderation queue.
 *
 * This is the automated sibling of fileReport: same table, same statuses, same
 * admin views — a moderator triages an automated flag exactly the way they
 * triage a user report, with `source: 'automated'` and the explainability
 * payload attached so they can see why it fired.
 *
 * Repeated scans of the same asset refresh one report instead of filing many
 * (see reportRepository.upsertAutomated), so this is safe to call every cycle.
 *
 * @param {object} input
 * @param {number} input.assetId
 * @param {string} input.explanation - human-readable; becomes the report body
 * @param {object} input.evidence - the signal's explainability payload
 * @returns {Promise<{ report: object, flagged: boolean }>}
 */
async function fileAutomatedReport({ assetId, explanation, evidence }) {
  if (!explanation || !String(explanation).trim()) {
    throw httpError(422, "An automated report requires a human-readable explanation");
  }

  return withTransaction(async (client) => {
    const asset = await assetRepository.findById(
      assetId,
      { includeInactive: true },
      client
    );
    if (!asset) {
      throw httpError(404, `Asset ${assetId} not found`);
    }

    const report = await reportRepository.upsertAutomated(
      {
        assetId,
        reporter: AUTOMATED_REPORTER,
        reason: AUTOMATED_REASON,
        details: explanation,
        evidence,
      },
      client
    );

    // Automated flags count toward the auto-flag threshold like any other
    // report. Because the scan holds a single open report per asset it can
    // only ever contribute one, so it cannot flag an asset on its own.
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
  fileAutomatedReport,
  listReportsForAdmin,
  REPORT_REASONS,
  FLAG_THRESHOLD,
  AUTOMATED_REPORTER,
  AUTOMATED_REASON,
};
