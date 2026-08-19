/**
 * Dispute service — orchestrates the dispute lifecycle across the index for both
 * agent registry reputation disputes and marketplace purchase disputes.
 */

const crypto = require("crypto");
const disputeRepository = require("../repositories/disputeRepository");
const escrowRepository = require("../repositories/escrowRepository");
const agentStakeRepository = require("../repositories/agentStakeRepository");
const agentRepository = require("../repositories/agentRepository");
const reputationEngine = require("./reputationEngine");
const StreamMonitor = require("../protocol/StreamMonitor");

/** Verdicts as stored off-chain, keyed by the contract's enum name. */
const OUTCOMES = Object.freeze({
  Guilty: "guilty",
  NotGuilty: "not_guilty",
  QuorumFailed: "quorum_failed",
});

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function badRequest(message) {
  return httpError(400, message);
}

// ── Agent Registry Reputation Disputes ───────────────────────────────────

/**
 * SHA-256 of the canonical JSON encoding of an evidence bundle (or string).
 * Object keys are sorted so the same bundle always hashes the same way.
 */
function hashEvidence(evidence) {
  if (typeof evidence === "string") {
    return crypto.createHash("sha256").update(evidence).digest("hex");
  }
  return crypto.createHash("sha256").update(canonicalize(evidence)).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

/** Does an evidence bundle match the digest recorded on-chain? */
function verifyEvidence(evidence, evidenceHash) {
  return hashEvidence(evidence) === String(evidenceHash || "").toLowerCase();
}

/**
 * Index a dispute (called from the API when a filing is submitted, and from
 * the pipeline when the DISPUTE_OPENED event lands).
 */
async function fileDispute(input) {
  const { id, complainant, respondent } = input;

  if (!Number.isInteger(Number(id)) || Number(id) < 1) {
    throw badRequest("a dispute id from the contract is required");
  }
  if (!complainant || !respondent) {
    throw badRequest("complainant and respondent are required");
  }
  if (complainant === respondent) {
    throw badRequest("an agent cannot dispute itself");
  }

  const evidence = input.evidence ?? null;
  const evidenceHash =
    input.evidenceHash || (evidence ? hashEvidence(evidence) : "");

  const dispute = await disputeRepository.upsert({
    id: Number(id),
    complainant,
    respondent,
    evidence,
    evidenceHash,
    status: "open",
    openedAt: input.openedAt,
    closesAt: input.closesAt,
  });

  notify("DISPUTE_OPENED", {
    disputeId: dispute.id,
    complainant: dispute.complainant,
    respondent: dispute.respondent,
    closesAt: dispute.closesAt,
  });

  return dispute;
}

/**
 * Attach an evidence bundle to an existing dispute and return its digest so
 * the caller can commit it on-chain.
 */
async function submitEvidence(disputeId, evidence) {
  if (evidence === undefined || evidence === null) {
    throw badRequest("an evidence bundle is required");
  }

  const dispute = await disputeRepository.findById(Number(disputeId));
  if (!dispute) return null;
  if (dispute.status !== "open") {
    throw badRequest("evidence cannot be added to a resolved dispute");
  }

  const evidenceHash = hashEvidence(evidence);
  const updated = await disputeRepository.attachEvidence(dispute.id, {
    evidence,
    evidenceHash,
  });

  return { dispute: updated, evidenceHash };
}

/** Record a weighted vote reported by the chain. */
async function recordVote(vote) {
  return disputeRepository.recordVote({
    disputeId: Number(vote.disputeId),
    voter: vote.voter,
    inFavor: Boolean(vote.inFavor),
    weight: Number(vote.weight) || 0,
    votedAt: vote.votedAt,
  });
}

/**
 * Apply a verdict: mark the dispute resolved and, when guilty, move the
 * slashed collateral and drop the respondent's reputation by the same share.
 */
async function resolveDispute({
  id,
  outcome,
  slashedAmount = 0,
  resolvedAt = Date.now(),
  slashBps,
}) {
  const normalized = normalizeOutcome(outcome);
  if (!normalized) throw badRequest(`unknown dispute outcome "${outcome}"`);

  const dispute = await disputeRepository.findById(Number(id));
  if (!dispute) return null;

  const resolved = await disputeRepository.resolve(dispute.id, {
    outcome: normalized,
    slashedAmount,
    resolvedAt,
  });

  if (normalized === OUTCOMES.Guilty) {
    if (slashedAmount > 0) {
      await agentStakeRepository.applySlash(dispute.respondent, slashedAmount);
    }
    await reputationEngine.penalizeOwner(dispute.respondent, {
      slashBps: slashBps ?? reputationEngine.getConfig().slashBps,
      nowMs: resolvedAt,
    });
    await syncStakeColumns(dispute.respondent);
  }

  notify("DISPUTE_RESOLVED", {
    disputeId: resolved.id,
    respondent: resolved.respondent,
    outcome: resolved.outcome,
    slashedAmount: resolved.slashedAmount,
  });

  return resolved;
}

async function recordStake({ agentAddress, token, amount, slashed, stakedAt }) {
  const stake = await agentStakeRepository.upsert({
    agentAddress,
    token,
    amount,
    slashed,
    stakedAt,
  });
  await syncStakeColumns(agentAddress, stake);
  return stake;
}

async function recordSlash(agentAddress, amount) {
  const stake = await agentStakeRepository.applySlash(agentAddress, amount);
  await syncStakeColumns(agentAddress, stake);

  notify("STAKE_SLASHED", { agentAddress, amount: Number(amount) || 0 });
  return stake;
}

async function syncStakeColumns(agentAddress, stake) {
  const record = stake ?? (await agentStakeRepository.findByAddress(agentAddress));
  if (!record) return;
  await agentRepository.updateStakeForOwner(agentAddress, {
    amount: record.amount,
    slashed: record.slashed,
  });
}

async function getActiveDisputes(pagination) {
  return disputeRepository.findActive(pagination);
}

async function getDispute(id) {
  const dispute = await disputeRepository.findById(Number(id));
  if (!dispute) return null;
  const votes = await disputeRepository.findVotes(dispute.id);
  return { ...dispute, votes };
}

async function getDisputesForAgent(address, pagination) {
  return disputeRepository.findByAddress(address, pagination);
}

function normalizeOutcome(outcome) {
  if (!outcome) return null;
  const key = String(outcome);
  if (OUTCOMES[key]) return OUTCOMES[key];
  const value = key.toLowerCase();
  return Object.values(OUTCOMES).includes(value) ? value : null;
}

function notify(event, payload) {
  try {
    StreamMonitor.broadcast(event, payload);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[disputeService] notification failed: ${err.message}`);
    }
  }
}

// ── Marketplace Purchase Disputes ───────────────────────────────────────────

/**
 * File a purchase dispute (buyer-facing).
 * Computes SHA-256 evidence hash and persists local dispute state.
 */
async function filePurchaseDispute({ disputeId, licenseId, buyer, evidenceText }) {
  if (!licenseId || !buyer || !evidenceText) {
    throw httpError(400, "licenseId, buyer, and evidenceText are required");
  }

  const escrow = await escrowRepository.findByLicenseId(licenseId);
  if (!escrow) {
    throw httpError(404, `Escrow hold for license ${licenseId} not found`);
  }

  if (escrow.buyer !== buyer) {
    throw httpError(403, "Only the license buyer can raise a dispute");
  }

  if (escrow.status === "Released") {
    throw httpError(400, "Cannot dispute an escrow that has already been released");
  }

  const evidenceHash = hashEvidence(evidenceText);

  // Freeze escrow status locally
  await escrowRepository.updateStatus(licenseId, "Disputed");

  const effectiveDisputeId = disputeId || Date.now();

  const dispute = await disputeRepository.createDispute({
    disputeId: effectiveDisputeId,
    licenseId,
    buyer,
    evidenceHash,
    evidenceText,
    status: "Open",
  });

  return {
    dispute,
    evidenceHash,
  };
}

/**
 * Get queue of open purchase disputes for arbitrator review.
 */
async function getArbitratorQueue() {
  const disputes = await disputeRepository.findOpenDisputes();
  const queue = await Promise.all(
    disputes.map(async (d) => {
      const escrow = await escrowRepository.findByLicenseId(d.licenseId);
      const votes = await disputeRepository.findVotesByDisputeId(d.disputeId);
      return {
        ...d,
        escrow,
        votes,
      };
    })
  );
  return queue;
}

/**
 * Cast an arbitrator vote for a dispute.
 */
async function castArbitratorVote({ disputeId, arbitrator, vote, bps = null }) {
  if (!disputeId || !arbitrator || !vote) {
    throw httpError(400, "disputeId, arbitrator, and vote decision are required");
  }

  const validVotes = ["FullRefund", "PartialRefund", "ReleaseToSeller"];
  if (!validVotes.includes(vote)) {
    throw httpError(400, `Invalid vote option. Must be one of: ${validVotes.join(", ")}`);
  }

  if (vote === "PartialRefund") {
    if (bps == null || Number.isNaN(Number(bps)) || Number(bps) < 0 || Number(bps) > 10000) {
      throw httpError(400, "PartialRefund requires bps between 0 and 10000");
    }
  }

  const dispute = await disputeRepository.findByDisputeId(disputeId);
  if (!dispute) {
    throw httpError(404, `Dispute ${disputeId} not found`);
  }

  if (dispute.status !== "Open") {
    throw httpError(400, `Dispute ${disputeId} is already resolved`);
  }

  const recordedVote = await disputeRepository.recordArbitratorVote({
    disputeId,
    arbitrator,
    vote,
    bps: vote === "PartialRefund" ? Number(bps) : null,
  });

  const votes = await disputeRepository.findVotesByDisputeId(disputeId);

  return {
    recordedVote,
    totalVotes: votes.length,
    votes,
  };
}

/**
 * Retrieve dispute details by dispute ID.
 */
async function getDisputeDetails(disputeId) {
  const dispute = await disputeRepository.findByDisputeId(disputeId);
  if (!dispute) {
    throw httpError(404, `Dispute ${disputeId} not found`);
  }
  const escrow = await escrowRepository.findByLicenseId(dispute.licenseId);
  const votes = await disputeRepository.findVotesByDisputeId(disputeId);
  return {
    ...dispute,
    escrow,
    votes,
  };
}

/**
 * Resolve dispute state (e.g. from contract event handlers).
 */
async function syncDisputeResolution(disputeId, decision) {
  const dispute = await disputeRepository.updateDisputeStatus(disputeId, "Resolved", decision);
  if (dispute && dispute.licenseId) {
    await escrowRepository.updateStatus(dispute.licenseId, "Resolved");
  }
  return dispute;
}

module.exports = {
  OUTCOMES,
  hashEvidence,
  verifyEvidence,
  fileDispute,
  submitEvidence,
  recordVote,
  resolveDispute,
  recordStake,
  recordSlash,
  getActiveDisputes,
  getDispute,
  getDisputesForAgent,

  // Marketplace Purchase Disputes
  filePurchaseDispute,
  getArbitratorQueue,
  castArbitratorVote,
  getDisputeDetails,
  syncDisputeResolution,
};
