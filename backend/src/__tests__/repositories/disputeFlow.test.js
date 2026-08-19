/**
 * End-to-end reputation flow against the real database: an agent stakes,
 * another agent disputes it, third parties vote, the verdict lands guilty, and
 * both the collateral and the reputation come down by the configured share.
 */

const agentRepository = require("../../repositories/agentRepository");
const agentStakeRepository = require("../../repositories/agentStakeRepository");
const disputeRepository = require("../../repositories/disputeRepository");
const disputeService = require("../../services/disputeService");
const reputationEngine = require("../../services/reputationEngine");
const { truncateAll, closePool, buildAgent, OWNER_A, OWNER_B } = require("../helpers/testDb");

beforeEach(async () => {
  await truncateAll();
  reputationEngine.setConfig(reputationEngine.DEFAULT_CONFIG);
});

afterAll(async () => {
  await closePool();
});

describe("stake mirroring", () => {
  it("records collateral and denormalizes it onto the owner's agents", async () => {
    const agent = await agentRepository.create(buildAgent({ owner: OWNER_A }));

    await disputeService.recordStake({
      agentAddress: OWNER_A,
      token: "CTOKEN",
      amount: 10_000,
    });

    const stake = await agentStakeRepository.findByAddress(OWNER_A);
    expect(stake.amount).toBe(10_000);
    expect(stake.slashed).toBe(0);

    const indexed = await agentRepository.findById(agent.id);
    expect(indexed.stakeAmount).toBe(10_000);
  });

  it("applies a slash to both the stake row and the agent columns", async () => {
    const agent = await agentRepository.create(buildAgent({ owner: OWNER_A }));
    await disputeService.recordStake({ agentAddress: OWNER_A, amount: 10_000 });

    await disputeService.recordSlash(OWNER_A, 2_500);

    const stake = await agentStakeRepository.findByAddress(OWNER_A);
    expect(stake.amount).toBe(7_500);
    expect(stake.slashed).toBe(2_500);

    const indexed = await agentRepository.findById(agent.id);
    expect(indexed.stakeAmount).toBe(7_500);
    expect(indexed.stakeSlashed).toBe(2_500);
  });
});

describe("dispute lifecycle", () => {
  it("files, votes, and resolves a dispute across contract, DB and read APIs", async () => {
    const agent = await agentRepository.create(buildAgent({ owner: OWNER_A }));
    await disputeService.recordStake({ agentAddress: OWNER_A, amount: 10_000 });

    // Agent B files, with the evidence bundle stored off-chain.
    const evidence = { claim: "did not deliver", txs: ["tx1"] };
    const dispute = await disputeService.fileDispute({
      id: 1,
      complainant: OWNER_B,
      respondent: OWNER_A,
      evidence,
      closesAt: Date.now() + 60_000,
    });

    expect(dispute.status).toBe("open");
    expect(disputeService.verifyEvidence(evidence, dispute.evidenceHash)).toBe(true);

    // Two third parties weigh in with different weights.
    await disputeRepository.recordVote({
      disputeId: 1,
      voter: OWNER_B,
      inFavor: true,
      weight: 4_000,
    });
    await disputeRepository.recordVote({
      disputeId: 1,
      voter: "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y",
      inFavor: false,
      weight: 1_000,
    });

    const tallied = await disputeRepository.findById(1);
    expect(tallied.weightFor).toBe(4_000);
    expect(tallied.weightAgainst).toBe(1_000);

    // A replayed vote event must not double-count.
    await disputeRepository.recordVote({
      disputeId: 1,
      voter: OWNER_B,
      inFavor: true,
      weight: 4_000,
    });
    expect((await disputeRepository.findById(1)).weightFor).toBe(4_000);

    // The verdict lands: 20% of the stake and of the reputation.
    const resolved = await disputeService.resolveDispute({
      id: 1,
      outcome: "Guilty",
      slashedAmount: 2_000,
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.outcome).toBe("guilty");

    const stake = await agentStakeRepository.findByAddress(OWNER_A);
    expect(stake.amount).toBe(8_000);
    expect(stake.slashed).toBe(2_000);

    const slashedAgent = await agentRepository.findById(agent.id);
    expect(slashedAgent.reputation).toBe(4_000);
    expect(slashedAgent.stakeAmount).toBe(8_000);

    // Resolved disputes drop out of the active list.
    const active = await disputeRepository.findActive();
    expect(active.meta.total).toBe(0);
  });

  it("keeps evidence retrievable and hashes it on submission", async () => {
    await agentRepository.create(buildAgent({ owner: OWNER_A }));
    await disputeService.recordStake({ agentAddress: OWNER_A, amount: 5_000 });
    await disputeService.fileDispute({
      id: 2,
      complainant: OWNER_B,
      respondent: OWNER_A,
    });

    const evidence = { claim: "overcharged", amount: 42 };
    const { evidenceHash } = await disputeService.submitEvidence(2, evidence);

    const stored = await disputeService.getDispute(2);
    expect(stored.evidence).toEqual(evidence);
    expect(stored.evidenceHash).toBe(evidenceHash);
    expect(disputeService.verifyEvidence(stored.evidence, stored.evidenceHash)).toBe(true);
  });

  it("lists the disputes an address is involved in, both roles", async () => {
    await agentRepository.create(buildAgent({ owner: OWNER_A }));
    await disputeService.recordStake({ agentAddress: OWNER_A, amount: 5_000 });
    await disputeService.recordStake({ agentAddress: OWNER_B, amount: 5_000 });

    await disputeService.fileDispute({ id: 3, complainant: OWNER_B, respondent: OWNER_A });
    await disputeService.fileDispute({ id: 4, complainant: OWNER_A, respondent: OWNER_B });

    const involved = await disputeService.getDisputesForAgent(OWNER_A);
    expect(involved.meta.total).toBe(2);
    expect(involved.data.map((d) => d.id).sort()).toEqual([3, 4]);
  });
});

describe("decayed reads", () => {
  it("serves an agent's reputation decayed from its settlement clock", async () => {
    const agent = await agentRepository.create(buildAgent({ owner: OWNER_A }));

    // Backdate the decay clock by ten days.
    const tenDaysAgo = Date.now() - 10 * 86_400_000;
    await agentRepository.updateReputation(agent.id, 5_000, undefined, {
      reputationUpdatedAt: tenDaysAgo,
    });

    const stored = await agentRepository.findById(agent.id);
    expect(stored.reputation).toBe(5_000); // base score is untouched
    expect(reputationEngine.currentReputation(stored)).toBe(4_517);

    const { getAgent, getReputationTimeline } = require("../../services/agentService");
    expect((await getAgent(agent.id)).reputation).toBe(4_517);

    const timeline = await getReputationTimeline(agent.id);
    expect(timeline.baseReputation).toBe(5_000);
    expect(timeline.currentReputation).toBe(4_517);
    expect(timeline.curve[0].score).toBe(5_000);
    expect(timeline.curve[timeline.curve.length - 1].score).toBe(4_517);
  });
});
