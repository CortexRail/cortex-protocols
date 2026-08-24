/**
 * Price commitment builder for multi-asset settlement.
 * 
 * Builds signed PriceCommitment structs that the contract expects,
 * used by both the backend quote flow and client SDK.
 */

const crypto = require("crypto");
const { logger } = require("../utils/logger");

const COMMITMENT_VERSION = 1;
const COMMITMENT_VALIDITY_SECONDS = 60; // Valid for 60 seconds

/**
 * Build a price commitment for an asset + token pair
 */
function buildPriceCommitment(params) {
  const {
    assetId,
    token,
    usdPriceCents, // e.g., 4200 for $42.00
    slippageTolerance = 5, // 5% by default
    maxLedgerOffset = 50, // Max ledgers into future
  } = params;

  if (!assetId || !token || !usdPriceCents || usdPriceCents <= 0) {
    throw new Error("Invalid price commitment parameters");
  }

  // Calculate max acceptable price with slippage tolerance
  const maxPrice = Math.ceil((usdPriceCents * (100 + slippageTolerance)) / 100);

  // Set expiration ledger (current + offset)
  // In real implementation, would fetch current ledger from Soroban
  const currentLedger = Math.floor(Date.now() / 1000); // Placeholder
  const validUntilLedger = currentLedger + maxLedgerOffset;

  const commitment = {
    version: COMMITMENT_VERSION,
    assetId: BigInt(assetId),
    token: token, // Stellar address
    usdPriceCents: BigInt(usdPriceCents),
    maxPrice: BigInt(maxPrice),
    validUntilLedger: BigInt(validUntilLedger),
    slippageTolerance,
    createdAt: Date.now(),
  };

  // Sign commitment
  const signature = signCommitment(commitment);

  return {
    ...commitment,
    signature,
    maxPriceWithSlippage: maxPrice,
    expiresAt: validUntilLedger,
  };
}

/**
 * Sign a price commitment
 */
function signCommitment(commitment) {
  const secret = process.env.COMMITMENT_SECRET || process.env.JWT_SECRET || "default-secret";

  const message = `${commitment.version}:${commitment.assetId}:${commitment.token}:${commitment.usdPriceCents}:${commitment.maxPrice}:${commitment.validUntilLedger}`;

  const signature = crypto.createHmac("sha256", secret).update(message).digest("hex");

  return signature;
}

/**
 * Validate a price commitment signature and expiration
 */
function validateCommitment(commitment, allowedMaxAge = COMMITMENT_VALIDITY_SECONDS * 1000) {
  if (!commitment || !commitment.signature) {
    return {
      valid: false,
      reason: "MISSING_SIGNATURE",
    };
  }

  const age = Date.now() - commitment.createdAt;
  if (age > allowedMaxAge) {
    return {
      valid: false,
      reason: "EXPIRED",
      age,
      maxAge: allowedMaxAge,
    };
  }

  // Re-sign and compare
  const expectedSignature = signCommitment(commitment);
  if (expectedSignature !== commitment.signature) {
    return {
      valid: false,
      reason: "INVALID_SIGNATURE",
    };
  }

  return {
    valid: true,
    reason: "VALID",
    age,
  };
}

/**
 * Convert price commitment to Soroban contract call format
 */
function toContractFormat(commitment) {
  // This would be used to format for actual Soroban contract invocation
  // Returns the struct in the format expected by set_price_commitment()
  return {
    asset_id: commitment.assetId.toString(),
    token: commitment.token,
    usd_price_cents: commitment.usdPriceCents.toString(),
    max_price: commitment.maxPrice.toString(),
    valid_until_ledger: commitment.validUntilLedger.toString(),
  };
}

/**
 * Build multiple commitments for basket purchase
 */
function buildBasketCommitments(basketItems) {
  const commitments = [];

  for (const item of basketItems) {
    try {
      const commitment = buildPriceCommitment(item);
      commitments.push({
        assetId: item.assetId,
        commitment,
      });
    } catch (err) {
      logger.warn(`Failed to build commitment for asset ${item.assetId}:`, err.message);
    }
  }

  if (commitments.length === 0) {
    throw new Error("Failed to build any valid price commitments");
  }

  return commitments;
}

module.exports = {
  buildPriceCommitment,
  validateCommitment,
  signCommitment,
  toContractFormat,
  buildBasketCommitments,
  COMMITMENT_VALIDITY_SECONDS,
  COMMITMENT_VERSION,
};
