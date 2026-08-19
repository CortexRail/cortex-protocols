/**
 * PostgreSQL connection management.
 *
 * Manages two pools:
 *   - writePool: primary database for all mutations
 *   - readPool:  read replica (falls back to primary if READ_REPLICA_URL is unset)
 *
 * All database access goes through `query`, `getClient`, or `withTransaction`
 * — repositories must never construct their own pools or clients.
 *
 * For explicit read/write intent, use `queryRead`, `queryWrite`, etc.
 */

const { Pool, types } = require("pg");
const { logger } = require("../utils/logger");

// BIGINT (int8) comes back from pg as a string by default. Our on-chain IDs,
// prices, and counters all fit comfortably inside Number.MAX_SAFE_INTEGER
// (stroop amounts max out around 9.2e18 on-chain but indexed values are far
// smaller), and the previous in-memory layer exposed plain numbers, so we
// parse to Number to keep the public API shape unchanged.
types.setTypeParser(types.builtins.INT8, (value) =>
  value === null ? null : Number(value)
);

const DEFAULT_POOL_CONFIG = {
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 2_000,
};

let writePool = null;
let readPool = null;

/**
 * Build pool configuration from environment.
 * DATABASE_URL (or discrete PG* vars) targets the primary / write pool.
 */
function buildPoolConfig(overrideUrl) {
  const config = {
    max: Number(process.env.PG_POOL_MAX) || DEFAULT_POOL_CONFIG.max,
    idleTimeoutMillis:
      Number(process.env.PG_IDLE_TIMEOUT_MS) ||
      DEFAULT_POOL_CONFIG.idleTimeoutMillis,
    connectionTimeoutMillis:
      Number(process.env.PG_CONNECTION_TIMEOUT_MS) ||
      DEFAULT_POOL_CONFIG.connectionTimeoutMillis,
  };

  if (overrideUrl) {
    config.connectionString = overrideUrl;
  } else if (process.env.DATABASE_URL) {
    config.connectionString = process.env.DATABASE_URL;
  } else {
    config.host = process.env.PGHOST || "localhost";
    config.port = Number(process.env.PGPORT) || 5432;
    config.database = process.env.PGDATABASE || "cortex_protocol";
    config.user = process.env.PGUSER || "postgres";
    config.password = process.env.PGPASSWORD || "postgres";
  }

  if (process.env.PGSSLMODE === "require") {
    config.ssl = { rejectUnauthorized: false };
  }

  return config;
}

/**
 * Lazily create (or return) the write pool (primary).
 */
function getWritePool() {
  if (!writePool) {
    writePool = new Pool(buildPoolConfig());
    writePool.on("error", (err) => {
      logger.error("[db] write-pool idle client error:", err.message);
    });
  }
  return writePool;
}

/**
 * Lazily create (or return) the read pool.
 * Falls back to the primary when READ_REPLICA_URL is not configured.
 */
function getReadPool() {
  if (!readPool) {
    const replicaUrl = process.env.READ_REPLICA_URL;
    if (replicaUrl) {
      readPool = new Pool(buildPoolConfig(replicaUrl));
      readPool.on("error", (err) => {
        logger.error("[db] read-pool idle client error:", err.message);
      });
    }
  }
  // If no replica is configured, getReadPool returns the write pool so every
  // query lands on the primary — safe and zero-config for local dev.
  return readPool || getWritePool();
}

/**
 * Backwards-compatible alias used by the rest of the codebase.
 */
function getPool() {
  return getWritePool();
}

/**
 * Run a single parameterized query on the write pool.
 */
async function query(text, params = []) {
  return getWritePool().query(text, params);
}

/**
 * Run a single parameterized query on the read pool.
 */
async function queryRead(text, params = []) {
  return getReadPool().query(text, params);
}

/**
 * Run a single parameterized query on the write pool (alias for clarity).
 */
async function queryWrite(text, params = []) {
  return getWritePool().query(text, params);
}

/**
 * Check out a dedicated client from the write pool. Caller MUST release() it.
 */
async function getClient() {
  return getWritePool().connect();
}

/**
 * Check out a dedicated client from the read pool. Caller MUST release() it.
 */
async function getReadClient() {
  return getReadPool().connect();
}

/**
 * Run `fn(client)` inside a transaction. Commits on success, rolls back on
 * any thrown error, and always releases the client back to the pool.
 *
 * @template T
 * @param {(client: import("pg").PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error("[db] rollback failed:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Health probe — round-trips a trivial query and reports latency.
 */
async function healthCheck() {
  const startedAt = process.hrtime.bigint();
  try {
    await query("SELECT 1");
    const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { healthy: true, latencyMs: Math.round(latencyMs * 100) / 100 };
  } catch (err) {
    return { healthy: false, error: err.message };
  }
}

/**
 * Snapshot of pool utilization for the internal metrics endpoint.
 */
function getPoolStats() {
  const wp = getWritePool();
  const rp = readPool ? readPool : null;
  return {
    write: {
      total: wp.totalCount,
      idle: wp.idleCount,
      waiting: wp.waitingCount,
      max: wp.options.max,
    },
    read: rp
      ? {
          total: rp.totalCount,
          idle: rp.idleCount,
          waiting: rp.waitingCount,
          max: rp.options.max,
        }
      : { note: "using write pool (no replica configured)" },
  };
}

/**
 * Graceful shutdown — drains and closes every connection.
 * Safe to call multiple times.
 */
async function closePool() {
  if (writePool) {
    const closing = writePool;
    writePool = null;
    await closing.end();
  }
  if (readPool) {
    const closing = readPool;
    readPool = null;
    await closing.end();
  }
}

module.exports = {
  getPool,
  getWritePool,
  getReadPool,
  query,
  queryRead,
  queryWrite,
  getClient,
  getReadClient,
  withTransaction,
  healthCheck,
  getPoolStats,
  closePool,
};
