jest.mock("../../repositories/disputeRepository", () => ({
  upsert: jest.fn(),
  resolve: jest.fn(),
  attachEvidence: jest.fn(),
  findById: jest.fn(),
  findActive: jest.fn(),
  findByAddress: jest.fn(),
  recordVote: jest.fn(),
  findVotes: jest.fn(),
}));

jest.mock("../../repositories/agentStakeRepository", () => ({
  upsert: jest.fn(),
  applySlash: jest.fn(),
  findByAddress: jest.fn(),
}));

jest.mock("../../repositories/agentRepository", () => ({
  updateStakeForOwner: jest.fn(),
}));

jest.mock("../../services/reputationEngine", () => ({
  getConfig: jest.fn(() => ({ slashBps: 2_000 })),
  penalizeOwner: jest.fn(),
}));

jest.mock("../../protocol/StreamMonitor", () => ({ broadcast: jest.fn() }));

const disputeRepository = require("../../repositories/disputeRepository");
const agentStakeRepository = require("../../repositories/agentStakeRepository");
const agentRepository = require("../../repositories/agentRepository");
const reputationEngine = require("../../services/reputationEngine");
const StreamMonitor = require("../../protocol/StreamMonitor");
const disputeService = require("../../services/disputeService");

const COMPLAINANT = "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT";
const RESPONDENT = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";

beforeEach(() => {
  jest.clearAllMocks();
  agentStakeRepository.findByAddress.mockResolvedValue({
    agentAddress: RESPONDENT,
    amount: 8_000,
    slashed: 2_000,
  });
});

describe("disputeService.hashEvidence", () => {
  it("is stable across key ordering", () => {
    const a = disputeService.hashEvidence({ claim: "spam", ledger: 42 });
    const b = disputeService.hashEvidence({ ledger: 42, claim: "spam" });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any field changes", () => {
    const a = disputeService.hashEvidence({ claim: "spam" });
    const b = disputeService.hashEvidence({ claim: "spam!" });
    expect(a).not.toBe(b);
  });

  it("verifies a bundle against the digest committed on-chain", () => {
    const evidence = { claim: "did not deliver", txs: ["tx1", "tx2"] };
    const hash = disputeService.hashEvidence(evidence);

    expect(disputeService.verifyEvidence(evidence, hash)).toBe(true);
    expect(disputeService.verifyEvidence({ ...evidence, claim: "other" }, hash)).toBe(false);
  });
});

describe("disputeService.fileDispute", () => {
  it("indexes the dispute, hashes the evidence, and notifies subscribers", async () => {
    const evidence = { claim: "did not deliver" };
    disputeRepository.upsert.mockResolvedValue({
      id: 7,
      complainant: COMPLAINANT,
      respondent: RESPONDENT,
      closesAt: 1_700_000_000_000,
    });

    await disputeService.fileDispute({
      id: 7,
      complainant: COMPLAINANT,
      respondent: RESPONDENT,
      evidence,
    });

    expect(disputeRepository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        status: "open",
        evidenceHash: disputeService.hashEvidence(evidence),
      })
    );
    expect(StreamMonitor.broadcast).toHaveBeenCalledWith(
      "DISPUTE_OPENED",
      expect.objectContaining({ disputeId: 7, respondent: RESPONDENT })
    );
  });

  it("rejects a self-dispute", async () => {
    await expect(
      disputeService.fileDispute({ id: 1, complainant: COMPLAINANT, respondent: COMPLAINANT })
    ).rejects.toThrow(/cannot dispute itself/);
    expect(disputeRepository.upsert).not.toHaveBeenCalled();
  });

  it("rejects a filing without an on-chain dispute id", async () => {
    await expect(
      disputeService.fileDispute({ complainant: COMPLAINANT, respondent: RESPONDENT })
    ).rejects.toThrow(/dispute id/);
  });
});

describe("disputeService.submitEvidence", () => {
  it("attaches the bundle and returns the digest to commit on-chain", async () => {
    const evidence = { claim: "overcharged", amount: 42 };
    disputeRepository.findById.mockResolvedValue({ id: 7, status: "open" });
    disputeRepository.attachEvidence.mockResolvedValue({ id: 7, status: "open" });

    const result = await disputeService.submitEvidence(7, evidence);

    expect(result.evidenceHash).toBe(disputeService.hashEvidence(evidence));
    expect(disputeRepository.attachEvidence).toHaveBeenCalledWith(7, {
      evidence,
      evidenceHash: result.evidenceHash,
    });
  });

  it("returns null for an unknown dispute", async () => {
    disputeRepository.findById.mockResolvedValue(null);
    expect(await disputeService.submitEvidence(99, { a: 1 })).toBeNull();
  });

  it("refuses to alter evidence after a verdict", async () => {
    disputeRepository.findById.mockResolvedValue({ id: 7, status: "resolved" });

    await expect(disputeService.submitEvidence(7, { a: 1 })).rejects.toThrow(/resolved/);
    expect(disputeRepository.attachEvidence).not.toHaveBeenCalled();
  });
});

