/**
 * Asset analytics service — owner-facing usage and revenue views for a
 * single asset, backing the `/dashboard/analytics/[assetId]` page.
 *
 * Every function here is scoped to the asset's owner: the caller supplies
 * `owner` and it's checked against `assets.owner` before any data is
 * returned, since per-caller usage detail (who is calling, how often) is
 * more sensitive than the aggregate figures the rest of the analytics API
 * exposes.
 */

const assetRepository = require("../repositories/assetRepository");
const usageEventRepository = require("../repositories/usageEventRepository");
const analyticsRepository = require("../repositories/analyticsRepository");
const licenseRepository = require("../repositories/licenseRepository");

const DEFAULT_TOP_CALLERS_LIMIT = 10;
const MAX_TOP_CALLERS_LIMIT = 50;
const DEFAULT_BUCKET_SECONDS = 86_400; // daily

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function assertOwnedAsset(assetId, owner) {
  const asset = await assetRepository.findById(assetId, { includeInactive: true });
  if (!asset) {
    throw httpError(404, `Asset ${assetId} not found`);
  }
  if (asset.owner !== owner) {
    throw httpError(403, "Only the asset's owner can view its analytics");
  }
  return asset;
}

/**
 * Calls-and-revenue time series for one asset, bucketed (daily by default).
 */
async function getUsageSeries({ assetId, owner, from, to, bucketSeconds }) {
  await assertOwnedAsset(assetId, owner);

  const now = Date.now();
  const rangeTo = to ?? now;
  const rangeFrom = from ?? rangeTo - 7 * 86_400_000;

  const series = await usageEventRepository.callCountsByBucket({
    subject: "asset",
    assetId,
    from: rangeFrom,
    to: rangeTo,
    bucketSeconds: bucketSeconds ?? DEFAULT_BUCKET_SECONDS,
  });

  return {
    data: series.map(({ bucketStart, calls, revenue }) => ({ bucketStart, calls, revenue })),
    from: rangeFrom,
    to: rangeTo,
    bucketSeconds: bucketSeconds ?? DEFAULT_BUCKET_SECONDS,
  };
}

/**
 * The busiest callers for one asset in a window, most calls first.
 */
async function getTopCallers({ assetId, owner, from, to, limit }) {
  await assertOwnedAsset(assetId, owner);

  const now = Date.now();
  const rangeTo = to ?? now;
  const rangeFrom = from ?? rangeTo - 30 * 86_400_000;
  const cappedLimit = Math.min(MAX_TOP_CALLERS_LIMIT, Math.max(1, limit ?? DEFAULT_TOP_CALLERS_LIMIT));

  const rows = await usageEventRepository.assetUsageByCaller({
    assetId,
    from: rangeFrom,
    to: rangeTo,
    minAssetCalls: 1,
  });

  return {
    data: rows
      .slice(0, cappedLimit)
      .map(({ caller, calls, revenue, firstSeen, lastSeen }) => ({
        caller,
        calls,
        revenue,
        firstSeen,
        lastSeen,
      })),
    from: rangeFrom,
    to: rangeTo,
  };
}

/**
 * Revenue for the asset broken down by license type (the only revenue
 * segmentation that exists — there is no separate bundle/tier concept).
 */
async function getRevenueBreakdown({ assetId, owner }) {
  await assertOwnedAsset(assetId, owner);

  const data = await analyticsRepository.getRevenueByAssetLicenseType(assetId);
  const totalRevenue = data.reduce((sum, row) => sum + row.revenue, 0);
  return { data, totalRevenue };
}

/**
 * Aggregate remaining-call runway across every active usage-based license
 * for the asset.
 */
async function getRemainingCalls({ assetId, owner }) {
  await assertOwnedAsset(assetId, owner);
  return licenseRepository.sumRemainingCallsForAsset(assetId);
}

module.exports = {
  getUsageSeries,
  getTopCallers,
  getRevenueBreakdown,
  getRemainingCalls,
};
