/**
 * SettlementLedger — two-phase commit log for crash-safe settlement tracking.
 * 
 * Provides:
 * - PENDING record creation before on-chain submission
 * - CONFIRMED/FAILED state transitions after Horizon response
 * - Crash recovery by replaying PENDING rows on boot
 * 
 * This ensures that even if the process crashes mid-settlement, no stream
 * can be settled twice for the same usage batch.
 */

const settlementRepository = require("../repositories/settlementRepository");
const { withTransaction } = require("../db/connection");

const MAX_RETRIES = 3;

/**
 * Generate a unique batch nonce for idempotency.
 * Uses timestamp + random for uniqueness.
 */
function generateNonce() {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

/**
 * Begin a settlement batch - creates PENDING record before on-chain call.
 * 
 * @param {Object} params - Settlement parameters
 * @param {string} params.recipient - Recipient address
 * @param {number[]} params.streamIds - Array of stream IDs to settle
 * @param {number[]} params.expectedAmounts - Expected settlement amounts
 * @returns {Promise<Object>} The PENDING settlement record
 */
async function beginSettlement({ recipient, streamIds, expectedAmounts }) {
  const batchNonce = generateNonce();

  return withTransaction(async (client) => {
    // Check if this nonce was already used (idempotency check)
    const existing = await settlementRepository.findByNonce(batchNonce, recipient, client);
    if (existing && existing.status === 'CONFIRMED') {
      console.info(`[SettlementLedger] Nonce ${batchNonce} already confirmed, returning cached result`);
      return existing;
    }

    // Create PENDING record
    const settlement = await settlementRepository.createPending(
      { batchNonce, recipient, streamIds, expectedAmounts },
      client
    );

    console.info(`[SettlementLedger] Created PENDING settlement ${settlement.id} with nonce ${batchNonce}`);
    return settlement;
  });
}

/**
 * Mark a settlement as CONFIRMED after successful on-chain execution.
 * 
 * @param {number} id - Settlement ID
 * @param {Object} params - Confirmation parameters
 * @param {number} params.ledgerSequence - Stellar ledger sequence
 * @returns {Promise<Object>} Updated settlement record
 */
async function confirmSettlement(id, { ledgerSequence }) {
  return withTransaction(async (client) => {
    const settlement = await settlementRepository.markConfirmed(
      id,
      { ledgerSequence },
      client
    );
    console.info(`[SettlementLedger] Settlement ${id} CONFIRMED at ledger ${ledgerSequence}`);
    return settlement;
  });
}

/**
 * Mark a settlement as FAILED after an error.
 * Automatically moves to DEAD_LETTERED after MAX_RETRIES.
 * 
 * @param {number} id - Settlement ID
 * @param {Error} error - The error that occurred
 * @returns {Promise<Object>} Updated settlement record
 */
async function failSettlement(id, error) {
  return withTransaction(async (client) => {
    const errorMessage = error.message || String(error);
    const settlement = await settlementRepository.markFailed(id, errorMessage, client);

    if (settlement.retryCount >= MAX_RETRIES) {
      const deadLettered = await settlementRepository.markDeadLettered(
        id,
        `Max retries (${MAX_RETRIES}) exceeded`,
        client
      );
      console.error(`[SettlementLedger] Settlement ${id} moved to DEAD_LETTERED after ${MAX_RETRIES} failures`);
      return deadLettered;
    }

    console.warn(`[SettlementLedger] Settlement ${id} FAILED (attempt ${settlement.retryCount}/${MAX_RETRIES}): ${errorMessage}`);
    return settlement;
  });
}

/**
 * Replay PENDING settlements on process startup (crash recovery).
 * Returns the list of PENDING settlements that need to be retried.
 * 
 * @returns {Promise<Object[]>} Array of PENDING settlements
 */
async function recoverPendingSettlements() {
  const pending = await withTransaction(async (client) => {
    return settlementRepository.findPending(client);
  });

  if (pending.length > 0) {
    console.warn(`[SettlementLedger] Found ${pending.length} PENDING settlements from crash - will replay`);
  } else {
    console.info('[SettlementLedger] No PENDING settlements to recover');
  }

  return pending;
}

/**
 * Get FAILED settlements that can be retried.
 * 
 * @returns {Promise<Object[]>} Array of retryable FAILED settlements
 */
async function getRetryableSettlements() {
  return withTransaction(async (client) => {
    return settlementRepository.findFailed(MAX_RETRIES, client);
  });
}

/**
 * Get health metrics for monitoring.
 * 
 * @returns {Promise<Object>} Health metrics
 */
async function getHealthMetrics() {
  return withTransaction(async (client) => {
    return settlementRepository.getHealthMetrics(client);
  });
}

/**
 * Cleanup old CONFIRMED settlements to prevent table bloat.
 * 
 * @param {number} olderThanMs - Delete settlements older than this many milliseconds
 * @returns {Promise<number>} Number of deleted records
 */
async function cleanupOldSettlements(olderThanMs = 7 * 24 * 60 * 60 * 1000) { // 7 days default
  return withTransaction(async (client) => {
    const deleted = await settlementRepository.deleteOldConfirmed(olderThanMs, client);
    if (deleted > 0) {
      console.info(`[SettlementLedger] Cleaned up ${deleted} old CONFIRMED settlements`);
    }
    return deleted;
  });
}

module.exports = {
  beginSettlement,
  confirmSettlement,
  failSettlement,
  recoverPendingSettlements,
  getRetryableSettlements,
  getHealthMetrics,
  cleanupOldSettlements,
  generateNonce,
  MAX_RETRIES,
};
