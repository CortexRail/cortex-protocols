/**
 * Analytics repository — aggregate queries for revenue and usage stats.
 */

const { run } = require("./repoUtils");

/**
 * Total revenue per asset for a given owner.
 * Joins assets with licenses to sum price_paid across all licenses purchased.
 */
async function getRevenueByOwner(owner, client) {
  const { rows } = await run(
    `SELECT
       a.id            AS asset_id,
       a.name          AS asset_name,
       a.asset_type    AS asset_type,
       a.price         AS current_price,
       COUNT(l.id)::int      AS license_count,
       COALESCE(SUM(l.price_paid), 0)::bigint AS total_revenue
     FROM assets a
     LEFT JOIN licenses l ON l.asset_id = a.id
     WHERE a.owner = $1 AND a.is_active
     GROUP BY a.id, a.name, a.asset_type, a.price
     ORDER BY total_revenue DESC`,
    [owner],
    client,
    "read"
  );

  return rows.map((row) => ({
    assetId: row.asset_id,
    assetName: row.asset_name,
    assetType: row.asset_type,
    currentPrice: row.current_price,
    licenseCount: row.license_count,
    totalRevenue: row.total_revenue,
  }));
}

/**
 * Revenue for one asset, broken down by license type. There is no separate
 * "bundle"/tier concept in this system — a license's type (Perpetual,
 * UsageBased, Subscription, OpenSource) is the only revenue segmentation
 * that actually exists in the schema.
 */
async function getRevenueByAssetLicenseType(assetId, client) {
  const { rows } = await run(
    `SELECT
       license_type                            AS license_type,
       COUNT(*)::int                           AS license_count,
       COALESCE(SUM(price_paid), 0)::bigint    AS revenue
     FROM licenses
     WHERE asset_id = $1
     GROUP BY license_type
     ORDER BY revenue DESC`,
    [assetId],
    client,
    "read"
  );

  return rows.map((row) => ({
    licenseType: row.license_type,
    licenseCount: row.license_count,
    revenue: row.revenue,
  }));
}

module.exports = { getRevenueByOwner, getRevenueByAssetLicenseType };
