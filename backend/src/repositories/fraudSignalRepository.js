/**
 * Fraud signal repository — all SQL touching the `fraud_signals` table.
 *
 * Signals are upserted, not appended: a partial unique index keeps at most one
 * ACTIVE row per (detector, agent, asset), so re-running the scan over an
 * overlapping window refreshes the score instead of flooding the queue.
 * "Active" means open OR reported — a signal already under moderation must
 * keep absorbing re-scans rather than spawning a duplicate every cycle. Only
 * a dismissed signal leaves the index, letting a genuinely new occurrence
 * open a fresh row after an operator has called it a false positive.
 */

const { run, toMs, msParam, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, scan_id, detector, agent_address, asset_id, score, risk_tier, evidence,
  explanation, window_start, window_end, status, report_id, dismissed_by,
  dismissed_at, dismiss_reason, created_at, updated_at
`;

/** Mirrors the detector CHECK constraint in migration 012. */
const DETECTORS = Object.freeze([
  "velocity",
  "sybil_graph",
  "wash_usage",
  "replay_abuse",
  "composite",
]);

/** Mirrors the risk_tier CHECK constraint in migration 012. */
const RISK_TIERS = Object.freeze(["low", "medium", "high", "critical"]);

function mapSignal(row) {
  if (!row) return null;
  return {
    id: row.id,
    scanId: row.scan_id,
    detector: row.detector,
    agentAddress: row.agent_address,
    assetId: row.asset_id,
    // NUMERIC comes back from pg as a string (only INT8 is parsed globally).
    score: Number(row.score),
    riskTier: row.risk_tier,
    evidence: row.evidence,
    explanation: row.explanation,
    windowStart: toMs(row.window_start),
    windowEnd: toMs(row.window_end),
    status: row.status,
    reportId: row.report_id,
    dismissedBy: row.dismissed_by,
    dismissedAt: toMs(row.dismissed_at),
    dismissReason: row.dismiss_reason,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Insert a signal, or refresh the active one already covering this subject.
 *
 * A row already routed into moderation ('reported') is refreshed in place and
 * keeps its status and report link — the score moves, the queue item does not
 * duplicate.
 *
 * @param {object} signal
 * @param {string} signal.scanId - UUID grouping one scan run
 * @param {string} signal.detector - one of DETECTORS
 * @param {string} signal.agentAddress
 * @param {number|null} [signal.assetId]
 * @param {number} signal.score - normalized 0..1
 * @param {string} signal.riskTier - one of RISK_TIERS
 * @param {object} [signal.evidence] - structured explainability payload
 * @param {string} signal.explanation - human-readable; the schema rejects ""
 * @param {number} signal.windowStart - epoch ms
 * @param {number} signal.windowEnd - epoch ms
 */
async function upsertActive(signal, client) {
  const {
    scanId,
    detector,
    agentAddress,
    assetId = null,
    score,
    riskTier,
    evidence = {},
    explanation,
    windowStart,
    windowEnd,
  } = signal;

  const { rows } = await run(
    `INSERT INTO fraud_signals
       (scan_id, detector, agent_address, asset_id, score, risk_tier,
        evidence, explanation, window_start, window_end)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7::jsonb, $8,
        to_timestamp($9::double precision / 1000.0),
        to_timestamp($10::double precision / 1000.0))
     ON CONFLICT (detector, agent_address, COALESCE(asset_id, 0))
       WHERE status <> 'dismissed'
     DO UPDATE SET
       scan_id      = EXCLUDED.scan_id,
       score        = EXCLUDED.score,
       risk_tier    = EXCLUDED.risk_tier,
       evidence     = EXCLUDED.evidence,
       explanation  = EXCLUDED.explanation,
       window_start = EXCLUDED.window_start,
       window_end   = EXCLUDED.window_end,
       updated_at   = now()
     RETURNING ${COLUMNS}`,
    [
      scanId,
      detector,
      agentAddress,
      assetId,
      score,
      riskTier,
      JSON.stringify(evidence ?? {}),
      explanation,
      msParam(windowStart),
      msParam(windowEnd),
    ],
    client
  );
  return mapSignal(rows[0]);
}

async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM fraud_signals WHERE id = $1`,
    [id],
    client,
    "read"
  );
  return mapSignal(rows[0]);
}

