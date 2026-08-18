/**
 * Agent ban repository — all SQL touching the `agent_bans` table.
 *
 * A row's presence is the ban; there is no separate active/inactive flag,
 * so `unban` deletes the row outright.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = "agent_id, reason, banned_by, banned_at";

function mapBan(row) {
  if (!row) return null;
  return {
    agentId: row.agent_id,
    reason: row.reason,
    bannedBy: row.banned_by,
    bannedAt: toMs(row.banned_at),
  };
}

async function ban(agentId, { reason, bannedBy }, client) {
  const { rows } = await run(
    `INSERT INTO agent_bans (agent_id, reason, banned_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id) DO UPDATE SET
       reason    = EXCLUDED.reason,
       banned_by = EXCLUDED.banned_by,
       banned_at = now()
     RETURNING ${COLUMNS}`,
    [agentId, reason, bannedBy],
    client
  );
  return mapBan(rows[0]);
}

async function unban(agentId, client) {
  const { rowCount } = await run("DELETE FROM agent_bans WHERE agent_id = $1", [agentId], client);
  return rowCount > 0;
}

async function findByAgentId(agentId, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agent_bans WHERE agent_id = $1`,
    [agentId],
    client
  );
  return mapBan(rows[0]);
}

async function isBanned(agentId, client) {
  return (await findByAgentId(agentId, client)) !== null;
}

module.exports = { ban, unban, findByAgentId, isBanned };
