/**
 * PostgreSQL connection management.
 *
 * Single shared pg.Pool for the whole process. All database access goes
 * through `query`, `getClient`, or `withTransaction` — repositories must
 * never construct their own pools or clients.
 */

const { Pool, types } = require("pg");

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

let pool = null;

/**
 * Build the pool configuration from the environment.
 * DATABASE_URL takes precedence; discrete PG* vars are the fallback.
 */
function buildPoolConfig() {
  const config = {
    max: Number(process.env.PG_POOL_MAX) || DEFAULT_POOL_CONFIG.max,
    idleTimeoutMillis:
      Number(process.env.PG_IDLE_TIMEOUT_MS) ||
      DEFAULT_POOL_CONFIG.idleTimeoutMillis,
    connectionTimeoutMillis:
      Number(process.env.PG_CONNECTION_TIMEOUT_MS) ||
      DEFAULT_POOL_CONFIG.connectionTimeoutMillis,
  };

  if (process.env.DATABASE_URL) {
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
 * Lazily create (or return) the shared pool.
 */
function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());

    // Errors on idle clients (e.g. server restart) must not crash the process.
    pool.on("error", (err) => {
      console.error("[db] idle client error:", err.message);
    });
  }
  return pool;
}

/**
 * Run a single parameterized query on the pool.
 */
async function query(text, params = []) {
  return getPool().query(text, params);
}

/**
 * Check out a dedicated client. Caller MUST release() it.
 */
async function getClient() {
  return getPool().connect();
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
      console.error("[db] rollback failed:", rollbackErr.message);
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
  const p = getPool();
  return {
    total: p.totalCount,
    idle: p.idleCount,
    waiting: p.waitingCount,
    max: p.options.max,
  };
}

/**
 * Graceful shutdown — drains and closes every connection.
 * Safe to call multiple times.
 */
async function closePool() {
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}

module.exports = {
  getPool,
  query,
  getClient,
  withTransaction,
  healthCheck,
  getPoolStats,
  closePool,
};
