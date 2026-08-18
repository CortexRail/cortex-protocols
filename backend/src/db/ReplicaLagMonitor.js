/**
 * Replica lag monitor.
 *
 * Periodically checks replication lag using two strategies (in order):
 *   1. pg_stat_replication (requires superuser or monitoring role)
 *   2. Heartbeat table — the primary writes a timestamp every few seconds;
 *      the replica reads it and computes the difference.
 *
 * When lag exceeds `REPLICA_LAG_THRESHOLD_MS` all reads are transparently
 * routed back to the primary until lag recovers.
 */

const { queryRead, queryWrite } = require("./connection");

const DEFAULT_CHECK_INTERVAL_MS = 10_000; // 10 seconds
const DEFAULT_LAG_THRESHOLD_MS = 30_000; // 30 seconds

let checkTimer = null;
let currentLagMs = 0;
let isDegraded = false;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Start the heartbeat writer on the primary. Should be called once at boot.
 * Writes the current timestamp into replica_heartbeat every `intervalMs`.
 */
function startHeartbeatWriter(intervalMs = 5_000) {
  const write = async () => {
    try {
      await queryWrite(
        "INSERT INTO replica_heartbeat (id, written_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET written_at = now()"
      );
    } catch (err) {
      console.warn("[lag-monitor] heartbeat write failed:", err.message);
    }
  };

  write(); // immediate first beat
  setInterval(write, intervalMs);
}

/**
 * Attempt to read replication lag via pg_stat_replication.
 * Returns lag in milliseconds or null if unavailable.
 */
async function checkPgStatReplication() {
  try {
    const { rows } = await queryRead(
      `SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) * 1000 AS lag_ms
       WHERE pg_last_xact_replay_timestamp() IS NOT NULL`
    );
    if (rows.length && rows[0].lag_ms !== null) {
      return Number(rows[0].lag_ms);
    }
  } catch {
    // pg_stat_replication not available on this replica (e.g. not superuser).
  }
  return null;
}

/**
 * Attempt to read replication lag via the heartbeat table.
 * Returns lag in milliseconds or null if the heartbeat row is missing.
 */
async function checkHeartbeatLag() {
  try {
    const { rows } = await queryRead(
      "SELECT EXTRACT(EPOCH FROM (now() - written_at)) * 1000 AS lag_ms FROM replica_heartbeat WHERE id = 1"
    );
    if (rows.length && rows[0].lag_ms !== null) {
      return Number(rows[0].lag_ms);
    }
  } catch {
    // heartbeat table not yet replicated
  }
  return null;
}

/**
 * Single lag check. Tries pg_stat_replication first, then heartbeat.
 */
async function measureLag() {
  let lag = await checkPgStatReplication();
  if (lag === null) lag = await checkHeartbeatLag();
  return lag ?? 0;
}

/**
 * Run one check cycle. Called on an interval.
 */
async function checkOnce() {
  try {
    const lag = await measureLag();
    currentLagMs = lag;

    const threshold =
      Number(process.env.REPLICA_LAG_THRESHOLD_MS) || DEFAULT_LAG_THRESHOLD_MS;

    if (lag > threshold) {
      if (!isDegraded) {
        console.warn(
          `[lag-monitor] replica lag ${Math.round(lag)}ms exceeds threshold ${threshold}ms — routing reads to primary`
        );
      }
      isDegraded = true;
      consecutiveFailures = 0;
    } else {
      if (isDegraded) {
        console.info(
          `[lag-monitor] replica lag recovered to ${Math.round(lag)}ms — resuming reads on replica`
        );
      }
      isDegraded = false;
      consecutiveFailures = 0;
    }
  } catch (err) {
    consecutiveFailures++;
    console.warn(
      `[lag-monitor] check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`,
      err.message
    );
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !isDegraded) {
      console.warn(
        "[lag-monitor] too many consecutive failures — routing reads to primary"
      );
      isDegraded = true;
    }
  }
}

/**
 * Start the periodic lag checker.
 */
function startMonitor() {
  if (checkTimer) return;
  const interval = Number(process.env.REPLICA_LAG_CHECK_INTERVAL_MS) || DEFAULT_CHECK_INTERVAL_MS;
  checkTimer = setInterval(checkOnce, interval);
  // Run an immediate first check (non-blocking).
  checkOnce();
}

/**
 * Stop the periodic lag checker.
 */
function stopMonitor() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/**
 * Whether the monitor considers the replica degraded.
 */
function isReplicaDegraded() {
  return isDegraded;
}

/**
 * Current measured lag in milliseconds.
 */
function getCurrentLagMs() {
  return currentLagMs;
}

/**
 * Snapshot of monitor state for the /internal/db-stats endpoint.
 */
function getLagStats() {
  return {
    currentLagMs: Math.round(currentLagMs),
    isDegraded,
    consecutiveFailures,
    checkIntervalMs: Number(process.env.REPLICA_LAG_CHECK_INTERVAL_MS) || DEFAULT_CHECK_INTERVAL_MS,
    lagThresholdMs: Number(process.env.REPLICA_LAG_THRESHOLD_MS) || DEFAULT_LAG_THRESHOLD_MS,
  };
}

module.exports = {
  startHeartbeatWriter,
  startMonitor,
  stopMonitor,
  checkOnce,
  isReplicaDegraded,
  getCurrentLagMs,
  getLagStats,
};
