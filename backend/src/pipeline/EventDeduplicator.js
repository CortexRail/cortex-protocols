/**
 * Deduplicates events against the raw audit log by unique event key.
 */

const eventLogRepository = require("../repositories/eventLogRepository");

async function isDuplicate(event, client) {
  const { contractId, ledger, txHash, eventIndex = 0 } = event;
  const rows = await eventLogRepository.findByUniqueEvent(
    contractId,
    ledger,
    txHash || "",
    eventIndex,
    client
  );
  return rows.length > 0;
}

module.exports = { isDuplicate };
