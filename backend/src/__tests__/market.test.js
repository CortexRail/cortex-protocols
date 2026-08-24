const { BaseFeeController } = require('../market/BaseFeeController');
const { CapacityWindow } = require('../market/CapacityWindow');
const { PriorityQueue } = require('../market/PriorityQueue');
const { SurgeDetector } = require('../market/SurgeDetector');
const { FeeOracle } = require('../market/FeeOracle');

describe('Congestion-Priced Capacity Market & Auction', () => {
  test('BaseFeeController: bounded step and stability over 500 burst windows', () => {
    const controller = new BaseFeeController();
    let currentFee = 1000n;

    for (let i = 0; i < 500; i++) {
      const utilBps = i % 2 === 0 ? 10000 : 0; // Square wave burst load
      const nextFee = controller.calculateNextBaseFee(currentFee, utilBps);
      const diff = nextFee > currentFee ? nextFee - currentFee : currentFee - nextFee;
      const maxAllowedChange = (currentFee * 1250n) / 10000n;

      // Assert clamped within 12.5%
      expect(diff <= maxAllowedChange || diff === 1n).toBe(true);
      currentFee = nextFee;
    }
  });

  test('CapacityWindow: handles carry-over and enforces capacity ceiling', () => {
    const window = new CapacityWindow(60000, 100, 0.5);
    const now = 1700000000000;

    // Consume 80 units in window 0 (over target of 50)
    const firstBatch = window.consume(80, now);
    expect(firstBatch.admitted).toBe(true);
    expect(window.getUtilisationBps()).toBe(8000);

    // Over-consuming beyond max capacity is rejected
    const rejectedBatch = window.consume(30, now);
    expect(rejectedBatch.admitted).toBe(false);

    // Advance to next window: carry-over is applied (10% of overload = 3 units)
    window.advance(now + 60000);
    expect(window.carryOverUnits).toBe(3);
  });

  test('Anti-starvation: low-tip caller clears within bounded windows', () => {
    const pq = new PriorityQueue({ maxAgeWindows: 3, agingBonusPerWindow: 500 });
    pq.enqueue({ agentId: 'agent_low', tip: 10, enqueuedWindowId: 0 });

    pq.enqueue({ agentId: 'agent_high1', tip: 10000, enqueuedWindowId: 3 });
    pq.enqueue({ agentId: 'agent_high2', tip: 10000, enqueuedWindowId: 3 });

    // Window 4 (age 4 >= maxAgeWindows 3): low tip caller is boosted
    const drained = pq.drain(1, 4);
    expect(drained[0].agentId).toBe('agent_low');
  });

  test('SurgeDetector: flags single agent artificial congestion', () => {
    const detector = new SurgeDetector({ agentConcentrationThreshold: 0.65 });
    const now = Date.now();

    for (let i = 0; i < 80; i++) {
      detector.recordCall('attacker_agent', 1, now);
    }
    for (let i = 0; i < 20; i++) {
      detector.recordCall(`user_${i}`, 1, now);
    }

    const check = detector.detectManipulation(100, 60000);
    expect(check.isManufactured).toBe(true);
    expect(check.dominantAgent).toBe('attacker_agent');
  });

  test('FeeOracle: outputs estimates and suggested tip', () => {
    const controller = new BaseFeeController();
    const window = new CapacityWindow(60000, 100, 0.5);
    const oracle = new FeeOracle(controller, window);

    window.consume(90); // 90% congestion
    const estimate = oracle.estimate(1000n);

    expect(BigInt(estimate.suggestedTip)).toBeGreaterThan(0n);
    expect(estimate.admissionProbability).toBeLessThan(0.8);
  });
});