/**
 * Agent repository — all SQL touching the `agents` table lives here.
 */

const {
  run,
  toMs,
  msParam,
  normalizePagination,
  buildMeta,
  escapeLike,
} = require("./repoUtils");

const COLUMNS = `
  id, owner, name, description, capabilities, reputation,
  total_transactions, is_active, registered_at, indexed_at, updated_at
`;

function mapAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    description: row.description,
    capabilities: row.capabilities,
    reputation: row.reputation,
    totalTransactions: row.total_transactions,
    isActive: row.is_active,
    registeredAt: toMs(row.registered_at),
    indexedAt: toMs(row.indexed_at),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Upsert an agent by its on-chain id.
 */
async function create(agent, client) {
  const {
    id,
    owner,
    name,
    description = "",
    capabilities = [],
    reputation = 5000,
    totalTransactions = 0,
    isActive = true,
    registeredAt,
  } = agent;

  const { rows } = await run(
    `INSERT INTO agents
       (id, owner, name, description, capabilities, reputation,
        total_transactions, is_active, registered_at)
     VALUES
       ($1, $2, $3, $4, $5::text[], $6, $7, $8,
        COALESCE(to_timestamp($9::double precision / 1000.0), now()))
     ON CONFLICT (id) DO UPDATE SET
       owner              = EXCLUDED.owner,
       name               = EXCLUDED.name,
       description        = EXCLUDED.description,
       capabilities       = EXCLUDED.capabilities,
       reputation         = EXCLUDED.reputation,
       total_transactions = EXCLUDED.total_transactions,
       is_active          = EXCLUDED.is_active,
       indexed_at         = now(),
       updated_at         = now()
     RETURNING ${COLUMNS}`,
    [
      id,
      owner,
      name,
      description,
      capabilities,
      reputation,
      totalTransactions,
      isActive,
      msParam(registeredAt),
    ],
    client
  );
  return mapAgent(rows[0]);
}

/**
 * Fetch one agent by id (active or not — callers inspect isActive).
 */
async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agents WHERE id = $1`,
    [id],
    client
  );
  return mapAgent(rows[0]);
}

/**
 * List active agents with filters + pagination.
 */
async function findAll(filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);
  const params = [];
  const clauses = [];

  if (!filters.includeInactive) clauses.push("is_active");
  if (filters.capability) {
    params.push([filters.capability]);
    clauses.push(`capabilities @> $${params.length}::text[]`);
  }
  if (filters.minReputation !== undefined && filters.minReputation !== null) {
    params.push(filters.minReputation);
    clauses.push(`reputation >= $${params.length}`);
  }
  if (filters.search) {
    params.push(`%${escapeLike(filters.search)}%`);
    clauses.push(
      `(name ILIKE $${params.length} OR description ILIKE $${params.length})`
    );
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM agents ${where}`,
    params,
    client
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM agents ${where}
     ORDER BY registered_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client
  );

  return { data: rows.map(mapAgent), meta: buildMeta(total, page, limit) };
}

/**
 * Set an agent's reputation (basis points, 0–10000 enforced by CHECK).
 */
async function updateReputation(id, reputation, client) {
  const { rows } = await run(
    `UPDATE agents SET reputation = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, reputation],
    client
  );
  return mapAgent(rows[0]);
}

/**
 * Deactivate an agent (hidden from discovery, row preserved).
 */
async function deactivate(id, client) {
  const { rowCount } = await run(
    `UPDATE agents SET is_active = FALSE, updated_at = now()
     WHERE id = $1 AND is_active`,
    [id],
    client
  );
  return rowCount > 0;
}

module.exports = { create, findById, findAll, updateReputation, deactivate };