/**
 * The admin risk queue: filterable by tier, detector, status, and subject.
 *
 * Defaults to score-descending because the dashboard's job is triage; pass
 * `sort: "recent"` for the chronological view.
 */
async function findAll(filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);
  const params = [];
  const clauses = [];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.detector) {
    params.push(filters.detector);
    clauses.push(`detector = $${params.length}`);
  }
  if (filters.riskTier) {
    params.push(filters.riskTier);
    clauses.push(`risk_tier = $${params.length}`);
  }
  if (filters.agentAddress) {
    params.push(filters.agentAddress);
    clauses.push(`agent_address = $${params.length}`);
  }
  if (filters.assetId !== undefined && filters.assetId !== null) {
    params.push(filters.assetId);
    clauses.push(`asset_id = $${params.length}`);
  }
  if (filters.minScore !== undefined && filters.minScore !== null) {
    params.push(filters.minScore);
    clauses.push(`score >= $${params.length}`);
  }
  if (filters.scanId) {
    params.push(filters.scanId);
    clauses.push(`scan_id = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const order =
    filters.sort === "recent"
      ? "created_at DESC, id DESC"
      : "score DESC, created_at DESC, id DESC";

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM fraud_signals ${where}`,
    params,
    client,
    "read"
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM fraud_signals ${where}
     ORDER BY ${order}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
    "read"
  );

  return { data: rows.map(mapSignal), meta: buildMeta(total, page, limit) };
}

/**
 * Every open signal against one address, worst first — the payload behind the
 * agent drill-down and the input the scorer combines per subject.
 */
async function findOpenByAgent(agentAddress, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM fraud_signals
     WHERE agent_address = $1 AND status = 'open'
     ORDER BY score DESC, id DESC`,
    [agentAddress],
    client,
    "read"
  );
  return rows.map(mapSignal);
}

/**
 * Mark a signal as a false positive. Returns null when the signal doesn't
 * exist or has already left the open state, so the caller can answer 404/409
 * without a second query.
 */
async function dismiss(id, { dismissedBy, reason = null } = {}, client) {
  const { rows } = await run(
    `UPDATE fraud_signals
     SET status         = 'dismissed',
         dismissed_by   = $2,
         dismiss_reason = $3,
         dismissed_at   = now(),
         updated_at     = now()
     WHERE id = $1 AND status = 'open'
     RETURNING ${COLUMNS}`,
    [id, dismissedBy, reason],
    client
  );
  return mapSignal(rows[0]);
}

/**
 * Record that a signal was routed into the moderation queue.
 */
async function attachReport(id, reportId, client) {
  const { rows } = await run(
    `UPDATE fraud_signals
     SET status     = 'reported',
         report_id  = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, reportId],
    client
  );
  return mapSignal(rows[0]);
}

/**
 * Open-signal counts per risk tier — the dashboard's summary row.
 *
 * @returns {Promise<Record<string, number>>} every tier present, zero-filled
 */
async function countsByTier(client) {
  const { rows } = await run(
    `SELECT risk_tier, count(*)::bigint AS total
     FROM fraud_signals
     WHERE status = 'open'
     GROUP BY risk_tier`,
    [],
    client,
    "read"
  );

  const counts = Object.fromEntries(RISK_TIERS.map((tier) => [tier, 0]));
  for (const row of rows) {
    counts[row.risk_tier] = Number(row.total);
  }
  return counts;
}

module.exports = {
  upsertActive,
  findById,
  findAll,
  findOpenByAgent,
  dismiss,
  attachReport,
  countsByTier,
  DETECTORS,
  RISK_TIERS,
};
