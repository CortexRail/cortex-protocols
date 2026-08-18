jest.mock("../../repositories/agentRepository", () => ({
  findById: jest.fn(),
  findByOwner: jest.fn(),
  updateReputation: jest.fn(),
}));

const agentRepository = require("../../repositories/agentRepository");
const reputationEngine = require("../../services/reputationEngine");

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

// Several tests reconfigure the engine; every test starts from the defaults
// the contract ships with.
beforeEach(() => {
  reputationEngine.setConfig(reputationEngine.DEFAULT_CONFIG);
});

describe("reputationEngine.decayScore", () => {
  it("leaves a score untouched inside one decay period", () => {
    expect(reputationEngine.decayScore(5_000, 86_399)).toBe(5_000);
  });

  // These are the exact values asserted by the contract's own tests in
  // contracts/agent_registry/src/test.rs — the two implementations must agree
  // digit for digit, not just approximately.
  it("matches the contract's integer decay after one period", () => {
    expect(reputationEngine.decayScore(5_000, 86_400)).toBe(4_950);
  });

  it("matches the contract's integer decay after ten periods", () => {
    expect(reputationEngine.decayScore(5_000, 86_400 * 10)).toBe(4_517);
  });

  it("truncates on every period rather than at the end", () => {
    // Closed-form 5000 × 0.99^10 is 4521.4; applying the truncation each
    // period, as the contract does, lands 4 basis points lower.
    const closedForm = Math.floor(5_000 * 0.99 ** 10);
    expect(reputationEngine.decayScore(5_000, 86_400 * 10)).toBeLessThan(closedForm);
  });

  it("saturates at the contract's iteration bound", () => {
    const bounded = reputationEngine.decayScore(5_000, 86_400 * reputationEngine.MAX_DECAY_PERIODS);
    expect(reputationEngine.decayScore(5_000, 86_400 * 5_000)).toBe(bounded);
  });

  it("never returns a negative score", () => {
    expect(reputationEngine.decayScore(0, 86_400 * 100)).toBe(0);
    expect(reputationEngine.decayScore(-5, 86_400)).toBe(0);
  });

  it("honours a reconfigured decay rate", () => {
    reputationEngine.setConfig({ ...reputationEngine.DEFAULT_CONFIG, decayBps: 5_000 });
    expect(reputationEngine.decayScore(8_000, 86_400 * 2)).toBe(2_000);
  });

  it("disables decay when the rate is 100%", () => {
    reputationEngine.setConfig({ ...reputationEngine.DEFAULT_CONFIG, decayBps: 10_000 });
    expect(reputationEngine.decayScore(8_000, 86_400 * 50)).toBe(8_000);
  });
});

describe("reputationEngine.currentReputation", () => {
  it("decays from the timestamp the score was settled at", () => {
    const agent = { reputation: 5_000, reputationUpdatedAt: NOW - DAY_MS * 10 };
    expect(reputationEngine.currentReputation(agent, NOW)).toBe(4_517);
  });

  it("returns the base score when the clock has never been set", () => {
    expect(
      reputationEngine.currentReputation({ reputation: 7_000, reputationUpdatedAt: null }, NOW)
    ).toBe(7_000);
  });

  it("exposes the base score alongside the decayed one", () => {
    const agent = { id: 1, reputation: 5_000, reputationUpdatedAt: NOW - DAY_MS };
    const decorated = reputationEngine.withCurrentReputation(agent, NOW);

    expect(decorated.reputation).toBe(4_950);
    expect(decorated.baseReputation).toBe(5_000);
    expect(agent.reputation).toBe(5_000); // input is not mutated
  });
});

describe("reputationEngine.decayCurve", () => {
  it("samples the curve from the settlement point to now", () => {
    const agent = { reputation: 5_000, reputationUpdatedAt: NOW - DAY_MS * 4 };
    const curve = reputationEngine.decayCurve(agent, { nowMs: NOW, points: 5 });

    expect(curve).toHaveLength(5);
    expect(curve[0]).toEqual({ timestamp: NOW - DAY_MS * 4, score: 5_000 });
    expect(curve[curve.length - 1].score).toBe(
      reputationEngine.currentReputation(agent, NOW)
    );
    expect(curve.every((point, i) => i === 0 || point.score <= curve[i - 1].score)).toBe(true);
  });

  it("still returns a flat two-point series for a freshly settled agent", () => {
    const curve = reputationEngine.decayCurve(
      { reputation: 6_000, reputationUpdatedAt: NOW },
      { nowMs: NOW }
    );
    expect(curve).toHaveLength(2);
    expect(curve[0].score).toBe(6_000);
    expect(curve[1].score).toBe(6_000);
  });
});

describe("reputationEngine.applyPenalty", () => {
  it("removes the configured slash percentage", () => {
    expect(reputationEngine.applyPenalty(5_000, 2_000)).toBe(4_000);
    expect(reputationEngine.applyPenalty(7_047, 2_000)).toBe(5_637);
  });

  it("floors at zero for a full slash", () => {
    expect(reputationEngine.applyPenalty(5_000, 10_000)).toBe(0);
  });
});

describe("reputationEngine persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("settleAgent writes the decayed score and restarts the clock", async () => {
    agentRepository.findById.mockResolvedValue({
      id: 3,
      reputation: 5_000,
      reputationUpdatedAt: NOW - DAY_MS * 10,
    });
    agentRepository.updateReputation.mockResolvedValue({ id: 3, reputation: 4_517 });

    await reputationEngine.settleAgent(3, { nowMs: NOW });

    expect(agentRepository.updateReputation).toHaveBeenCalledWith(3, 4_517, undefined, {
      reputationUpdatedAt: NOW,
    });
  });

  it("settleAgent is a no-op for an unknown agent", async () => {
    agentRepository.findById.mockResolvedValue(null);

    expect(await reputationEngine.settleAgent(99)).toBeNull();
    expect(agentRepository.updateReputation).not.toHaveBeenCalled();
  });

  it("penalizeOwner decays first, then applies the slash, to every agent owned", async () => {
    agentRepository.findByOwner.mockResolvedValue([
      { id: 1, reputation: 5_000, reputationUpdatedAt: NOW - DAY_MS },
      { id: 2, reputation: 8_000, reputationUpdatedAt: NOW },
    ]);
    agentRepository.updateReputation.mockImplementation(async (id, reputation) => ({
      id,
      reputation,
    }));

    await reputationEngine.penalizeOwner("GOWNER", { slashBps: 2_000, nowMs: NOW });

    // agent 1: 5000 → 4950 (one period of decay) → 3960 (20% slash)
    expect(agentRepository.updateReputation).toHaveBeenNthCalledWith(1, 1, 3_960, undefined, {
      reputationUpdatedAt: NOW,
    });
    // agent 2: no decay accrued → 6400
    expect(agentRepository.updateReputation).toHaveBeenNthCalledWith(2, 2, 6_400, undefined, {
      reputationUpdatedAt: NOW,
    });
  });
});
