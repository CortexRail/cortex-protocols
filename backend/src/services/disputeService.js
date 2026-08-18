/**
 * Dispute service — file purchase disputes with cryptographic evidence hashing,
 * manage arbitrator review queues, and cast votes.
 */

const crypto = require("crypto");
const disputeRepository = require("../repositories/disputeRepository");
const escrowRepository = require("../repositories/escrowRepository");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Compute SHA-256 hash of evidence string / buffer.
 */
function hashEvidence(evidenceText) {
  return crypto.createHash("sha256").update(String(evidenceText)).digest("hex");
}

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

  const recordedVote = await disputeRepository.recordVote({
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
  hashEvidence,
  filePurchaseDispute,
  getArbitratorQueue,
  castArbitratorVote,
  getDisputeDetails,
  syncDisputeResolution,
};
