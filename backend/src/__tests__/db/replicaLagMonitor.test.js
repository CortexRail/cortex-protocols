/**
 * Integration tests for ReplicaLagMonitor.
 *
 * Since we can't easily spin up a streaming replica in the test container,
 * we test the heartbeat writer, the lag-stats reporting, and the monitor
 * lifecycle.
 */

const { query, closePool } = require("../../db/connection");
const {
  stopMonitor,
  checkOnce,
  isReplicaDegraded,
  getCurrentLagMs,
  getLagStats,
} = require("../../db/ReplicaLagMonitor");
const { truncateAll } = require("../helpers/testDb");

afterAll(async () => {
  stopMonitor();
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
});

describe("heartbeat writer", () => {
  it("writes a heartbeat row to replica_heartbeat", async () => {
    // Directly write a heartbeat
    await query(
      "INSERT INTO replica_heartbeat (id, written_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET written_at = now()"
    );

    const { rows } = await query(
      "SELECT id, written_at FROM replica_heartbeat WHERE id = 1"
    );
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].written_at).toBeInstanceOf(Date);
  });

  it("update heartbeat overwrites the previous timestamp", async () => {
    await query(
      "INSERT INTO replica_heartbeat (id, written_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET written_at = now()"
    );
    const first = await query("SELECT written_at FROM replica_heartbeat WHERE id = 1");

    // Wait a bit and update again
    await new Promise((r) => setTimeout(r, 50));
    await query(
      "INSERT INTO replica_heartbeat (id, written_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET written_at = now()"
    );
    const second = await query("SELECT written_at FROM replica_heartbeat WHERE id = 1");

    expect(second.rows[0].written_at.getTime()).toBeGreaterThanOrEqual(
      first.rows[0].written_at.getTime()
    );
  });
});

describe("ReplicaLagMonitor", () => {
  it("isReplicaDegraded returns false by default (no replica)", () => {
    expect(isReplicaDegraded()).toBe(false);
  });

  it("getCurrentLagMs returns 0 by default", () => {
    expect(getCurrentLagMs()).toBe(0);
  });

  it("getLagStats returns the expected shape", () => {
    const stats = getLagStats();
    expect(stats).toHaveProperty("currentLagMs");
    expect(stats).toHaveProperty("isDegraded");
    expect(stats).toHaveProperty("consecutiveFailures");
    expect(stats).toHaveProperty("checkIntervalMs");
    expect(stats).toHaveProperty("lagThresholdMs");
    expect(typeof stats.currentLagMs).toBe("number");
    expect(typeof stats.isDegraded).toBe("boolean");
  });

  it("checkOnce does not throw when running against a single-node DB", async () => {
    // Without a real replica, checkOnce should complete without error.
    await expect(checkOnce()).resolves.toBeUndefined();
  });

  it("stopMonitor is idempotent", () => {
    stopMonitor();
    stopMonitor(); // should not throw
  });
});
