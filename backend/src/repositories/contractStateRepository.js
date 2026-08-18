/**
 * Contract state repository — all SQL touching the `contract_state` table.
 *
 * Tracks the off-chain pause flag `cortex-admin contract pause|unpause`
 * toggles for a named contract (marketplace, micropayments, agent_registry).
 * Rows are created on first pause; an unpaused, never-paused contract has
 * no row, and `isPaused` treats that as not-paused.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = "name, paused, paused_by, paused_at, updated_at";

function mapState(row) {
  if (!row) return null;
  return {
    name: row.name,
    paused: row.paused,
    pausedBy: row.paused_by,
    pausedAt: toMs(row.paused_at),
    updatedAt: toMs(row.updated_at),
  };
}

async function setPaused(name, paused, pausedBy, client) {
  const { rows } = await run(
    `INSERT INTO contract_state (name, paused, paused_by, paused_at)
     VALUES ($1, $2, $3, CASE WHEN $2 THEN now() ELSE NULL END)
     ON CONFLICT (name) DO UPDATE SET
       paused     = EXCLUDED.paused,
       paused_by  = EXCLUDED.paused_by,
       paused_at  = CASE WHEN EXCLUDED.paused THEN now() ELSE NULL END,
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [name, paused, pausedBy],
    client
  );
  return mapState(rows[0]);
}

async function findByName(name, client) {
  const { rows } = await run(`SELECT ${COLUMNS} FROM contract_state WHERE name = $1`, [name], client);
  return mapState(rows[0]);
}

async function isPaused(name, client) {
  const state = await findByName(name, client);
  return state ? state.paused : false;
}

module.exports = { setPaused, findByName, isPaused };
