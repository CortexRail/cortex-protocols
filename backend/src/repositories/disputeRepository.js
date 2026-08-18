/**
 * Dispute Repository — SQL database interactions for both `disputes` (agent registry disputes)
 * and `purchase_disputes` & `arbitrator_votes` (marketplace purchase disputes).
 */

const {
  run,
  toMs,
  msParam,
  normalizePagination,
  buildMeta,
} = require("./repoUtils");

// ── Agent Registry Disputes ───────────────────────────────────────────────

const COLUMNS = `
  id, complainant, respondent, evidence_hash, evidence, status, outcome,
  weight_for, weight_against, slashed_amount, opened_at, closes_at,
  resolved_at, indexed_at, updated_at
`;

function mapDispute(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    complainant: row.complainant,
    respondent: row.respondent,
    evidenceHash: row.evidence_hash,
    evidence: row.evidence ?? null,
    status: row.status,
    outcome: row.outcome ?? null,
    weightFor: Number(row.weight_for),
    weightAgainst: Number(row.weight_against),
    slashedAmount: Number(row.slashed_amount),
    openedAt: toMs(row.opened_at),
    closesAt: toMs(row.closes_at),
    resolvedAt: toMs(row.resolved_at),
    indexedAt: toMs(row.indexed_at),
    updatedAt: toMs(row.updated_at),
  };
}

function mapVote(row) {
  if (!row) return null;
  return {
    disputeId: Number(row.dispute_id),
    voter: row.voter,
    inFavor: row.in_favor,
    weight: Number(row.weight),
    votedAt: toMs(row.voted_at),
  };
}

/**
 * Upsert a dispute by its on-chain id.
 */
async function upsert(dispute, client) {
  const {
    id,
    complainant,
    respondent,
    evidenceHash = "",
    evidence = null,
    status = "open",
    outcome = null,
    weightFor = 0,
    weightAgainst = 0,
    slashedAmount = 0,
    openedAt,
    closesAt,
    resolvedAt,
  } = dispute;

  const { rows } = await run(
    `INSERT INTO disputes
       (id, complainant, respondent, evidence_hash, evidence, status, outcome,
        weight_for, weight_against, slashed_amount, opened_at, closes_at, resolved_at)
     VALUES
       ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10,
        COALESCE(to_timestamp($11::double precision / 1000.0), now()),
        to_timestamp($12::double precision / 1000.0),
        to_timestamp($13::double precision / 1000.0))
     ON CONFLICT (id) DO UPDATE SET
       evidence_hash  = EXCLUDED.evidence_hash,
       evidence       = COALESCE(EXCLUDED.evidence, disputes.evidence),
       status         = EXCLUDED.status,
       outcome        = EXCLUDED.outcome,
       weight_for     = EXCLUDED.weight_for,
       weight_against = EXCLUDED.weight_against,
       slashed_amount = EXCLUDED.slashed_amount,
       closes_at      = COALESCE(EXCLUDED.closes_at, disputes.closes_at),
       resolved_at    = COALESCE(EXCLUDED.resolved_at, disputes.resolved_at),
       updated_at     = now()
     RETURNING ${COLUMNS}`,
    [
      id,
      complainant,
      respondent,
      evidenceHash,
      evidence === null ? null : JSON.stringify(evidence),
      status,
      outcome,
      weightFor,
      weightAgainst,
      slashedAmount,
      msParam(openedAt),
      msParam(closesAt),
      msParam(resolvedAt),
    ],
    client
  );
  return mapDispute(rows[0]);
}

/**
 * Record the verdict of a dispute.
 */
async function resolve(id, { outcome, slashedAmount = 0, resolvedAt } = {}, client) {
  const { rows } = await run(
    `UPDATE disputes
        SET status         = 'resolved',
            outcome        = $2,
            slashed_amount = $3,
            resolved_at    = COALESCE(to_timestamp($4::double precision / 1000.0), now()),
            updated_at     = now()
      WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, outcome, slashedAmount, msParam(resolvedAt)],
    client
  );
  return mapDispute(rows[0]);
}

/**
 * Attach (or replace) the off-chain evidence bundle and its digest.
 */
async function attachEvidence(id, { evidence, evidenceHash }, client) {
  const { rows } = await run(
    `UPDATE disputes
        SET evidence      = $2::jsonb,
            evidence_hash = COALESCE(NULLIF($3, ''), evidence_hash),
            updated_at    = now()
      WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, JSON.stringify(evidence ?? null), evidenceHash ?? ""],
    client
  );
  return mapDispute(rows[0]);
}

