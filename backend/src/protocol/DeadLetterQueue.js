/**
 * DeadLetterQueue — manages settlements that failed after max retries.
 * 
 * Provides:
 * - Storage for dead-lettered settlements with full context
 * - retry(id) - manually retry a dead-lettered settlement
 * - discard(id, reason) - permanently discard a dead-lettered settlement
 * - list() - view all dead-lettered settlements for operator inspection
 * 
 * Dead-lettered settlements are never silently dropped - every one is
 * visible via the health endpoint and requires explicit operator action.
 */

const settlementRepository = require("../repositories/settlementRepository");
const { run } = require("../repositories/repoUtils");
const { withTransaction } = require("../db/connection");

/**
 * Get all dead-lettered settlements for operator inspection.
 * 
 * @param {Object} pagination - Pagination options
 * @param {number} pagination.limit - Max records to return
 * @param {number} pagination.offset - Offset for pagination
 * @returns {Promise<Object[]>} Array of dead-lettered settlements
 */
async function list(pagination = {}) {
  return withTransaction(async (client) => {
    return settlementRepository.findDeadLettered(pagination, client);
  });
}

/**
 * Retry a dead-lettered settlement.
 * Resets retry count and moves back to FAILED status for reprocessing.
 * 
 * @param {number} id - Settlement ID to retry
 * @returns {Promise<Object>} Updated settlement record
 */
async function retry(id) {
  return withTransaction(async (client) => {
    const settlement = await settlementRepository.findById(id, client);
    
    if (!settlement) {
      throw new Error(`Settlement ${id} not found`);
    }

    if (settlement.status !== 'DEAD_LETTERED') {
      throw new Error(`Settlement ${id} is not dead-lettered (status: ${settlement.status})`);
    }

    // Reset to FAILED with retry_count = 0 for reprocessing
    const { rows } = await run(
      `UPDATE settlement_ledger
       SET status = 'FAILED',
           retry_count = 0,
           error_message = 'Retrying from dead letter queue',
           updated_at = now()
       WHERE id = $1
       RETURNING id, batch_nonce, recipient, stream_ids, expected_amounts, status,
              error_message, retry_count, created_at, updated_at, confirmed_at, ledger_sequence`,
      [id],
      client
    );

    console.info(`[DeadLetterQueue] Settlement ${id} moved from DEAD_LETTERED to FAILED for retry`);
    return settlementRepository.mapSettlement(rows[0]);
  });
}

/**
 * Permanently discard a dead-lettered settlement.
 * Requires a reason for audit trail.
 * 
 * @param {number} id - Settlement ID to discard
 * @param {string} reason - Reason for discarding
 * @returns {Promise<Object>} Updated settlement record
 */
async function discard(id, reason) {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Reason is required for discarding a settlement');
  }

  return withTransaction(async (client) => {
    const settlement = await settlementRepository.findById(id, client);
    
    if (!settlement) {
      throw new Error(`Settlement ${id} not found`);
    }

    if (settlement.status !== 'DEAD_LETTERED') {
      throw new Error(`Settlement ${id} is not dead-lettered (status: ${settlement.status})`);
    }

    // Update with discard reason - keep as DEAD_LETTERED but mark as discarded
    const { rows } = await run(
      `UPDATE settlement_ledger
       SET error_message = 'DISCARDED: ' || $2 || '. Original: ' || COALESCE(error_message, ''),
           updated_at = now()
       WHERE id = $1
       RETURNING id, batch_nonce, recipient, stream_ids, expected_amounts, status,
              error_message, retry_count, created_at, updated_at, confirmed_at, ledger_sequence`,
      [id, reason],
      client
    );

    console.info(`[DeadLetterQueue] Settlement ${id} discarded with reason: ${reason}`);
    return settlementRepository.mapSettlement(rows[0]);
  });
}

/**
 * Get detailed information about a specific dead-lettered settlement.
 * 
 * @param {number} id - Settlement ID
 * @returns {Promise<Object|null>} Settlement details or null if not found
 */
async function get(id) {
  return withTransaction(async (client) => {
    const settlement = await settlementRepository.findById(id, client);
    
    if (settlement && settlement.status === 'DEAD_LETTERED') {
      return settlement;
    }
    
    return null;
  });
}

/**
 * Get statistics about the dead letter queue.
 * 
 * @returns {Promise<Object>} Dead letter queue statistics
 */
async function getStats() {
  return withTransaction(async (client) => {
    const { rows } = await run(
      `SELECT
         COUNT(*) as total_count,
         COUNT(*) FILTER (WHERE error_message NOT LIKE 'DISCARDED:%') as active_count,
         MIN(created_at) as oldest_at,
         MAX(created_at) as newest_at
       FROM settlement_ledger
       WHERE status = 'DEAD_LETTERED'`,
      [],
      client,
      "read"
    );

    const row = rows[0];
    return {
      totalCount: Number(row.total_count),
      activeCount: Number(row.active_count),
      discardedCount: Number(row.total_count) - Number(row.active_count),
      oldestAt: row.oldest_at ? settlementRepository.toMs(row.oldest_at) : null,
      newestAt: row.newest_at ? settlementRepository.toMs(row.newest_at) : null,
    };
  });
}

/**
 * Bulk retry multiple dead-lettered settlements.
 * 
 * @param {number[]} ids - Array of settlement IDs to retry
 * @returns {Promise<Object>} Retry results
 */
async function bulkRetry(ids) {
  const results = {
    successful: [],
    failed: [],
  };

  for (const id of ids) {
    try {
      await retry(id);
      results.successful.push(id);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  console.info(`[DeadLetterQueue] Bulk retry: ${results.successful.length} successful, ${results.failed.length} failed`);
  return results;
}

/**
 * Bulk discard multiple dead-lettered settlements.
 * 
 * @param {number[]} ids - Array of settlement IDs to discard
 * @param {string} reason - Reason for discarding
 * @returns {Promise<Object>} Discard results
 */
async function bulkDiscard(ids, reason) {
  const results = {
    successful: [],
    failed: [],
  };

  for (const id of ids) {
    try {
      await discard(id, reason);
      results.successful.push(id);
    } catch (err) {
      results.failed.push({ id, error: err.message });
    }
  }

  console.info(`[DeadLetterQueue] Bulk discard: ${results.successful.length} successful, ${results.failed.length} failed`);
  return results;
}

module.exports = {
  list,
  retry,
  discard,
  get,
  getStats,
  bulkRetry,
  bulkDiscard,
};
