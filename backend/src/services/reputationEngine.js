/**
 * Reputation engine — the off-chain mirror of the agent_registry contract's
 * time-decayed reputation.
 *
 * A page load must not cost a contract call per agent, so the indexer stores
 * the *base* score exactly as the chain holds it plus the timestamp it was
 * last settled at, and this module recomputes what that score is worth now.
 *
 * The decay is applied one whole period at a time, truncating on each step —
 * the identical loop the contract runs in `decay_score`. Both sides therefore
 * agree exactly rather than only to within a floating-point tolerance, which
 * is what `reputationEngine.test.js` pins.
 */

const agentRepository = require("../repositories/agentRepository");

const BPS_DENOM = 10_000;

/** Matches MAX_DECAY_PERIODS in contracts/agent_registry/src/lib.rs. */
const MAX_DECAY_PERIODS = 730;

/** Mirrors the contract's RepConfig defaults. */
const DEFAULT_CONFIG = Object.freeze({
  slashBps: 2_000,
  votingWindow: 259_200,
  quorumWeight: 1_000,
  decayBps: 9_900,
  decayPeriod: 86_400,
});

let activeConfig = { ...DEFAULT_CONFIG };

/** Read the parameters the engine currently mirrors. */
function getConfig() {
  return { ...activeConfig };
}

/**
 * Adopt on-chain parameters (e.g. after `configure` changes them). Unknown or
 * malformed fields fall back to the contract defaults.
 */
function setConfig(config = {}) {
  activeConfig = {
    slashBps: numberOr(config.slashBps, DEFAULT_CONFIG.slashBps),
    votingWindow: numberOr(config.votingWindow, DEFAULT_CONFIG.votingWindow),
    quorumWeight: numberOr(config.quorumWeight, DEFAULT_CONFIG.quorumWeight),
    decayBps: numberOr(config.decayBps, DEFAULT_CONFIG.decayBps),
    decayPeriod: numberOr(config.decayPeriod, DEFAULT_CONFIG.decayPeriod),
  };
  return getConfig();
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

/**
 * `base * (decayBps / 10000) ^ periods`, in integer arithmetic.
 *
 * @param {number} base - base score in basis points (0–10000)
 * @param {number} elapsedSeconds - seconds since the score was settled
 * @param {object} [config] - decay parameters (defaults to the active config)
 */
function decayScore(base, elapsedSeconds, config = activeConfig) {
  const score0 = Math.trunc(Number(base) || 0);
  const elapsed = Math.trunc(Number(elapsedSeconds) || 0);

  if (
    score0 <= 0 ||
    elapsed <= 0 ||
    config.decayPeriod <= 0 ||
    config.decayBps >= BPS_DENOM
  ) {
    return Math.max(score0, 0);
  }

  let periods = Math.floor(elapsed / config.decayPeriod);
  if (periods > MAX_DECAY_PERIODS) periods = MAX_DECAY_PERIODS;

  let score = score0;
  for (let applied = 0; applied < periods && score > 0; applied += 1) {
    score = Math.floor((score * config.decayBps) / BPS_DENOM);
  }
  return score;
}

/**
 * What an indexed agent's reputation is worth right now.
 *
 * @param {{reputation: number, reputationUpdatedAt: number}} agent
 * @param {number} [nowMs] - evaluation time (epoch ms), defaults to now
 */
function currentReputation(agent, nowMs = Date.now()) {
  if (!agent) return 0;
  const base = Math.trunc(Number(agent.reputation) || 0);
  const settledAt = Number(agent.reputationUpdatedAt);
  if (!Number.isFinite(settledAt) || settledAt <= 0) return base;

  return decayScore(base, Math.floor((nowMs - settledAt) / 1000));
}

/** Attach the decayed score to an agent record without mutating the input. */
function withCurrentReputation(agent, nowMs = Date.now()) {
  if (!agent) return agent;
  return {
    ...agent,
    reputation: currentReputation(agent, nowMs),
    baseReputation: agent.reputation,
    reputationUpdatedAt: agent.reputationUpdatedAt ?? null,
  };
}

function withCurrentReputations(agents = [], nowMs = Date.now()) {
  return agents.map((agent) => withCurrentReputation(agent, nowMs));
}

/**
 * The decay curve between the last settlement and `nowMs`, as chart points.
 * One point per decay period, capped at `points` samples.
 */
function decayCurve(agent, { nowMs = Date.now(), points = 30 } = {}) {
  if (!agent) return [];

  const base = Math.trunc(Number(agent.reputation) || 0);
  const settledAt = Number(agent.reputationUpdatedAt) || nowMs;
  const config = activeConfig;
  const periodMs = config.decayPeriod * 1000;

  const elapsedPeriods = Math.max(
    0,
    Math.min(Math.floor((nowMs - settledAt) / periodMs), MAX_DECAY_PERIODS)
  );

  const sampleCount = Math.max(2, Math.min(points, elapsedPeriods + 1));
  const step = elapsedPeriods === 0 ? 0 : elapsedPeriods / (sampleCount - 1);

  const series = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const period = Math.round(step * i);
    series.push({
      timestamp: settledAt + period * periodMs,
      score: decayScore(base, period * config.decayPeriod, config),
    });
  }
  return series;
}

/** The score left after a guilty verdict slashes `slashBps` of it. */
function applyPenalty(score, slashBps = activeConfig.slashBps) {
  const base = Math.trunc(Number(score) || 0);
  if (base <= 0) return 0;
  return Math.floor((base * (BPS_DENOM - slashBps)) / BPS_DENOM);
}

/**
 * Write an agent's decayed score back to the index and restart its clock —
 * the off-chain counterpart of the contract's `settle_reputation`.
 */
async function settleAgent(agentId, { nowMs = Date.now(), client } = {}) {
  const agent = await agentRepository.findById(agentId, client);
  if (!agent) return null;

  const settled = currentReputation(agent, nowMs);
  return agentRepository.updateReputation(agentId, settled, client, {
    reputationUpdatedAt: nowMs,
  });
}

/**
 * Apply a slashing penalty to every agent an address owns, on top of the decay
 * accrued so far. Returns the updated agents.
 */
async function penalizeOwner(
  ownerAddress,
  { slashBps = activeConfig.slashBps, nowMs = Date.now(), client } = {}
) {
  const agents = await agentRepository.findByOwner(ownerAddress, client);
  const updated = [];

  for (const agent of agents) {
    const settled = currentReputation(agent, nowMs);
    const penalized = applyPenalty(settled, slashBps);
    updated.push(
      await agentRepository.updateReputation(agent.id, penalized, client, {
        reputationUpdatedAt: nowMs,
      })
    );
  }

  return updated;
}

module.exports = {
  BPS_DENOM,
  MAX_DECAY_PERIODS,
  DEFAULT_CONFIG,
  getConfig,
  setConfig,
  decayScore,
  currentReputation,
  withCurrentReputation,
  withCurrentReputations,
  decayCurve,
  applyPenalty,
  settleAgent,
  penalizeOwner,
};
