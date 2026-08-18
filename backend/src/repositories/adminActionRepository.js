/**
 * Admin action repository — all SQL touching the `admin_actions` table.
 *
 * Rows are written in two steps: `create` inserts a 'pending' row before the
 * command body runs, `complete` stamps the outcome afterward. A command that
 * crashes mid-execution still leaves the 'pending' row behind as a record of
 * intent (see AuditTrail.js).
 */

const { run, toMs, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, operator, role, command, args, status, result, error,
  created_at, completed_at
`;

function mapAction(row) {
  if (!row) return null;
  return {
    id: row.id,
    operator: row.operator,
    role: row.role,
    command: row.command,
    args: row.args,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: toMs(row.created_at),
    completedAt: toMs(row.completed_at),
  };
}

async function create({ operator, role, command, args = {} }, client) {
  const { rows } = await run(
    `INSERT INTO admin_actions (operator, role, command, args)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING ${COLUMNS}`,
    [operator, role, command, JSON.stringify(args)],
    client
  );
  return mapAction(rows[0]);
}

async function complete(id, { status, result = null, error = null }, client) {
  const { rows } = await run(
    `UPDATE admin_actions
     SET status = $2, result = $3::jsonb, error = $4, completed_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, status, result === null ? null : JSON.stringify(result), error],
    client
  );
  return mapAction(rows[0]);
}

/**
 * Most recent actions first — used by `stream inspect`-style debugging and
 * the TUI dashboard's "recent admin actions" panel.
 */
async function findRecent(pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);

  const countResult = await run("SELECT count(*)::bigint AS total FROM admin_actions", [], client);
  const total = Number(countResult.rows[0].total);

  const { rows } = await run(
    `SELECT ${COLUMNS} FROM admin_actions
     ORDER BY created_at DESC, id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
    client
  );

  return { data: rows.map(mapAction), meta: buildMeta(total, page, limit) };
}

module.exports = { create, complete, findRecent };
