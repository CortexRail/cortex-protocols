/**
 * GriefingAnalyzer detects frivolous disputes, buyer extortion patterns,
 * and malicious seller asset replacement behavior.
 */

class GriefingAnalyzer {
  constructor(options = {}) {
    this.highDisputeRateThreshold = options.highDisputeRateThreshold || 0.4; // 40% dispute rate
    this.minPurchasesForAnalysis = options.minPurchasesForAnalysis || 5;
    this.maxDuplicateClaims = options.maxDuplicateClaims || 2;
  }

  /**
   * Analyzes buyer dispute history for extortion or frivolous dispute patterns.
   * @param {string} buyerAddress - Buyer wallet address
   * @param {Array<Object>} buyerDisputes - Historical disputes raised by buyer
   * @param {Array<Object>} buyerPurchases - Total purchases made by buyer
   * @returns {Object} Analysis score & warning flags
   */
  analyzeBuyerBehavior(buyerAddress, buyerDisputes = [], buyerPurchases = []) {
    const totalPurchases = buyerPurchases.length;
    const totalDisputes = buyerDisputes.length;

    const lostDisputes = buyerDisputes.filter(d => d.outcome === 'SELLER_WINS').length;
    const wonDisputes = buyerDisputes.filter(d => d.outcome === 'BUYER_WINS').length;

    const disputeRatio = totalPurchases > 0 ? totalDisputes / totalPurchases : 0;
    const lossRatio = totalDisputes > 0 ? lostDisputes / totalDisputes : 0;

    // Check for duplicate claim hashes (copy-paste frivolous evidence)
    const claimHashes = buyerDisputes.map(d => d.buyerClaimHash).filter(Boolean);
    const hashCounts = {};
    let duplicateHashCount = 0;
    for (const h of claimHashes) {
      hashCounts[h] = (hashCounts[h] || 0) + 1;
      if (hashCounts[h] > 1) duplicateHashCount++;
    }

    const isHighRiskGriefer =
      (totalPurchases >= this.minPurchasesForAnalysis && disputeRatio >= this.highDisputeRateThreshold && lossRatio > 0.5) ||
      duplicateHashCount >= this.maxDuplicateClaims;

    return {
      buyerAddress,
      totalPurchases,
      totalDisputes,
      wonDisputes,
      lostDisputes,
      disputeRatio,
      lossRatio,
      duplicateHashCount,
      isHighRiskGriefer,
      recommendation: isHighRiskGriefer ? 'REQUIRE_EXTRA_BUYER_BOND' : 'ALLOW_STANDARD_DISPUTE',
    };
  }

  /**
   * Analyzes seller risk profile.
   * @param {string} sellerAddress - Seller wallet address
   * @param {Array<Object>} sellerDisputes - Disputes filed against seller
   * @returns {Object} Seller risk rating
   */
  analyzeSellerRisk(sellerAddress, sellerDisputes = []) {
    const totalDisputes = sellerDisputes.length;
    const lostDisputes = sellerDisputes.filter(d => d.outcome === 'BUYER_WINS').length;

    const riskScore = totalDisputes === 0 ? 0 : Math.min(1.0, (lostDisputes * 2 + (totalDisputes - lostDisputes)) / 10);

    return {
      sellerAddress,
      totalDisputes,
      lostDisputes,
      riskScore,
      reputationPenalty: lostDisputes * 5, // -5 reputation points per lost dispute
    };
  }
}

module.exports = { GriefingAnalyzer };
