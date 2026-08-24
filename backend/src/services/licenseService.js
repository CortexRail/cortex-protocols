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
const contractStateRepository = require("../repositories/contractStateRepository");
const usageEventRepository = require("../repositories/usageEventRepository");

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
  if (await contractStateRepository.isPaused("marketplace")) {
    throw httpError(503, "marketplace is paused by an operator; license purchases are disabled");
  }

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

    // Route through approval workflow if policy threshold is exceeded
    const approvalWorkflowService = require("./approvalWorkflowService");
    const policy = await approvalWorkflowService.getPolicy(buyer);
    if (policy && asset.price > policy.threshold) {
      const proposal = await approvalWorkflowService.proposePurchase({
        orgId: buyer,
        assetId: asset.id,
        assetVersion: selectedVersion,
        buyer,
        price: asset.price
      });
      return { proposal, message: "Purchase requires approval. Proposal created." };
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
 *
 * The decrement and the usage-log write share one transaction, so the fraud
 * detectors' view of billed calls can never drift from the counter. A call
 * that consumed nothing (exhausted/unknown licence) logs nothing.
 *
 * @param {number} licenseId
 * @param {object} [options]
 * @param {string|null} [options.payloadHash] - canonical request-payload hash
 */
async function consumeLicenseCall(licenseId, { payloadHash = null } = {}) {
  return withTransaction(async (client) => {
    const license = await licenseRepository.consumeCall(licenseId, client);
    if (!license) return null;

    await usageEventRepository.record(
      {
        source: "license",
        licenseId: license.id,
        assetId: license.assetId,
        caller: license.buyer,
        // The payee is assets.owner, which detectors resolve through asset_id
        // rather than making every metered call pay for a join.
        counterparty: null,
        payloadHash,
        // Licences are paid for up front, so an individual call carries no
        // revenue: wash-usage scoring weighs call share for these, not value.
        pricePaid: 0,
      },
      client
    );

    return license;
  });
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

/**
 * Buy additional calls for an existing usage-based license.
 *
 * There is no separate per-call price field: a top-up buys calls at the same
 * effective rate as the license's original allotment (asset.price for
 * DEFAULT_USAGE_BASED_CALLS calls), so `pricePerCall = ceil(asset.price /
 * DEFAULT_USAGE_BASED_CALLS)`. The charge is added to the license's
 * price_paid (so lifetime revenue stays accurate) and logged as a
 * zero-count-impact usage event so per-asset revenue analytics pick it up
 * the same way a fresh purchase does.
 *
 * @returns {Promise<{ license: object, amountCharged: number, callsAdded: number }>}
 */
async function topUpLicense({ licenseId, buyer, calls }) {
  if (!Number.isInteger(calls) || calls < 1) {
    throw httpError(400, "calls must be a positive integer");
  }

  return withTransaction(async (client) => {
    const license = await licenseRepository.findById(licenseId, client);
    if (!license) {
      throw httpError(404, `License ${licenseId} not found`);
    }
    if (license.buyer !== buyer) {
      throw httpError(403, "This license does not belong to the given buyer");
    }
    if (license.licenseType !== "UsageBased") {
      throw httpError(400, "Only usage-based licenses can be topped up");
    }
    if (!license.isActive) {
      throw httpError(400, "License is not active");
    }

    const asset = await assetRepository.findById(license.assetId, { includeInactive: true }, client);
    if (!asset) {
      throw httpError(404, `Asset ${license.assetId} not found`);
    }

    const pricePerCall = Math.ceil(asset.price / DEFAULT_USAGE_BASED_CALLS);
    const amountCharged = pricePerCall * calls;

    const updated = await licenseRepository.addCallsAndPrice(
      licenseId,
      { addCalls: calls, addPricePaid: amountCharged },
      client
    );
    if (!updated) {
      throw httpError(409, "License is no longer eligible for top-up");
    }

    await usageEventRepository.record(
      {
        source: "license",
        licenseId: updated.id,
        assetId: updated.assetId,
        caller: buyer,
        counterparty: asset.owner,
        payloadHash: null,
        pricePaid: amountCharged,
      },
      client
    );

    return { license: updated, amountCharged, callsAdded: calls };
  });
}

/**
 * Operator revocation: immediately zeroes the metered-call counter so a
 * usage-based license can't be drawn on further. Used by
 * `cortex-admin license revoke`.
 */
async function revokeLicense(licenseId) {
  const license = await licenseRepository.updateCallsRemaining(licenseId, 0);
  if (!license) {
    throw httpError(404, `License ${licenseId} not found`);
  }
  return license;
}

module.exports = {
  purchaseLicense,
  consumeLicenseCall,
  getLicense,
  listLicensesForBuyer,
  expireLicense,
  topUpLicense,
  revokeLicense,
  DEFAULT_USAGE_BASED_CALLS,
  SUBSCRIPTION_PERIOD_MS,
};
