/**
 * Settlement repository — all SQL touching the `settlement_ledger` table lives here.
 * Provides two-phase commit log for crash-safe settlement tracking.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = `
  id, batch_nonce, recipient, stream_ids, expected_amounts, status,
  error_message, retry_count, created_at, updated_at, confirmed_at, ledger_sequence
`;

function mapSettlement(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchNonce: row.batch_nonce,
    recipient: row.recipient,
    streamIds: row.stream_ids,
    expectedAmounts: row.expected_amounts,
    status: row.status,
    errorMessage: row.error_message,
    retryCount: row.retry_count,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
    confirmedAt: row.confirmed_at ? toMs(row.confirmed_at) : null,
    ledgerSequence: row.ledger_sequence,
  };
}

/**
 * Create a PENDING settlement record before on-chain submission.
 */
async function createPending({ batchNonce, recipient, streamIds, expectedAmounts }, client) {
  const { rows } = await run(
    `INSERT INTO settlement_ledger
       (batch_nonce, recipient, stream_ids, expected_amounts, status)
     VALUES ($1, $2, $3, $4, 'PENDING')
     RETURNING ${COLUMNS}`,
    [batchNonce, recipient, streamIds, expectedAmounts],
    client
  );
  return mapSettlement(rows[0]);
}

/**
 * Mark a settlement as CONFIRMED after successful on-chain execution.
 */
async function markConfirmed(id, { ledgerSequence }, client) {
  const { rows } = await run(
    `UPDATE settlement_ledger
     SET status = 'CONFIRMED',
         confirmed_at = now(),
         ledger_sequence = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, ledgerSequence],
    client
  );
  return mapSettlement(rows[0]);
}

/**
 * Mark a settlement as FAILED after an error.
 * Increments retry count automatically.
 */
async function markFailed(id, errorMessage, client) {
  const { rows } = await run(
    `UPDATE settlement_ledger
     SET status = CASE WHEN retry_count >= 3 THEN 'DEAD_LETTERED' ELSE 'FAILED' END,
         error_message = $2,
         retry_count = retry_count + 1,
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, errorMessage],
    client
  );
  return mapSettlement(rows[0]);
}

/**
 * Move a failed settlement to DEAD_LETTERED after max retries.
 */
async function markDeadLettered(id, reason, client) {
  const { rows } = await run(
    `UPDATE settlement_ledger
     SET status = 'DEAD_LETTERED',
         error_message = COALESCE(error_message || '. Discarded: ' || $2, $2),
         updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, reason],
    client
  );
  return mapSettlement(rows[0]);
}

/**
 * Find all PENDING settlements for crash recovery on process restart.
 */
async function findPending(client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM settlement_ledger
     WHERE status = 'PENDING'
     ORDER BY created_at ASC`,
    [],
    client,
    "read"
  );
  return rows.map(mapSettlement);
}

/**
 * Find FAILED settlements that haven't exceeded max retry count.
 */
async function findFailed(maxRetries = 3, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM settlement_ledger
     WHERE status = 'FAILED' AND retry_count < $1
     ORDER BY created_at ASC`,
    [maxRetries],
    client,
    "read"
  );
  return rows.map(mapSettlement);
}

/**
 * Find DEAD_LETTERED settlements for operator inspection.
 */
async function findDeadLettered(pagination = {}, client) {
  const limit = pagination.limit || 100;
  const offset = pagination.offset || 0;

  const { rows } = await run(
    `SELECT ${COLUMNS} FROM settlement_ledger
     WHERE status = 'DEAD_LETTERED'
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
    client,
    "read"
  );
  return rows.map(mapSettlement);
}

/**
 * Find a settlement by ID.
 */
async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM settlement_ledger WHERE id = $1`,
    [id],
    client,
    "read"
  );
  return mapSettlement(rows[0]);
}

/**
 * Find a settlement by batch_nonce and recipient (for idempotency checks).
 */
async function findByNonce(batchNonce, recipient, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM settlement_ledger
     WHERE batch_nonce = $1 AND recipient = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [batchNonce, recipient],
    client,
    "read"
  );
  return mapSettlement(rows[0]);
}

/**
 * Get health metrics for the settlement system.
 */
async function getHealthMetrics(client) {
  const { rows } = await run(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'PENDING') as pending_count,
       COUNT(*) FILTER (WHERE status = 'FAILED') as failed_count,
       COUNT(*) FILTER (WHERE status = 'DEAD_LETTERED') as dead_lettered_count,
       COUNT(*) FILTER (WHERE status = 'CONFIRMED') as confirmed_count,
       MIN(created_at) FILTER (WHERE status = 'PENDING') as oldest_pending_at
     FROM settlement_ledger`,
    [],
    client,
    "read"
  );
  const row = rows[0];
  return {
    pendingCount: Number(row.pending_count),
    failedCount: Number(row.failed_count),
    deadLetteredCount: Number(row.dead_lettered_count),
    confirmedCount: Number(row.confirmed_count),
    oldestPendingAt: row.oldest_pending_at ? toMs(row.oldest_pending_at) : null,
  };
}

/**
 * Delete old CONFIRMED settlements (cleanup job).
 */
async function deleteOldConfirmed(olderThanMs, client) {
  const { rows } = await run(
    `DELETE FROM settlement_ledger
     WHERE status = 'CONFIRMED' AND created_at < NOW() - ($1 || ' milliseconds')::INTERVAL
     RETURNING id`,
    [olderThanMs],
    client
  );
  return rows.length;
}

module.exports = {
  createPending,
  markConfirmed,
  markFailed,
  markDeadLettered,
  findPending,
  findFailed,
  findDeadLettered,
  findById,
  findByNonce,
  getHealthMetrics,
  deleteOldConfirmed,
  mapSettlement,
};
