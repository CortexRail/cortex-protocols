/**
 * BondCalculator calculates required collateral bond for listing an asset or opening a dispute.
 *
 * Rules:
 * 1. Base seller collateral bond is proportional to asset price (default 10% or minimum base collateral).
 * 2. Risk factor increases with seller dispute history (e.g. +5% per lost dispute).
 * 3. Active open disputes against seller scale bond requirement multiplicatively.
 * 4. Buyer dispute bond matches required seller bond to ensure symmetrical skin-in-the-game.
 */

class BondCalculator {
  constructor(options = {}) {
    this.baseRatioBps = BigInt(options.baseRatioBps || 1000); // 10% (1000 bps)
    this.minBondAmount = BigInt(options.minBondAmount || 10000000); // 1 XLM (10^7 stroops)
    this.lostDisputePenaltyBps = BigInt(options.lostDisputePenaltyBps || 500); // +5% per lost dispute
    this.activeDisputeMultiplier = BigInt(options.activeDisputeMultiplier || 2); // 2x penalty if active dispute exists
    this.bpsBase = 10000n;
  }

  /**
   * Calculates required seller collateral bond for listing an asset.
   * @param {string|number|BigInt} assetPrice - Asset price in stroops
   * @param {Object} sellerHistory - Seller reputation metrics
   * @param {number} sellerHistory.disputesLost - Count of disputes lost by seller
   * @param {number} sellerHistory.disputesWon - Count of disputes won by seller
   * @param {number} activeDisputeCount - Count of currently unresolved disputes against seller assets
   * @returns {string} Bond amount in stroops as string
   */
  calculateBond(assetPrice, sellerHistory = {}, activeDisputeCount = 0) {
    const price = BigInt(assetPrice || 0);
    const disputesLost = BigInt(sellerHistory.disputesLost || 0);

    // Dynamic bps ratio = base 10% + (5% * disputesLost)
    let dynamicRatioBps = this.baseRatioBps + (disputesLost * this.lostDisputePenaltyBps);
    if (dynamicRatioBps > 5000n) {
      dynamicRatioBps = 5000n; // Cap ratio at 50% max
    }

    let calculatedBond = (price * dynamicRatioBps) / this.bpsBase;

    // Apply minimum bond threshold
    if (calculatedBond < this.minBondAmount) {
      calculatedBond = this.minBondAmount;
    }

    // Apply active dispute multiplier
    if (activeDisputeCount > 0) {
      const multiplier = BigInt(activeDisputeCount) * this.activeDisputeMultiplier;
      calculatedBond = calculatedBond * multiplier;
    }

    return calculatedBond.toString();
  }

  /**
   * Calculates required buyer dispute bond for opening a dispute against a license.
   * @param {string|number|BigInt} assetPrice - Asset price in stroops
   * @param {string|number|BigInt} sellerBond - Bond posted by seller for asset
   * @returns {string} Buyer bond required in stroops as string
   */
  calculateBuyerDisputeBond(assetPrice, sellerBond = null) {
    if (sellerBond) {
      // Buyer bond matches seller bond to guarantee symmetrical risk
      return BigInt(sellerBond).toString();
    }
    return this.calculateBond(assetPrice);
  }
}

module.exports = { BondCalculator };
