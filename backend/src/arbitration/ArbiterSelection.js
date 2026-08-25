const crypto = require('crypto');

/**
 * ArbiterSelection implements VRF-style deterministic pseudorandom selection
 * of human arbiters for round 4 arbitration using disputeId + ledger hash seed.
 */

class ArbiterSelection {
  /**
   * Deterministically computes pseudorandom seed from dispute ID and block hash.
   * @param {number|string} disputeId
   * @param {string} blockHash
   * @returns {Buffer} 32-byte seed buffer
   */
  static computeSeed(disputeId, blockHash) {
    const hasher = crypto.createHash('sha256');
    hasher.update(Buffer.from(String(disputeId)));
    hasher.update(Buffer.from(blockHash || '0000000000000000000000000000000000000000000000000000000000000000'));
    return hasher.digest();
  }

  /**
   * Selects a single arbiter deterministically based on stake-weighted VRF hash.
   * @param {number|string} disputeId - Dispute identifier
   * @param {string} blockHash - Ledger / block hash seed
   * @param {Array<Object>} arbitersPool - List of staked active arbiters [{ address, stake }]
   * @returns {Object} Selected arbiter
   */
  static selectArbiter(disputeId, blockHash, arbitersPool = []) {
    if (!arbitersPool || arbitersPool.length === 0) {
      throw new Error('Arbiters pool is empty');
    }

    // Filter active arbiters with positive stake
    const validArbiters = arbitersPool.filter(a => a.stake && BigInt(a.stake) > 0n);
    if (validArbiters.length === 0) {
      throw new Error('No arbiters with active stake available');
    }

    const seed = ArbiterSelection.computeSeed(disputeId, blockHash);

    // Compute VRF ticket hash per arbiter = sha256(seed + arbiterAddress)
    const candidates = validArbiters.map(arb => {
      const hasher = crypto.createHash('sha256');
      hasher.update(seed);
      hasher.update(Buffer.from(arb.address));
      const ticketHash = hasher.digest();
      
      // Convert first 8 bytes of ticketHash to BigInt score
      const score = ticketHash.readBigUInt64BE(0);
      // Weight ticket by stake
      const weightedScore = score * BigInt(arb.stake);

      return {
        arbiter: arb,
        score: weightedScore,
      };
    });

    // Select candidate with highest weighted score
    candidates.sort((a, b) => (b.score > a.score ? 1 : b.score < a.score ? -1 : 0));
    return candidates[0].arbiter;
  }
}

module.exports = { ArbiterSelection };
