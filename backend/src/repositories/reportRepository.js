/**
 * Report repository — all SQL touching the `reports` table lives here.
 */

const { run, toMs, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, asset_id, reporter, reason, details, status, resolution_note,
  created_at, resolved_at
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
    client
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
    client
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM reports ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client
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

module.exports = { create, findById, findAll, updateStatus };
