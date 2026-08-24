const { DisputeGame, DisputeOutcome } = require('../../arbitration/DisputeGame');

describe('Dispute Game Economic Invariants & Property Tests', () => {
  const buyer = 'GBUYER';
  const seller = 'GSELLER';

  test('Economic Invariant: Zero Value Creation or Destruction across any payout outcome', () => {
    const testCases = [
      { buyerBond: 1000n, sellerBond: 1000n, outcome: DisputeOutcome.BUYER_WINS, treasuryBps: 1000 },
      { buyerBond: 5000n, sellerBond: 5000n, outcome: DisputeOutcome.SELLER_WINS, treasuryBps: 1500 },
      { buyerBond: 10000n, sellerBond: 10000n, outcome: DisputeOutcome.SPLIT, treasuryBps: 1000 },
    ];

    for (const tc of testCases) {
      const game = new DisputeGame({
        id: 99,
        buyer,
        seller,
        buyerBond: tc.buyerBond.toString(),
        sellerBond: tc.sellerBond.toString(),
        outcome: tc.outcome,
        phase: 'RESOLVED',
      });

      const totalBondIn = tc.buyerBond + tc.sellerBond;
      const payout = game.getPayoutDistribution(tc.treasuryBps);

      let totalOut = 0n;
      if (tc.outcome === DisputeOutcome.BUYER_WINS || tc.outcome === DisputeOutcome.SELLER_WINS) {
        totalOut = BigInt(payout.winnerPayout) + BigInt(payout.treasuryShare);
      } else {
        totalOut = BigInt(payout.buyerRefund) + BigInt(payout.sellerRefund) + BigInt(payout.treasuryShare);
      }

      // Total Value In MUST EXACTLY EQUAL Total Value Out
      expect(totalOut).toBe(totalBondIn);
    }
  });

  test('Silence Forfeit Equality: Unresponsive seller forfeit yields identical outcome to losing arbitration', () => {
    const buyerBond = 500n;
    const sellerBond = 500n;

    // 1. Silent seller forfeit
    const silentGame = new DisputeGame({
      id: 1,
      buyer,
      seller,
      buyerBond: buyerBond.toString(),
      sellerBond: sellerBond.toString(),
      buyerClaimHash: '1'.repeat(64),
      phaseDeadline: 100,
    });
    silentGame.checkForfeit(200); // Trigger forfeit

    // 2. Arbitrated buyer win
    const arbitratedGame = new DisputeGame({
      id: 2,
      buyer,
      seller,
      buyerBond: buyerBond.toString(),
      sellerBond: sellerBond.toString(),
      outcome: DisputeOutcome.BUYER_WINS,
      phase: 'RESOLVED',
    });

    const silentPayout = silentGame.getPayoutDistribution(1000);
    const arbitratedPayout = arbitratedGame.getPayoutDistribution(1000);

    expect(silentPayout.winnerPayout).toBe(arbitratedPayout.winnerPayout);
    expect(silentPayout.treasuryShare).toBe(arbitratedPayout.treasuryShare);
  });
});
