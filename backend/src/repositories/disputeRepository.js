/**
 * Dispute Repository — SQL database interactions for `purchase_disputes` & `arbitrator_votes`.
 */

const { run, toMs } = require("./repoUtils");

const DISPUTE_COLUMNS = `
  dispute_id, license_id, buyer, evidence_hash, evidence_text, status, decision,
  created_at, updated_at
`;

function mapDispute(row) {
  if (!row) return null;
  return {
    disputeId: Number(row.dispute_id),
    licenseId: Number(row.license_id),
    buyer: row.buyer,
    evidenceHash: row.evidence_hash,
    evidenceText: row.evidence_text || null,
    status: row.status,
    decision: row.decision || null,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

function mapVote(row) {
  if (!row) return null;
  return {
    id: row.id,
    disputeId: Number(row.dispute_id),
    arbitrator: row.arbitrator,
    vote: row.vote,
    bps: row.bps != null ? Number(row.bps) : null,
    createdAt: toMs(row.created_at),
  };
}

async function createDispute(dispute, client) {
  const {
    disputeId,
    licenseId,
    buyer,
    evidenceHash,
    evidenceText = null,
    status = "Open",
  } = dispute;

  const { rows } = await run(
    `INSERT INTO purchase_disputes
       (dispute_id, license_id, buyer, evidence_hash, evidence_text, status)
     VALUES
       ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dispute_id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = now()
     RETURNING ${DISPUTE_COLUMNS}`,
    [disputeId, licenseId, buyer, evidenceHash, evidenceText, status],
    client
  );
  return mapDispute(rows[0]);
}

async function findByDisputeId(disputeId, client) {
  const { rows } = await run(
    `SELECT ${DISPUTE_COLUMNS} FROM purchase_disputes WHERE dispute_id = $1`,
    [disputeId],
    client
  );
  return mapDispute(rows[0]);
}

async function findByLicenseId(licenseId, client) {
  const { rows } = await run(
    `SELECT ${DISPUTE_COLUMNS} FROM purchase_disputes WHERE license_id = $1`,
    [licenseId],
    client
  );
  return mapDispute(rows[0]);
}

async function updateDisputeStatus(disputeId, status, decision = null, client) {
  const { rows } = await run(
    `UPDATE purchase_disputes
     SET status = $2, decision = COALESCE($3, decision), updated_at = now()
     WHERE dispute_id = $1
     RETURNING ${DISPUTE_COLUMNS}`,
    [disputeId, status, decision],
    client
  );
  return mapDispute(rows[0]);
}

async function findOpenDisputes(client) {
  const { rows } = await run(
    `SELECT ${DISPUTE_COLUMNS} FROM purchase_disputes
     WHERE status = 'Open' ORDER BY created_at ASC`,
    [],
    client
  );
  return rows.map(mapDispute);
}

async function recordVote({ disputeId, arbitrator, vote, bps = null }, client) {
  const { rows } = await run(
    `INSERT INTO arbitrator_votes
       (dispute_id, arbitrator, vote, bps)
     VALUES
       ($1, $2, $3, $4)
     ON CONFLICT (dispute_id, arbitrator) DO UPDATE SET
       vote = EXCLUDED.vote,
       bps = EXCLUDED.bps
     RETURNING id, dispute_id, arbitrator, vote, bps, created_at`,
    [disputeId, arbitrator, vote, bps],
    client
  );
  return mapVote(rows[0]);
}

async function findVotesByDisputeId(disputeId, client) {
  const { rows } = await run(
    `SELECT id, dispute_id, arbitrator, vote, bps, created_at
     FROM arbitrator_votes WHERE dispute_id = $1`,
    [disputeId],
    client
  );
  return rows.map(mapVote);
}

module.exports = {
  createDispute,
  findByDisputeId,
  findByLicenseId,
  updateDisputeStatus,
  findOpenDisputes,
  recordVote,
  findVotesByDisputeId,
};
