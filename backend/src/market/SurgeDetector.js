/**
 * SurgeDetector.js
 * Distinguishes organic surge demand from a single agent attempting to
 * artificially manufacture congestion to price out competitors or grief the market.
 */

class SurgeDetector {
  constructor(options = {}) {
    this.agentConcentrationThreshold = options.agentConcentrationThreshold || 0.65; // >65% from 1 agent = artificial
    this.burstWindowCount = options.burstWindowCount || 3;
    this.agentCallHistory = new Map(); // agentId -> [ { timestamp, units } ]
  }

  recordCall(agentId, units = 1, timestamp = Date.now()) {
    if (!this.agentCallHistory.has(agentId)) {
      this.agentCallHistory.set(agentId, []);
    }
    const history = this.agentCallHistory.get(agentId);
    history.push({ timestamp, units });

    // Clean calls older than 5 minutes
    const cutoff = timestamp - 300000;
    while (history.length > 0 && history[0].timestamp < cutoff) {
      history.shift();
    }
  }

  /**
   * Evaluates if a demand surge is organic or manufactured by an abusive agent.
   * @param {number} totalWindowUnits 
   * @param {number} lookbackMs 
   * @returns {{ isManufactured: boolean, dominantAgent: string|null, concentrationRatio: number }}
   */
  detectManipulation(totalWindowUnits, lookbackMs = 60000) {
    if (totalWindowUnits <= 0) {
      return { isManufactured: false, dominantAgent: null, concentrationRatio: 0 };
    }

    const now = Date.now();
    const cutoff = now - lookbackMs;
    let maxAgentUnits = 0;
    let dominantAgent = null;

    for (const [agentId, calls] of this.agentCallHistory.entries()) {
      const recentUnits = calls
        .filter((c) => c.timestamp >= cutoff)
        .reduce((sum, c) => sum + c.units, 0);

      if (recentUnits > maxAgentUnits) {
        maxAgentUnits = recentUnits;
        dominantAgent = agentId;
      }
    }

    const concentrationRatio = maxAgentUnits / totalWindowUnits;
    const isManufactured = concentrationRatio >= this.agentConcentrationThreshold;

    return {
      isManufactured,
      dominantAgent: isManufactured ? dominantAgent : null,
      concentrationRatio: Number(concentrationRatio.toFixed(4)),
    };
  }

  reset() {
    this.agentCallHistory.clear();
  }
}

module.exports = { SurgeDetector };