const { DisputeGame, DisputePhase, DisputeOutcome } = require('../../arbitration/DisputeGame');
const { BondCalculator } = require('../../arbitration/BondCalculator');
const { GriefingAnalyzer } = require('../../arbitration/GriefingAnalyzer');
const { ArbiterSelection } = require('../../arbitration/ArbiterSelection');
const crypto = require('crypto');

describe('Bonded Collateral and Multi-Round Commit-Reveal Dispute System', () => {
  const buyer = 'GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const seller = 'GSELLERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const arbiter = 'GARBITERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

  test('1. BondCalculator computes collateral dynamic ratios and active dispute multiplier', () => {
    const calc = new BondCalculator();
    const assetPrice = '1000000000'; // 100 XLM

    // Clean seller (0 lost disputes, 0 active disputes) -> 10% = 10 XLM
    const cleanBond = calc.calculateBond(assetPrice, { disputesLost: 0 }, 0);
    expect(cleanBond).toBe('100000000');

    // High risk seller (2 lost disputes) -> 10% + 2*5% = 20% = 20 XLM
    const riskyBond = calc.calculateBond(assetPrice, { disputesLost: 2 }, 0);
    expect(riskyBond).toBe('200000000');

    // Active dispute multiplier -> 20 XLM * (1 * 2) = 40 XLM
    const activeDisputeBond = calc.calculateBond(assetPrice, { disputesLost: 2 }, 1);
    expect(activeDisputeBond).toBe('400000000');
  });

  test('2. DisputeGame 4-Round Escalation, Commit-Reveal, & Arbitration Flow', () => {
    const saltBuyer = '1111111111111111111111111111111111111111111111111111111111111111';
    const saltSeller = '2222222222222222222222222222222222222222222222222222222222222222';
    const evidenceBuyerBuf = Buffer.from('Defective prompt output delivered');
    const evidenceSellerBuf = Buffer.from('Valid response logged by server');

    const buyerClaimHash = DisputeGame.computeCommitHash(evidenceBuyerBuf, saltBuyer);
    const sellerResponseHash = DisputeGame.computeCommitHash(evidenceSellerBuf, saltSeller);

    const game = new DisputeGame({
      id: 1,
      assetId: 101,
      buyer,
      seller,
      buyerBond: '100000000',
      sellerBond: '100000000',
      buyerClaimHash,
    });

    expect(game.phase).toBe(DisputePhase.COMMIT);

    // Seller responds in time
    game.respond(seller, sellerResponseHash);
    expect(game.phase).toBe(DisputePhase.REVEAL);

    // Both parties reveal valid evidence matching their committed SHA-256 hashes
    game.reveal(buyer, evidenceBuyerBuf, saltBuyer);
    expect(game.buyerRevealed).toBe(true);

    game.reveal(seller, evidenceSellerBuf, saltSeller);
    expect(game.sellerRevealed).toBe(true);

    // After reveal window expiry, both revealed -> escalation
    const futureTime = game.phaseDeadline + 1;
    game.checkForfeit(futureTime);
    expect(game.phase).toBe(DisputePhase.ESCALATION);

    // Round 1 -> Round 2 Escalation (doubling bonds)
    game.escalate(buyer);
    expect(game.buyerBond).toBe(200000000n);
    game.escalate(seller);
    expect(game.sellerBond).toBe(200000000n);
    expect(game.round).toBe(2);

    // Fast-forward to Round 4 Final Arbitration
    game.round = 4;
    game.phase = DisputePhase.ARBITRATION;
    game.arbiter = arbiter;

    // Human Arbiter rules in favor of Buyer
    game.arbitrate(arbiter, DisputeOutcome.BUYER_WINS);
    expect(game.phase).toBe(DisputePhase.RESOLVED);
    expect(game.outcome).toBe(DisputeOutcome.BUYER_WINS);

    // Verify Slashing Accounting: Winner Payout + Treasury Share = Total Loser Bond + Winner Bond
    const payout = game.getPayoutDistribution(1000); // 10% treasury share
    expect(payout.winner).toBe(buyer);
    expect(payout.slashedBond).toBe('200000000');
    expect(payout.treasuryShare).toBe('20000000'); // 10% of 200M = 20M
    expect(payout.winnerPayout).toBe('380000000'); // 200M initial + 180M slashed reward
  });

  test('3. Silence Forfeit Detection (Seller fails to respond in COMMIT phase)', () => {
    const game = new DisputeGame({
      id: 2,
      assetId: 102,
      buyer,
      seller,
      buyerBond: '100000000',
      sellerBond: '100000000',
      buyerClaimHash: 'f'.repeat(64),
    });

    const pastDeadline = game.phaseDeadline + 10;
    const outcome = game.checkForfeit(pastDeadline);
    expect(outcome).toBe(DisputeOutcome.BUYER_WINS);
    expect(game.phase).toBe(DisputePhase.RESOLVED);
  });

  test('4. GriefingAnalyzer flags extortion buyer', () => {
    const analyzer = new GriefingAnalyzer();
    const disputes = [
      { outcome: 'SELLER_WINS', buyerClaimHash: 'hash1' },
      { outcome: 'SELLER_WINS', buyerClaimHash: 'hash1' },
      { outcome: 'SELLER_WINS', buyerClaimHash: 'hash2' },
    ];
    const purchases = [{}, {}, {}, {}, {}];

    const result = analyzer.analyzeBuyerBehavior(buyer, disputes, purchases);
    expect(result.isHighRiskGriefer).toBe(true);
    expect(result.recommendation).toBe('REQUIRE_EXTRA_BUYER_BOND');
  });

  test('5. ArbiterSelection VRF-style selection is strictly deterministic', () => {
    const arbitersPool = [
      { address: 'GARBITER1', stake: '500000000' },
      { address: 'GARBITER2', stake: '1000000000' },
      { address: 'GARBITER3', stake: '300000000' },
    ];

    const disputeId = 42;
    const blockHash = 'a'.repeat(64);

    const selection1 = ArbiterSelection.selectArbiter(disputeId, blockHash, arbitersPool);
    const selection2 = ArbiterSelection.selectArbiter(disputeId, blockHash, arbitersPool);

    expect(selection1.address).toBe(selection2.address);
  });
});
