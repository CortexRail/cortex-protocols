const crypto = require('crypto');

/**
 * Dispute Phases:
 * 1. COMMIT - Buyer opens dispute with claim_hash and bond; Seller responds with response_hash before RESPONSE_WINDOW.
 * 2. REVEAL - Both parties reveal evidence & salt matching their hashes before REVEAL_WINDOW.
 * 3. ESCALATION - Unresolved disputes can be escalated by doubling bonds up to MAX_DISPUTE_ROUNDS.
 * 4. ARBITRATION - Final round human arbitration by VRF-selected staked arbiters.
 * 5. RESOLVED - Winner awarded slashed bond + treasury fee deducted.
 */

const DisputePhase = {
  COMMIT: 'COMMIT',
  REVEAL: 'REVEAL',
  ESCALATION: 'ESCALATION',
  ARBITRATION: 'ARBITRATION',
  RESOLVED: 'RESOLVED',
};

const DisputeOutcome = {
  NONE: 'NONE',
  BUYER_WINS: 'BUYER_WINS',
  SELLER_WINS: 'SELLER_WINS',
  SPLIT: 'SPLIT',
};

const MAX_DISPUTE_ROUNDS = 4;
const RESPONSE_WINDOW_SECS = 86400; // 24 hours
const REVEAL_WINDOW_SECS = 86400;   // 24 hours

class DisputeGame {
  constructor(disputeData) {
    this.id = disputeData.id;
    this.assetId = disputeData.assetId;
    this.buyer = disputeData.buyer;
    this.seller = disputeData.seller;
    this.round = disputeData.round || 1;
    this.buyerBond = BigInt(disputeData.buyerBond || 0);
    this.sellerBond = BigInt(disputeData.sellerBond || 0);
    this.buyerClaimHash = disputeData.buyerClaimHash;
    this.sellerResponseHash = disputeData.sellerResponseHash || null;
    this.buyerEvidence = disputeData.buyerEvidence || null;
    this.sellerEvidence = disputeData.sellerEvidence || null;
    this.buyerRevealed = disputeData.buyerRevealed || false;
    this.sellerRevealed = disputeData.sellerRevealed || false;
    this.buyerEscalated = disputeData.buyerEscalated || false;
    this.sellerEscalated = disputeData.sellerEscalated || false;
    this.phase = disputeData.phase || DisputePhase.COMMIT;
    this.outcome = disputeData.outcome || DisputeOutcome.NONE;
    this.createdAt = disputeData.createdAt || Math.floor(Date.now() / 1000);
    this.phaseDeadline = disputeData.phaseDeadline || (this.createdAt + RESPONSE_WINDOW_SECS);
    this.arbiter = disputeData.arbiter || null;
  }

  /**
   * Validates if a seller response is valid.
   */
  validateSellerResponse(sellerAddress, responseHash, currentTime = Math.floor(Date.now() / 1000)) {
    if (this.phase !== DisputePhase.COMMIT) {
      throw new Error('Game is not in COMMIT phase');
    }
    if (sellerAddress !== this.seller) {
      throw new Error('Only registered seller can respond');
    }
    if (currentTime > this.phaseDeadline) {
      throw new Error('Response window expired');
    }
    if (this.sellerResponseHash) {
      throw new Error('Seller already submitted response hash');
    }
    if (!responseHash || responseHash.length !== 64) {
      throw new Error('Invalid SHA-256 response hash format');
    }
    return true;
  }

  /**
   * Applies seller response hash and transitions to REVEAL phase.
   */
  respond(sellerAddress, responseHash, currentTime = Math.floor(Date.now() / 1000)) {
    this.validateSellerResponse(sellerAddress, responseHash, currentTime);
    this.sellerResponseHash = responseHash;
    this.phase = DisputePhase.REVEAL;
    this.phaseDeadline = currentTime + REVEAL_WINDOW_SECS;
  }

