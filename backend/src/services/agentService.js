/**
 * Agent service — same public interface as the old in-memory version,
 * now backed by PostgreSQL through agentRepository.
 */

const agentRepository = require("../repositories/agentRepository");

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

/**
 * Index an agent identity after on-chain registration (upsert by id).
 */
async function registerAgent(agentData) {
  return agentRepository.create(agentData);
}

/**
 * Discover active agents with optional filters and pagination.
 */
async function listAgents({
  capability,
  minReputation,
  search,
  page = 1,
  limit = 20,
} = {}) {
  return agentRepository.findAll(
    { capability, minReputation, search },
    { page, limit }
  );
}

/**
 * Get a single agent by ID (active or not — callers inspect isActive).
 */
async function getAgent(id) {
  return agentRepository.findById(id);
}

/**
 * Update an agent's reputation score (basis points, 0–10000).
 */
async function updateAgentReputation(id, reputation) {
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
  updateAgentReputation,
  deactivateAgent,
  CAPABILITIES,
};

// Note: reputation is stored in basis points (0-10000); divide by 100 for percentage display
