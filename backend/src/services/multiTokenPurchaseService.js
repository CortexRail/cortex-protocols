/**
 * Multi-token purchase service.
 *
 * Extends the license purchase flow to support multiple accepted tokens per asset.
 * Integrates with PriceOracleAggregator to get live price commitments and validate
 * slippage tolerance before executing the on-chain purchase.
 */

const { withTransaction } = require("../db/connection");
const assetRepository = require("../repositories/assetRepository");
const licenseRepository = require("../repositories/licenseRepository");
const contractStateRepository = require("../repositories/contractStateRepository");
const priceOracleAggregator = require("../pricing/PriceOracleAggregator");
const priceCommitmentBuilder = require("../pricing/PriceCommitmentBuilder");
const stalenessGuard = require("../pricing/StalenessGuard");
const logger = require("../middleware/logger");

// License terms defaults
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
 * Get a live price commitment for multi-token purchase.
 *
 * Fetches current USD price from oracle aggregator, applies slippage tolerance,
 * and builds a signed commitment that the contract will validate.
 *
 * @param {object} params
 * @param {number} params.assetId
 * @param {string} params.token - Stellar address of the payment token
 * @param {number} params.slippageTolerance - % tolerance (e.g., 5 for 5%)
 * @returns {Promise<{commitment, oraclePrice, actualPrice}>}
 */
async function getPriceCommitment({
  assetId,
  token,
  slippageTolerance = 5,
}) {
  if (!assetId || !token) {
    throw httpError(400, "assetId and token are required");
  }

  const asset = await assetRepository.findById(assetId);
  if (!asset) {
    throw httpError(404, `Asset ${assetId} not found`);
  }

  if (!asset.usdPriceCents || asset.usdPriceCents <= 0) {
    throw httpError(400, `Asset ${assetId} has no valid USD price configured`);
  }

  if (!asset.acceptedTokens || asset.acceptedTokens.length === 0) {
    throw httpError(400, `Asset ${assetId} has no accepted tokens configured`);
  }

  // Validate token is accepted
  if (!asset.acceptedTokens.includes(token)) {
    throw httpError(400, `Token ${token} is not accepted for asset ${assetId}`);
  }

  try {
    // Get aggregated price from oracle
    const oracleData = await priceOracleAggregator.aggregatePrices(token, "USD");

    // Validate freshness
    const freshness = stalenessGuard.validatePrice(oracleData, {
      name: "oracle-aggregator",
    });

    if (!freshness.valid) {
      throw httpError(
        503,
        `Oracle price is stale (${freshness.reason}): ${freshness.age}ms old`
      );
    }

    // Build commitment with slippage tolerance
    const commitment = priceCommitmentBuilder.buildPriceCommitment({
      assetId,
      token,
      usdPriceCents: asset.usdPriceCents,
      slippageTolerance,
    });

    return {
      commitment,
      oraclePrice: oracleData.price,
      priceMetadata: {
        sources: oracleData.sources,
        deviation: oracleData.deviation,
        timestamp: oracleData.timestamp,
      },
    };
  } catch (err) {
    logger.error(`Failed to get price commitment for asset ${assetId}:`, err.message);
    if (err.status) {
      throw err;
    }
    throw httpError(503, "Failed to fetch oracle price; please try again later");
  }
}

/**
 * Purchase a license with multi-token support.
 *
 * Atomic: increments asset usage counter, creates license row, and records
 * the purchased token and price commitment in a single transaction.
 *
 * @param {object} params
 * @param {number} params.assetId
 * @param {string} params.buyer - Stellar address
 * @param {string} params.token - Payment token address
 * @param {object} params.commitment - Price commitment from getPriceCommitment
 * @param {number} params.assetVersion - (optional) Historic version to purchase
 * @returns {Promise<{license, commitment, token}>}
 */
async function purchaseMultiTokenLicense({
  assetId,
  buyer,
  token,
  commitment,
  assetVersion,
}) {
  if (await contractStateRepository.isPaused("marketplace")) {
    throw httpError(503, "marketplace is paused; license purchases are disabled");
  }

  if (!assetId || !buyer || !token || !commitment) {
    throw httpError(400, "assetId, buyer, token, and commitment are required");
  }

  return withTransaction(async (client) => {
    const asset = await assetRepository.findById(assetId, {}, client);
    if (!asset) {
      throw httpError(404, `Asset ${assetId} not found or inactive`);
    }

    // Version validation
    const selectedVersion = assetVersion ?? asset.version;
    const minimumVersion = Math.max(1, asset.version - 4);
    if (!Number.isInteger(selectedVersion) || selectedVersion < 1) {
      throw httpError(400, "assetVersion must be a positive integer");
    }
    if (selectedVersion > asset.version) {
      throw httpError(
        400,
        `Asset version ${selectedVersion} is newer than current ${asset.version}`
      );
    }
    if (selectedVersion < minimumVersion) {
      throw httpError(
        400,
        `Asset version ${selectedVersion} is unavailable; retained: ${minimumVersion}-${asset.version}`
      );
    }

    // Verify commitment validity
    const commitmentValidation = priceCommitmentBuilder.validateCommitment(commitment);
    if (!commitmentValidation.valid) {
      throw httpError(400, `Commitment invalid: ${commitmentValidation.reason}`);
    }

    // Increment usage counter
    const usageCount = await assetRepository.incrementUsage(assetId, client);

    let license;
    try {
      license = await licenseRepository.create(
        {
          assetId,
          assetVersion: selectedVersion,
          buyer,
          token, // Store the token used for this purchase
          licenseType: asset.licenseType,
          pricePaid: asset.usdPriceCents, // Store USD price, not raw token amount
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

    logger.info(
      `License purchased: buyer=${buyer}, asset=${assetId}, token=${token}, version=${selectedVersion}`
    );

    return {
      license,
      token,
      commitment,
      usageCount,
    };
  });
}

module.exports = {
  getPriceCommitment,
  purchaseMultiTokenLicense,
};