describe("disputeService.resolveDispute", () => {
  beforeEach(() => {
    disputeRepository.findById.mockResolvedValue({
      id: 7,
      respondent: RESPONDENT,
      status: "open",
    });
  });

  it("slashes the stake and the reputation on a guilty verdict", async () => {
    disputeRepository.resolve.mockResolvedValue({
      id: 7,
      respondent: RESPONDENT,
      outcome: "guilty",
      slashedAmount: 2_000,
    });

    await disputeService.resolveDispute({
      id: 7,
      outcome: "Guilty",
      slashedAmount: 2_000,
      resolvedAt: 1_700_000_000_000,
    });

    expect(disputeRepository.resolve).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ outcome: "guilty", slashedAmount: 2_000 })
    );
    expect(agentStakeRepository.applySlash).toHaveBeenCalledWith(RESPONDENT, 2_000);
    expect(reputationEngine.penalizeOwner).toHaveBeenCalledWith(
      RESPONDENT,
      expect.objectContaining({ slashBps: 2_000 })
    );
    expect(agentRepository.updateStakeForOwner).toHaveBeenCalledWith(RESPONDENT, {
      amount: 8_000,
      slashed: 2_000,
    });
    expect(StreamMonitor.broadcast).toHaveBeenCalledWith(
      "DISPUTE_RESOLVED",
      expect.objectContaining({ disputeId: 7, outcome: "guilty" })
    );
  });

  it("leaves stake and reputation alone when the respondent is cleared", async () => {
    disputeRepository.resolve.mockResolvedValue({
      id: 7,
      respondent: RESPONDENT,
      outcome: "not_guilty",
      slashedAmount: 0,
    });

    await disputeService.resolveDispute({ id: 7, outcome: "NotGuilty" });

    expect(agentStakeRepository.applySlash).not.toHaveBeenCalled();
    expect(reputationEngine.penalizeOwner).not.toHaveBeenCalled();
  });

  it("leaves the stake alone when the vote failed quorum", async () => {
    disputeRepository.resolve.mockResolvedValue({
      id: 7,
      respondent: RESPONDENT,
      outcome: "quorum_failed",
      slashedAmount: 0,
    });

    await disputeService.resolveDispute({ id: 7, outcome: "QuorumFailed" });

    expect(agentStakeRepository.applySlash).not.toHaveBeenCalled();
  });

  it("rejects an unknown verdict", async () => {
    await expect(
      disputeService.resolveDispute({ id: 7, outcome: "Maybe" })
    ).rejects.toThrow(/unknown dispute outcome/);
  });

  it("returns null for a dispute that was never indexed", async () => {
    disputeRepository.findById.mockResolvedValue(null);
    expect(await disputeService.resolveDispute({ id: 42, outcome: "Guilty" })).toBeNull();
  });
});

describe("disputeService stake mirroring", () => {
  it("records a stake and syncs the denormalized agent columns", async () => {
    agentStakeRepository.upsert.mockResolvedValue({
      agentAddress: RESPONDENT,
      amount: 10_000,
      slashed: 0,
    });

    await disputeService.recordStake({
      agentAddress: RESPONDENT,
      token: "CTOKEN",
      amount: 10_000,
    });

    expect(agentRepository.updateStakeForOwner).toHaveBeenCalledWith(RESPONDENT, {
      amount: 10_000,
      slashed: 0,
    });
  });

  it("applies a slash and notifies subscribers", async () => {
    agentStakeRepository.applySlash.mockResolvedValue({
      agentAddress: RESPONDENT,
      amount: 8_000,
      slashed: 2_000,
    });

    await disputeService.recordSlash(RESPONDENT, 2_000);

    expect(agentStakeRepository.applySlash).toHaveBeenCalledWith(RESPONDENT, 2_000);
    expect(StreamMonitor.broadcast).toHaveBeenCalledWith("STAKE_SLASHED", {
      agentAddress: RESPONDENT,
      amount: 2_000,
    });
  });

  it("survives a notification failure", async () => {
    StreamMonitor.broadcast.mockImplementation(() => {
      throw new Error("socket closed");
    });
    agentStakeRepository.applySlash.mockResolvedValue({
      agentAddress: RESPONDENT,
      amount: 0,
      slashed: 10_000,
    });

    await expect(disputeService.recordSlash(RESPONDENT, 10_000)).resolves.toBeDefined();
  });
});
