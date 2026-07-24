/**
 * Stream repository — all SQL touching the `streams` table lives here.
 */

const { run, toMs, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, sender, recipient, token, deposit, rate_per_second, start_time,
  end_time, status, withdrawn, indexed_at, updated_at,
  calls_remaining, calls_used, price_per_call
`;

function mapStream(row) {
  if (!row) return null;
  return {
    id: row.id,
    sender: row.sender,
    recipient: row.recipient,
    token: row.token,
    deposit: row.deposit,
    ratePerSecond: row.rate_per_second,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    withdrawn: row.withdrawn,
    indexedAt: toMs(row.indexed_at),
    updatedAt: toMs(row.updated_at),
    callsRemaining: row.calls_remaining,
    callsUsed: row.calls_used,
    pricePerCall: row.price_per_call,
  };
}

/**
 * Upsert a stream by its on-chain id.
 */
async function create(stream, client) {
  const {
    id,
    sender,
    recipient,
    token,
    deposit,
    ratePerSecond,
    startTime,
    endTime,
    status = "Active",
    withdrawn = 0,
    callsRemaining = 0,
    callsUsed = 0,
    pricePerCall = 0,
  } = stream;

  const { rows } = await run(
    `INSERT INTO streams
       (id, sender, recipient, token, deposit, rate_per_second,
        start_time, end_time, status, withdrawn, calls_remaining, calls_used, price_per_call)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (id) DO UPDATE SET
       sender          = EXCLUDED.sender,
       recipient       = EXCLUDED.recipient,
       token           = EXCLUDED.token,
       deposit         = EXCLUDED.deposit,
       rate_per_second = EXCLUDED.rate_per_second,
       start_time      = EXCLUDED.start_time,
       end_time        = EXCLUDED.end_time,
       status          = EXCLUDED.status,
       withdrawn       = EXCLUDED.withdrawn,
       calls_remaining = EXCLUDED.calls_remaining,
       calls_used      = EXCLUDED.calls_used,
       price_per_call  = EXCLUDED.price_per_call,
       updated_at      = now()
     RETURNING ${COLUMNS}`,
    [
      id,
      sender,
      recipient,
      token,
      deposit,
      ratePerSecond,
      startTime,
      endTime,
      status,
      withdrawn,
      callsRemaining,
      callsUsed,
      pricePerCall,
    ],
    client
  );
  return mapStream(rows[0]);
}

async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM streams WHERE id = $1`,
    [id],
    client
  );
  return mapStream(rows[0]);
}

/**
 * List streams with any combination of sender/recipient/status filters.
 */
async function findAll(filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);
  const params = [];
  const clauses = [];

  if (filters.sender) {
    params.push(filters.sender);
    clauses.push(`sender = $${params.length}`);
  }
  if (filters.recipient) {
    params.push(filters.recipient);
    clauses.push(`recipient = $${params.length}`);
  }
  if (filters.status) {
    params.push(filters.status);
    clauses.push(`status = $${params.length}`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM streams ${where}`,
    params,
    client
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM streams ${where}
     ORDER BY indexed_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client
  );

  return { data: rows.map(mapStream), meta: buildMeta(total, page, limit) };
}

function findBySender(sender, pagination = {}, client) {
  return findAll({ sender }, pagination, client);
}

function findByRecipient(recipient, pagination = {}, client) {
  return findAll({ recipient }, pagination, client);
}

/**
 * Transition the stream status (CHECK constraint enforces the enum).
 */
async function updateStatus(id, status, client) {
  const { rows } = await run(
    `UPDATE streams SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, status],
    client
  );
  return mapStream(rows[0]);
}

/**
 * Record a withdrawal against the stream's deposit.
 *
 * The guard lives in the WHERE clause so concurrent withdrawals can never
 * push `withdrawn` past `deposit`. Returns the updated stream, null if the
 * stream doesn't exist, and throws if the amount would exceed the deposit.
 */
async function recordWithdrawal(id, amount, client) {
  const { rows } = await run(
    `UPDATE streams
     SET withdrawn = withdrawn + $2, updated_at = now()
     WHERE id = $1 AND withdrawn + $2 <= deposit
     RETURNING ${COLUMNS}`,
    [id, amount],
    client
  );
  if (rows.length) return mapStream(rows[0]);

  const existing = await findById(id, client);
  if (!existing) return null;

  throw new Error(
    `stream ${id}: withdrawal of ${amount} exceeds remaining deposit ` +
      `(${existing.deposit - existing.withdrawn} available)`
  );
}

async function findAndLockById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM streams WHERE id = $1 FOR UPDATE`,
    [id],
    client
  );
  return mapStream(rows[0]);
}

async function updateCalls(id, callsRemaining, callsUsed, client) {
  const { rows } = await run(
    `UPDATE streams
     SET calls_remaining = $2,
         calls_used = $3,
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, callsRemaining, callsUsed],
    client
  );
  return mapStream(rows[0]);
}

async function findStreamsToSettle(batchSize = 25, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM streams WHERE status = 'Active' AND calls_used >= $1`,
    [batchSize],
    client
  );
  return rows.map(mapStream);
}

module.exports = {
  create,
  findById,
  findAndLockById,
  findAll,
  findBySender,
  findByRecipient,
  updateStatus,
  recordWithdrawal,
  updateCalls,
  findStreamsToSettle,
};
