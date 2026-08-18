/**
 * Stream indexing service — tracks on-chain payment streams off-chain
 * for fast querying without needing to hit the RPC on every request.
 *
 * Same public interface as the old in-memory version, now backed by
 * PostgreSQL through streamRepository.
 */

const streamRepository = require("../repositories/streamRepository");

const STREAM_STATUSES = ["Active", "Paused", "Completed", "Cancelled"];

/**
 * Index a stream after on-chain creation (upsert by id).
 */
async function indexStream(streamData) {
  return streamRepository.create({
    ...streamData,
    status: streamData.status || "Active",
    withdrawn: streamData.withdrawn || 0,
  });
}

/**
 * Transition a stream's lifecycle status.
 */
async function updateStreamStatus(id, status) {
  return streamRepository.updateStatus(id, status);
}

/**
 * Get a single stream by ID.
 */
async function getStream(id) {
  return streamRepository.findById(id);
}

/**
 * List streams, filterable by sender, recipient, and status.
 */
async function listStreams({ sender, recipient, status, page = 1, limit = 20 } = {}) {
  return streamRepository.findAll({ sender, recipient, status }, { page, limit });
}

/**
 * Record a withdrawal observed on-chain. Refuses to exceed the deposit.
 */
async function recordWithdrawal(id, amount) {
  return streamRepository.recordWithdrawal(id, amount);
}

module.exports = {
  indexStream,
  updateStreamStatus,
  getStream,
  listStreams,
  recordWithdrawal,
  STREAM_STATUSES,
};