  /**
   * Verifies SHA-256 commit-reveal hash match for evidence + salt.
   */
  static computeCommitHash(evidenceBuffer, saltHex) {
    const saltBuf = Buffer.from(saltHex, 'hex');
    const hasher = crypto.createHash('sha256');
    hasher.update(evidenceBuffer);
    hasher.update(saltBuf);
    return hasher.digest('hex');
  }

  /**
   * Reveals evidence for buyer or seller.
   */
  reveal(partyAddress, evidenceBuffer, saltHex, currentTime = Math.floor(Date.now() / 1000)) {
    if (this.phase !== DisputePhase.REVEAL) {
      throw new Error('Game is not in REVEAL phase');
    }
    if (currentTime > this.phaseDeadline) {
      throw new Error('Reveal window expired');
    }

    const computedHash = DisputeGame.computeCommitHash(evidenceBuffer, saltHex);

    if (partyAddress === this.buyer) {
      if (this.buyerRevealed) {
        throw new Error('Buyer already revealed evidence');
      }
      if (computedHash.toLowerCase() !== this.buyerClaimHash.toLowerCase()) {
        throw new Error('Buyer revealed evidence hash does not match committed claim hash');
      }
      this.buyerRevealed = true;
      this.buyerEvidence = evidenceBuffer.toString('utf8');
    } else if (partyAddress === this.seller) {
      if (this.sellerRevealed) {
        throw new Error('Seller already revealed evidence');
      }
      if (!this.sellerResponseHash) {
        throw new Error('Seller has no recorded response hash');
      }
      if (computedHash.toLowerCase() !== this.sellerResponseHash.toLowerCase()) {
        throw new Error('Seller revealed evidence hash does not match committed response hash');
      }
      this.sellerRevealed = true;
      this.sellerEvidence = evidenceBuffer.toString('utf8');
    } else {
      throw new Error('Unauthorized party');
    }
  }

  /**
   * Checks forfeit conditions due to missed windows or non-reveal.
   */
  checkForfeit(currentTime = Math.floor(Date.now() / 1000)) {
    if (this.phase === DisputePhase.RESOLVED) {
      return this.outcome;
    }

    // In COMMIT phase, if seller fails to respond in time, buyer wins by default forfeit
    if (this.phase === DisputePhase.COMMIT && currentTime > this.phaseDeadline && !this.sellerResponseHash) {
      this.outcome = DisputeOutcome.BUYER_WINS;
      this.phase = DisputePhase.RESOLVED;
      return this.outcome;
    }

    // In REVEAL phase after deadline
    if (this.phase === DisputePhase.REVEAL && currentTime > this.phaseDeadline) {
      if (this.buyerRevealed && !this.sellerRevealed) {
        this.outcome = DisputeOutcome.BUYER_WINS;
        this.phase = DisputePhase.RESOLVED;
      } else if (!this.buyerRevealed && this.sellerRevealed) {
        this.outcome = DisputeOutcome.SELLER_WINS;
        this.phase = DisputePhase.RESOLVED;
      } else if (!this.buyerRevealed && !this.sellerRevealed) {
        // Neither side revealed: split/return initial bonds
        this.outcome = DisputeOutcome.SPLIT;
        this.phase = DisputePhase.RESOLVED;
      } else {
        // Both revealed: ready for escalation or arbitration
        if (this.round >= MAX_DISPUTE_ROUNDS) {
          this.phase = DisputePhase.ARBITRATION;
        } else {
          this.phase = DisputePhase.ESCALATION;
        }
      }
    }

    return this.outcome;
  }