async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM disputes WHERE id = $1`,
    [id],
    client,
    "read"
  );
  return mapDispute(rows[0]);
}

/**
 * Disputes still open for voting, oldest deadline first.
 */
async function findActive(pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);

  const countResult = await run(
    "SELECT count(*)::bigint AS total FROM disputes WHERE status = 'open'",
    [],
    client,
    "read"
  );
  const total = Number(countResult.rows[0].total);

  const { rows } = await run(
    `SELECT ${COLUMNS} FROM disputes
      WHERE status = 'open'
      ORDER BY closes_at ASC NULLS LAST, id ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
    client,
    "read"
  );

  return { data: rows.map(mapDispute), meta: buildMeta(total, page, limit) };
}

/**
 * Every dispute an address is involved in, as complainant or respondent.
 */
async function findByAddress(address, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);

  const countResult = await run(
    "SELECT count(*)::bigint AS total FROM disputes WHERE respondent = $1 OR complainant = $1",
    [address],
    client,
    "read"
  );
  const total = Number(countResult.rows[0].total);

  const { rows } = await run(
    `SELECT ${COLUMNS} FROM disputes
      WHERE respondent = $1 OR complainant = $1
      ORDER BY opened_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [address, limit, offset],
    client,
    "read"
  );

  return { data: rows.map(mapDispute), meta: buildMeta(total, page, limit) };
}

/**
 * Record a weighted vote and fold its weight into the dispute tally.
 */
async function recordVote(vote, client) {
  const { disputeId, voter, inFavor, weight = 0, votedAt } = vote;

  const { rows } = await run(
    `INSERT INTO dispute_votes (dispute_id, voter, in_favor, weight, voted_at)
     VALUES ($1, $2, $3, $4, COALESCE(to_timestamp($5::double precision / 1000.0), now()))
     ON CONFLICT (dispute_id, voter) DO NOTHING
     RETURNING dispute_id, voter, in_favor, weight, voted_at`,
    [disputeId, voter, inFavor, weight, msParam(votedAt)],
    client
  );

  if (rows.length === 0) return null;

  await run(
    `UPDATE disputes
        SET weight_for     = weight_for + CASE WHEN $2 THEN $3 ELSE 0 END,
            weight_against = weight_against + CASE WHEN $2 THEN 0 ELSE $3 END,
            updated_at     = now()
      WHERE id = $1`,
    [disputeId, inFavor, weight],
    client
  );

  return mapVote(rows[0]);
}

async function findVotes(disputeId, client) {
  const { rows } = await run(
    `SELECT dispute_id, voter, in_favor, weight, voted_at
       FROM dispute_votes WHERE dispute_id = $1 ORDER BY voted_at ASC`,
    [disputeId],
    client,
    "read"
  );
  return rows.map(mapVote);
}

// ── Marketplace Purchase Disputes ───────────────────────────────────────────

const DISPUTE_COLUMNS = `
  dispute_id, license_id, buyer, evidence_hash, evidence_text, status, decision,
  created_at, updated_at
`;

function mapPurchaseDispute(row) {
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

function mapArbitratorVote(row) {
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
  return mapPurchaseDispute(rows[0]);
}

async function findByDisputeId(disputeId, client) {
  const { rows } = await run(
    `SELECT ${DISPUTE_COLUMNS} FROM purchase_disputes WHERE dispute_id = $1`,
    [disputeId],
    client
  );
  return mapPurchaseDispute(rows[0]);
}

async function findByLicenseId(licenseId, client) {
  const { rows } = await run(
    `SELECT ${DISPUTE_COLUMNS} FROM purchase_disputes WHERE license_id = $1`,
    [licenseId],
    client
  );
  return mapPurchaseDispute(rows[0]);
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
  return mapPurchaseDispute(rows[0]);
}

async function findOpenDisputes(client) {
  const { rows } = await run(
    `SELECT ${DISPUTE_COLUMNS} FROM purchase_disputes
     WHERE status = 'Open' ORDER BY created_at ASC`,
    [],
    client
  );
  return rows.map(mapPurchaseDispute);
}

async function recordArbitratorVote({ disputeId, arbitrator, vote, bps = null }, client) {
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
  return mapArbitratorVote(rows[0]);
}

async function findVotesByDisputeId(disputeId, client) {
  const { rows } = await run(
    `SELECT id, dispute_id, arbitrator, vote, bps, created_at
     FROM arbitrator_votes WHERE dispute_id = $1`,
    [disputeId],
    client
  );
  return rows.map(mapArbitratorVote);
}

module.exports = {
  // Agent Registry Disputes
  upsert,
  resolve,
  attachEvidence,
  findById,
  findActive,
  findByAddress,
  recordVote,
  findVotes,

  // Marketplace Purchase Disputes
  createDispute,
  findByDisputeId,
  findByLicenseId,
  updateDisputeStatus,
  findOpenDisputes,
  recordArbitratorVote,
  findVotesByDisputeId,
};
