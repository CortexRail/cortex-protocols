/**
 * License service — purchase flow and license lifecycle.
 *
 * purchaseLicense is the canonical example of a multi-table write: it bumps
 * the asset's usage counter AND creates the license row inside a single
 * transaction, so a failure in either statement leaves the database exactly
 * as it was.
 */

const { withTransaction } = require("../db/connection");
const assetRepository = require("../repositories/assetRepository");
const licenseRepository = require("../repositories/licenseRepository");

// Terms applied when the on-chain contract doesn't dictate them explicitly.
const DEFAULT_USAGE_BASED_CALLS = 100;
const SUBSCRIPTION_PERIOD_MS = 30 * 86_400_000; // 30 days

/**
 * Derive license terms from the asset's license model.
 */
function termsFor(asset) {
  switch (asset.licenseType) {
    case "UsageBased":
      return { callsRemaining: DEFAULT_USAGE_BASED_CALLS, expiresAt: null };
    case "Subscription":
      return { callsRemaining: null, expiresAt: Date.now() + SUBSCRIPTION_PERIOD_MS };
    default: // Perpetual, OpenSource
      return { callsRemaining: null, expiresAt: null };
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Purchase a license for an asset.
 *
 * Atomic: increments assets.usage_count and inserts the licenses row in one
 * transaction. If the buyer already holds an active license (unique partial
 * index violation) or the asset is missing/inactive, nothing is persisted.
 *
 * @returns {Promise<{ license: object, usageCount: number }>}
 */
async function purchaseLicense({ assetId, buyer, assetVersion }) {
  return withTransaction(async (client) => {
    const asset = await assetRepository.findById(assetId, {}, client);
    if (!asset) {
      throw httpError(404, `Asset ${assetId} not found or inactive`);
    }

    const selectedVersion = assetVersion ?? asset.version;
    const minimumVersion = Math.max(1, asset.version - 4);
    if (!Number.isInteger(selectedVersion) || selectedVersion < 1) {
      throw httpError(400, "assetVersion must be a positive integer");
    }
    if (selectedVersion > asset.version) {
      throw httpError(
        400,
        `Asset version ${selectedVersion} is newer than current version ${asset.version}`
      );
    }
    if (selectedVersion < minimumVersion) {
      throw httpError(
        400,
        `Asset version ${selectedVersion} is unavailable; retained versions are ${minimumVersion}-${asset.version}`
      );
    }

    // Bump the counter first so a failed license insert exercises a real
    // rollback of prior writes rather than short-circuiting before them.
    const usageCount = await assetRepository.incrementUsage(assetId, client);

    let license;
    try {
      license = await licenseRepository.create(
        {
          assetId,
          assetVersion: selectedVersion,
          buyer,
          licenseType: asset.licenseType,
          pricePaid: asset.price,
          ...termsFor(asset),
        },
        client
      );
    } catch (err) {
      if (err.code === "23505") {
        throw httpError(
          409,
          `Buyer already holds an active license for asset ${assetId}`
        );
      }
      throw err;
    }

    return { license, usageCount };
  });
}

/**
 * Consume one metered call on a license. Returns the updated license,
 * or null when the license is exhausted, expired, or unknown.
 */
async function consumeLicenseCall(licenseId) {
  return licenseRepository.consumeCall(licenseId);
}

/**
 * The buyer's currently-valid license for an asset, if any.
 */
async function getLicense(buyer, assetId) {
  return licenseRepository.findByBuyerAndAsset(buyer, assetId);
}

/**
 * Every license a buyer holds, newest first.
 */
async function listLicensesForBuyer(buyer, { page = 1, limit = 20 } = {}) {
  return licenseRepository.findAllByBuyer(buyer, { page, limit });
}

/**
 * Deactivate a license (subscription lapse, revocation, exhaustion).
 */
async function expireLicense(licenseId) {
  return licenseRepository.expire(licenseId);
}

module.exports = {
  purchaseLicense,
  consumeLicenseCall,
  getLicense,
  listLicensesForBuyer,
  expireLicense,
  DEFAULT_USAGE_BASED_CALLS,
  SUBSCRIPTION_PERIOD_MS,
};
