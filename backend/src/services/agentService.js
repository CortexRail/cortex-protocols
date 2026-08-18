/**
 * Agent service — same public interface as the old in-memory version,
 * now backed by PostgreSQL through agentRepository.
 */

const agentRepository = require("../repositories/agentRepository");
const agentBanRepository = require("../repositories/agentBanRepository");
const agentStakeRepository = require("../repositories/agentStakeRepository");
const disputeRepository = require("../repositories/disputeRepository");
const reputationEngine = require("./reputationEngine");

const CAPABILITIES = [
  "TextGeneration",
  "CodeGeneration",
  "Reasoning",
  "VisionUnderstanding",
  "AudioProcessing",
  "DataAnalysis",
  "WebResearch",
  "ActionExecution",
];

function bannedError(id) {
  const err = new Error(`agent ${id} is banned and cannot write`);
  err.status = 403;
  return err;
}

/**
 * Index an agent identity after on-chain registration (upsert by id).
 */
async function registerAgent(agentData) {
  if (await agentBanRepository.isBanned(agentData.id)) {
    throw bannedError(agentData.id);
  }
  return agentRepository.create(agentData);
}

/**
 * Discover active agents with optional filters and pagination.
 *
 * Scores are decayed on read, so a listing never shows a stale snapshot.
 */
async function listAgents({
  capability,
  minReputation,
  search,
  page = 1,
  limit = 20,
} = {}) {
  const result = await agentRepository.findAll(
    { capability, minReputation, search },
    { page, limit }
  );
  return { ...result, data: reputationEngine.withCurrentReputations(result.data) };
}

/**
 * Get a single agent by ID (active or not — callers inspect isActive).
 */
async function getAgent(id) {
  const agent = await agentRepository.findById(id);
  return agent ? reputationEngine.withCurrentReputation(agent) : agent;
}

/**
 * Reputation over time for an agent: the decay curve since its score was last
 * settled, the disputes its owner is involved in as markers, and the stake
 * backing it.
 */
async function getReputationTimeline(id, { points = 30, nowMs = Date.now() } = {}) {
  const agent = await agentRepository.findById(id);
  if (!agent) return null;

  const [disputes, stake] = await Promise.all([
    disputeRepository.findByAddress(agent.owner, { page: 1, limit: 100 }),
    agentStakeRepository.findByAddress(agent.owner),
  ]);

  return {
    agentId: agent.id,
    owner: agent.owner,
    baseReputation: agent.reputation,
    currentReputation: reputationEngine.currentReputation(agent, nowMs),
    reputationUpdatedAt: agent.reputationUpdatedAt,
    config: reputationEngine.getConfig(),
    curve: reputationEngine.decayCurve(agent, { points, nowMs }),
    disputes: disputes.data.map((dispute) => ({
      id: dispute.id,
      status: dispute.status,
      outcome: dispute.outcome,
      openedAt: dispute.openedAt,
      resolvedAt: dispute.resolvedAt,
      slashedAmount: dispute.slashedAmount,
      role: dispute.respondent === agent.owner ? "respondent" : "complainant",
    })),
    stake: stake ?? { agentAddress: agent.owner, amount: 0, slashed: 0 },
  };
}

/**
 * Update an agent's reputation score (basis points, 0–10000).
 */
async function updateAgentReputation(id, reputation) {
  if (await agentBanRepository.isBanned(id)) {
    throw bannedError(id);
  }
  return agentRepository.updateReputation(id, reputation);
}

/**
 * Hide an agent from discovery without losing its history.
 */
async function deactivateAgent(id) {
  return agentRepository.deactivate(id);
}

module.exports = {
  registerAgent,
  listAgents,
  getAgent,
  getReputationTimeline,
  updateAgentReputation,
  deactivateAgent,
  CAPABILITIES,
};

// Note: reputation is stored in basis points (0-10000); divide by 100 for percentage display
