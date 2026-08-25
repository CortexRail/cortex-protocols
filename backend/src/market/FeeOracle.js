/**
 * FeeOracle.js
 * Computes and publishes current base fee, next window estimate,
 * recommended tip, and admission probability forecasts.
 */

class FeeOracle {
  constructor(baseFeeController, capacityWindow) {
    this.controller = baseFeeController;
    this.window = capacityWindow;
    this.history = []; // [{ windowId, baseFee, utilisationBps, timestamp }]
    this.maxHistory = 100;
  }

  recordWindow(windowId, baseFee, utilisationBps, timestamp = Date.now()) {
    this.history.push({
      windowId,
      baseFee: BigInt(baseFee),
      utilisationBps,
      timestamp,
    });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  /**
   * Estimates fee metrics for an asset call.
   * @param {bigint|number|string} currentBaseFee 
   * @returns {{ baseFee: string, nextWindowBaseFee: string, suggestedTip: string, admissionProbability: number }}
   */
  estimate(currentBaseFee) {
    const fee = BigInt(currentBaseFee);
    const utilBps = this.window.getUtilisationBps();
    const nextBaseFee = this.controller.calculateNextBaseFee(fee, utilBps);

    // Suggested tip calculation based on congestion tier
    let suggestedTip = 0n;
    let admissionProb = 0.99;

    if (utilBps > 8000) {
      suggestedTip = (fee * 15n) / 100n; // 15% tip in high congestion
      admissionProb = 0.65;
    } else if (utilBps > 5000) {
      suggestedTip = (fee * 5n) / 100n;  // 5% tip in moderate congestion
      admissionProb = 0.88;
    }

    return {
      baseFee: fee.toString(),
      nextWindowBaseFee: nextBaseFee.toString(),
      suggestedTip: suggestedTip.toString(),
      admissionProbability: admissionProb,
    };
  }

  getRecentHistory() {
    return this.history.slice(-20);
  }
}

module.exports = { FeeOracle };