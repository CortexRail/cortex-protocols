/**
 * BaseFeeController.js
 * Implements EIP-1559-style algorithmic base fee adjustment per capacity window.
 * Ensures the base fee is bounded (max +/- 12.5% step change) and converges under bursty load.
 */

const DEFAULT_CONFIG = {
  targetUtilisationBps: 5000, // 50.00% target utilisation
  maxChangeBps: 1250,         // Max 12.50% change per window
  minBaseFee: 100n,           // Minimum floor fee
  maxBaseFee: 1000000000n,    // Upper circuit breaker
  smoothingFactor: 8,         // Dampening factor (d = 8 => 1/8 = 12.5% max delta)
};

class BaseFeeController {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Calculates the next window base fee based on current utilisation against target.
   * @param {bigint|number|string} currentBaseFee 
   * @param {number} utilisationBps - Basis points [0 - 10000] (e.g. 5000 = 50%)
   * @returns {bigint} nextBaseFee
   */
  calculateNextBaseFee(currentBaseFee, utilisationBps) {
    const fee = BigInt(currentBaseFee);
    const target = BigInt(this.config.targetUtilisationBps);
    const util = BigInt(Math.max(0, Math.min(10000, utilisationBps)));
    const smoothing = BigInt(this.config.smoothingFactor);

    if (util === target) {
      return this._clamp(fee);
    }

    if (util > target) {
      const deltaUtil = util - target;
      // feeDelta = currentBaseFee * (deltaUtil / target) / smoothingFactor
      let feeDelta = (fee * deltaUtil) / (target * smoothing);
      
      // Ensure strictly positive movement if delta exists
      if (feeDelta === 0n) {
        feeDelta = 1n;
      }

      // Hard clamp: maximum +12.5%
      const maxIncrease = (fee * BigInt(this.config.maxChangeBps)) / 10000n;
      if (feeDelta > maxIncrease && maxIncrease > 0n) {
        feeDelta = maxIncrease;
      }

      return this._clamp(fee + feeDelta);
    } else {
      const deltaUtil = target - util;
      // feeDelta = currentBaseFee * (deltaUtil / target) / smoothingFactor
      let feeDelta = (fee * deltaUtil) / (target * smoothing);

      // Hard clamp: maximum -12.5%
      const maxDecrease = (fee * BigInt(this.config.maxChangeBps)) / 10000n;
      if (feeDelta > maxDecrease && maxDecrease > 0n) {
        feeDelta = maxDecrease;
      }

      const nextFee = fee > feeDelta ? fee - feeDelta : this.config.minBaseFee;
      return this._clamp(nextFee);
    }
  }

  _clamp(fee) {
    if (fee < this.config.minBaseFee) return this.config.minBaseFee;
    if (fee > this.config.maxBaseFee) return this.config.maxBaseFee;
    return fee;
  }
}

module.exports = { BaseFeeController, DEFAULT_CONFIG };