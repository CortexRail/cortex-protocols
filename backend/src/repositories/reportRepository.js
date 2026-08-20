/**
 * Report repository — all SQL touching the `reports` table lives here.
 */

const { run, toMs, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, asset_id, reporter, reason, details, status, resolution_note,
  source, evidence, created_at, resolved_at
`;

function mapReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    assetId: row.asset_id,
    reporter: row.reporter,
    reason: row.reason,
    details: row.details,
    status: row.status,
    resolutionNote: row.resolution_note,
    source: row.source,
    evidence: row.evidence,
    createdAt: toMs(row.created_at),
    resolvedAt: toMs(row.resolved_at),
  };
}

/**
 * File a moderation report. A partial unique index blocks duplicate OPEN
 * reports from the same reporter on the same asset.
 */
async function create(report, client) {
  const { assetId, reporter, reason, details = "" } = report;

  const { rows } = await run(
    `INSERT INTO reports (asset_id, reporter, reason, details)
     VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [assetId, reporter, reason, details],
    client
  );
  return mapReport(rows[0]);
}

async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM reports WHERE id = $1`,
    [id],
    client,
    "read"
  );
  return mapReport(rows[0]);
}

/**
 * List reports, filterable by status and/or asset.
 */
async function findAll(filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);
  const params = [];
  const clauses = [];

  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }
  if (filters.assetId !== undefined && filters.assetId !== null) {
    params.push(filters.assetId);
    clauses.push(`asset_id = $${params.length}`);
  }
  if (filters.reporter) {
    params.push(filters.reporter);
    clauses.push(`reporter = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM reports ${where}`,
    params,
    client,
    "read"
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM reports ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client,
    "read"
  );

  return { data: rows.map(mapReport), meta: buildMeta(total, page, limit) };
}

/**
 * Advance a report through the moderation flow. Terminal states stamp
 * resolved_at; an optional note documents the decision.
 */
async function updateStatus(id, status, resolutionNote = null, client) {
  const { rows } = await run(
    `UPDATE reports
     SET status = $2,
         resolution_note = COALESCE($3, resolution_note),
         resolved_at = CASE
           WHEN $2 IN ('Resolved', 'Dismissed') THEN now()
           ELSE resolved_at
         END
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, status, resolutionNote],
    client
  );
  return mapReport(rows[0]);
}

/**
 * Count every report ever filed against an asset, regardless of status —
 * used to decide whether the asset has crossed the auto-flagging threshold.
 */
async function countForAsset(assetId, client) {
  const { rows } = await run(
    `SELECT count(*)::bigint AS total FROM reports WHERE asset_id = $1`,
    [assetId],
    client,
    "read"
  );
  return Number(rows[0].total);
}

/**
 * File (or refresh) the automated report the fraud scan raises for an asset.
 *
 * The partial unique index `idx_reports_one_open_per_reporter` allows exactly
 * one open report per (asset, reporter). For a human that guard exists to stop
 * spam; for the scanner it is exactly the behaviour we want — every scan cycle
 * refreshes the same queue item with the current evidence rather than filing a
 * new report each time it runs.
 *
 * Only OPEN reports collide, so once a moderator resolves or dismisses one, a
 * later scan files a fresh report rather than silently reopening a closed case.
 */
async function upsertAutomated(report, client) {
  const { assetId, reporter, reason, details = "", evidence = null } = report;

  const { rows } = await run(
    `INSERT INTO reports (asset_id, reporter, reason, details, source, evidence)
     VALUES ($1, $2, $3, $4, 'automated', $5::jsonb)
     ON CONFLICT (asset_id, reporter)
       WHERE status IN ('Pending', 'UnderReview')
     DO UPDATE SET
       reason   = EXCLUDED.reason,
       details  = EXCLUDED.details,
       evidence = EXCLUDED.evidence
     RETURNING ${COLUMNS}`,
    [
      assetId,
      reporter,
      reason,
      details,
      evidence === null ? null : JSON.stringify(evidence),
    ],
    client
  );
  return mapReport(rows[0]);
}

module.exports = {
  create,
  findById,
  findAll,
  updateStatus,
  countForAsset,
  upsertAutomated,
};
