/**
 * Database query router.
 *
 * Wraps repository calls and routes them to the appropriate pool based on
 * whether the operation is a read or write. Read queries go to the read
 * pool (replica), mutations go to the write pool (primary). If replica lag
 * exceeds the configured threshold, all reads fall back to the primary.
 */

const { queryRead, queryWrite, getClient, getReadClient, withTransaction } = require("./connection");
const { logger } = require("../utils/logger");

// Method-name patterns that are always writes (mutations)
const WRITE_PATTERNS = [
  /^create/i,
  /^insert/i,
  /^upsert/i,
  /^update/i,
  /^delete/i,
  /^remove/i,
  /^patch/i,
  /^set/i,
  /^expire/i,
  /^deactivate/i,
  /^activate/i,
  /^flag/i,
  /^consume/i,
  /^record/i,
  /^persist/i,
  /^append/i,
  /^mark/i,
];

// Method-name patterns that are always reads
const READ_PATTERNS = [
  /^find/i,
  /^get/i,
  /^search/i,
  /^list/i,
  /^count/i,
  /^exists/i,
  /^has/i,
  /^is/i,
  /^check/i,
];

/**
 * Determine whether a function name represents a write operation.
 */
function isWriteOperation(functionName) {
  if (WRITE_PATTERNS.some((p) => p.test(functionName))) return true;
  if (READ_PATTERNS.some((p) => p.test(functionName))) return false;
  // Default to write (primary) for unknown names — safety first.
  return true;
}

/**
 * Route a query to the appropriate pool.
 * If intent is explicitly provided it overrides the name-based heuristic.
 *
 * @param {string} functionName - Repository function name (for auto-detection)
 * @param {"read"|"write"} [intent] - Override auto-detection
 * @param {(client) => Promise<any>} fn - The actual query function
 * @returns {Promise<any>}
 */
async function route(functionName, intent, fn) {
  // Allow two-call forms: route("findSince", fn) — intent defaults to auto.
  if (typeof intent === "function") {
    fn = intent;
    intent = undefined;
  }

  const shouldWrite = intent === "write" || (intent !== "read" && isWriteOperation(functionName));

  if (shouldWrite) {
    const client = await getClient();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  // Read path — prefer the replica but fall back to the primary.
  try {
    const client = await getReadClient();
    try {
      return await fn(client);
    } finally {
      // The connection must go back to the pool on the success path too —
      // leaking it here keeps the pool from ever draining, so a checked-out
      // client would hang `closePool()` on shutdown.
      client.release();
    }
  } catch (err) {
    // If the read pool connection fails, fall back to the write pool.
    logger.warn("[db-router] read pool failed, falling back to primary:", err.message);
    const writeClient = await getClient();
    try {
      return await fn(writeClient);
    } finally {
      writeClient.release();
    }
  }
}

/**
 * Convenience: run a raw read query on the read pool.
 */
async function readQuery(text, params = []) {
  try {
    return await queryRead(text, params);
  } catch (err) {
    logger.warn("[db-router] read query failed, falling back to primary:", err.message);
    return queryWrite(text, params);
  }
}

/**
 * Convenience: run a raw write query on the write pool.
 */
async function writeQuery(text, params = []) {
  return queryWrite(text, params);
}

module.exports = {
  route,
  readQuery,
  writeQuery,
  isWriteOperation,
  withTransaction,
};