  /**
   * Escalates the dispute to the next round by doubling bonds.
   */
  escalate(partyAddress, currentTime = Math.floor(Date.now() / 1000)) {
    if (this.phase !== DisputePhase.ESCALATION) {
      throw new Error('Game is not in ESCALATION phase');
    }
    if (this.round >= MAX_DISPUTE_ROUNDS) {
      throw new Error('Maximum dispute rounds reached');
    }

    if (partyAddress === this.buyer) {
      if (this.buyerEscalated) {
        throw new Error('Buyer already escalated this round');
      }
      this.buyerEscalated = true;
      this.buyerBond = this.buyerBond * 2n;
    } else if (partyAddress === this.seller) {
      if (this.sellerEscalated) {
        throw new Error('Seller already escalated this round');
      }
      this.sellerEscalated = true;
      this.sellerBond = this.sellerBond * 2n;
    } else {
      throw new Error('Unauthorized party');
    }

    // When both escalate, move to next round
    if (this.buyerEscalated && this.sellerEscalated) {
      this.round += 1;
      this.buyerEscalated = false;
      this.sellerEscalated = false;
      this.buyerRevealed = false;
      this.sellerRevealed = false;
      this.buyerResponseHash = null;
      this.sellerResponseHash = null;

      if (this.round >= MAX_DISPUTE_ROUNDS) {
        this.phase = DisputePhase.ARBITRATION;
      } else {
        this.phase = DisputePhase.COMMIT;
        this.phaseDeadline = currentTime + RESPONSE_WINDOW_SECS;
      }
    }
  }

  /**
   * Resolves the dispute via human arbitration in final round.
   */
  arbitrate(arbiterAddress, ruling) {
    if (this.phase !== DisputePhase.ARBITRATION && this.round < MAX_DISPUTE_ROUNDS) {
      throw new Error('Dispute is not in ARBITRATION phase');
    }
    if (this.arbiter && arbiterAddress !== this.arbiter) {
      throw new Error('Unauthorized arbiter');
    }
    if (![DisputeOutcome.BUYER_WINS, DisputeOutcome.SELLER_WINS, DisputeOutcome.SPLIT].includes(ruling)) {
      throw new Error('Invalid arbitration ruling');
    }

    this.outcome = ruling;
    this.phase = DisputePhase.RESOLVED;
    return this.outcome;
  }

  /**
   * Calculates slashing payout accounting.
   * Total Pool = buyerBond + sellerBond.
   * Winner gets winnerBond + (90% of loserBond).
   * Treasury gets 10% of loserBond.
   * Zero value destruction or creation.
   */
  getPayoutDistribution(treasuryBps = 1000) {
    if (this.phase !== DisputePhase.RESOLVED) {
      throw new Error('Cannot calculate payout for unresolved dispute');
    }

    const treasuryFactor = BigInt(treasuryBps); // e.g. 1000 bps = 10%
    const bpsBase = 10000n;

    if (this.outcome === DisputeOutcome.BUYER_WINS) {
      const loserBond = this.sellerBond;
      const treasuryShare = (loserBond * treasuryFactor) / bpsBase;
      const winnerReward = loserBond - treasuryShare;
      const winnerPayout = this.buyerBond + winnerReward;
      return {
        winner: this.buyer,
        winnerPayout: winnerPayout.toString(),
        loser: this.seller,
        slashedBond: loserBond.toString(),
        treasuryShare: treasuryShare.toString(),
      };
    } else if (this.outcome === DisputeOutcome.SELLER_WINS) {
      const loserBond = this.buyerBond;
      const treasuryShare = (loserBond * treasuryFactor) / bpsBase;
      const winnerReward = loserBond - treasuryShare;
      const winnerPayout = this.sellerBond + winnerReward;
      return {
        winner: this.seller,
        winnerPayout: winnerPayout.toString(),
        loser: this.buyer,
        slashedBond: loserBond.toString(),
        treasuryShare: treasuryShare.toString(),
      };
    } else {
      // Split: refund both
      return {
        buyerRefund: this.buyerBond.toString(),
        sellerRefund: this.sellerBond.toString(),
        treasuryShare: '0',
      };
    }
  }
}

module.exports = {
  DisputeGame,
  DisputePhase,
  DisputeOutcome,
  MAX_DISPUTE_ROUNDS,
  RESPONSE_WINDOW_SECS,
  REVEAL_WINDOW_SECS,
};
