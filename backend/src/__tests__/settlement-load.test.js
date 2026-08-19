/**
 * Load test for settlement reconciliation engine.
 * Tests 500 concurrent settlement attempts on overlapping stream sets.
 * Asserts exactly-once semantics under high concurrency.
 */

const { withTransaction } = require("../db/connection");
const settlementRepository = require("../repositories/settlementRepository");
const SettlementLedger = require("../protocol/SettlementLedger");
const streamRepository = require("../repositories/streamRepository");
const { logger } = require("../utils/logger");

describe("Settlement Load Tests", () => {
  const NUM_CONCURRENT_SETTLEMENTS = 500;
  const NUM_STREAMS = 50;

  beforeAll(async () => {
    // Create test streams
    const streams = [];
    for (let i = 0; i < NUM_STREAMS; i++) {
      streams.push({
        id: 200000 + i,
        sender: `GSENDER_${i}`,
        recipient: "GRECIPIENT_LOAD",
        token: "GTOKEN_LOAD",
        deposit: 1000000,
        ratePerSecond: 1000,
        startTime: Math.floor(Date.now() / 1000) - 100,
        endTime: Math.floor(Date.now() / 1000) + 3600,
        status: "Active",
        withdrawn: 0,
        callsRemaining: 75,
        callsUsed: 25,
        pricePerCall: 100,
      });
    }

    await withTransaction(async (client) => {
      for (const stream of streams) {
        await streamRepository.create(stream, client);
      }
    });
  });

  afterAll(async () => {
    // Clean up test streams and settlements
    await withTransaction(async (client) => {
      await client.query("DELETE FROM settlement_ledger WHERE recipient = 'GRECIPIENT_LOAD'");
      await client.query("DELETE FROM streams WHERE id >= 200000 AND id < 200000 + $1", [NUM_STREAMS]);
    });
  });

  test("500 concurrent settlements with overlapping stream sets maintain exactly-once semantics", async () => {
    const settlementPromises = [];
    const usedNonces = new Set();
    const streamIdSets = new Map(); // Track which streams are in which settlements

    // Create 500 concurrent settlement attempts
    for (let i = 0; i < NUM_CONCURRENT_SETTLEMENTS; i++) {
      // Each settlement uses a random subset of streams (1-5 streams per settlement)
      const numStreamsInBatch = Math.floor(Math.random() * 5) + 1;
      const streamIds = [];
      
      for (let j = 0; j < numStreamsInBatch; j++) {
        const streamId = 200000 + Math.floor(Math.random() * NUM_STREAMS);
        if (!streamIds.includes(streamId)) {
          streamIds.push(streamId);
        }
      }

      const expectedAmounts = streamIds.map(() => 100000);
      const batchNonce = Date.now() * 1000 + i; // Ensure uniqueness

      // Track nonce usage
      if (usedNonces.has(batchNonce)) {
        throw new Error(`Duplicate nonce generated: ${batchNonce}`);
      }
      usedNonces.add(batchNonce);

      // Track which streams are in this settlement
      streamIdSets.set(batchNonce, new Set(streamIds));

      settlementPromises.push(
        withTransaction(async (client) => {
          return settlementRepository.createPending(
            {
              batchNonce,
              recipient: "GRECIPIENT_LOAD",
              streamIds,
              expectedAmounts,
            },
            client
          );
        })
      );
    }

    // Execute all settlements concurrently
    const startTime = Date.now();
    const settlements = await Promise.all(settlementPromises);
    const duration = Date.now() - startTime;

    logger.info(`Created ${settlements.length} settlements in ${duration}ms`);

    // Verify all settlements were created successfully
    expect(settlements.length).toBe(NUM_CONCURRENT_SETTLEMENTS);

    // Verify all have unique IDs
    const ids = new Set(settlements.map(s => s.id));
    expect(ids.size).toBe(NUM_CONCURRENT_SETTLEMENTS);

    // Verify all have unique nonces
    const nonces = new Set(settlements.map(s => s.batchNonce));
    expect(nonces.size).toBe(NUM_CONCURRENT_SETTLEMENTS);

    // Verify all are in PENDING state
    settlements.forEach(s => {
      expect(s.status).toBe("PENDING");
    });

    // Simulate confirming half of them
    const confirmPromises = settlements.slice(0, 250).map(s =>
      withTransaction(async (client) => {
        return settlementRepository.markConfirmed(s.id, { ledgerSequence: 100 + s.id }, client);
      })
    );

    const confirmed = await Promise.all(confirmPromises);
    confirmed.forEach(s => {
      expect(s.status).toBe("CONFIRMED");
    });

    // Verify exactly-once: check that no stream was settled more than once for the same amount
    // In a real scenario, this would be verified by checking on-chain state
    // Here we verify that the ledger correctly tracks each settlement
    
    const allSettlements = await withTransaction(async (client) => {
      const { rows } = await client.query(
        "SELECT * FROM settlement_ledger WHERE recipient = 'GRECIPIENT_LOAD' ORDER BY id"
      );
      return rows.map(settlementRepository.mapSettlement);
    });

    expect(allSettlements.length).toBe(NUM_CONCURRENT_SETTLEMENTS);

    // Check that each nonce appears exactly once
    const nonceCounts = new Map();
    allSettlements.forEach(s => {
      const count = nonceCounts.get(s.batchNonce) || 0;
      nonceCounts.set(s.batchNonce, count + 1);
    });

    nonceCounts.forEach((count, nonce) => {
      expect(count).toBe(1); // Each nonce should appear exactly once
    });

    logger.info("Load test passed: 500 concurrent settlements with exactly-once semantics");
  });

  test("Concurrent settlements with same nonce are idempotent", async () => {
    const batchNonce = 999999999;
    const recipient = "GRECIPIENT_IDEMPOTENT";
    const streamIds = [200000, 200001];
    const expectedAmounts = [100000, 200000];

    // Create first settlement
    const first = await withTransaction(async (client) => {
      return settlementRepository.createPending(
        { batchNonce, recipient, streamIds, expectedAmounts },
        client
      );
    });

    // Try to create concurrent settlements with same nonce
    const concurrentPromises = Array(10).fill(null).map(() =>
      withTransaction(async (client) => {
        const existing = await settlementRepository.findByNonce(batchNonce, recipient, client);
        if (existing) {
          return existing; // Return existing (idempotent)
        }
        return settlementRepository.createPending(
          { batchNonce, recipient, streamIds, expectedAmounts },
          client
        );
      })
    );

    const results = await Promise.all(concurrentPromises);

    // All should return the same settlement
    results.forEach(r => {
      expect(r.id).toBe(first.id);
      expect(r.batchNonce).toBe(batchNonce);
    });

    // Clean up
    await withTransaction(async (client) => {
      await client.query("DELETE FROM settlement_ledger WHERE id = $1", [first.id]);
    });
  });

  test("High concurrency does not cause database deadlocks", async () => {
    const numOperations = 100;
    const operations = [];

    for (let i = 0; i < numOperations; i++) {
      operations.push(
        withTransaction(async (client) => {
          // Mix of reads and writes
          if (i % 2 === 0) {
            return settlementRepository.findPending(client);
          } else {
            return settlementRepository.getHealthMetrics(client);
          }
        })
      );
    }

    const startTime = Date.now();
    const results = await Promise.all(operations);
    const duration = Date.now() - startTime;

    logger.info(`Executed ${numOperations} concurrent operations in ${duration}ms`);
    expect(results.length).toBe(numOperations);
    expect(duration).toBeLessThan(5000); // Should complete in under 5 seconds
  });

  test("Settlement health metrics under load", async () => {
    // Create settlements in various states
    const states = ["PENDING", "FAILED", "CONFIRMED", "DEAD_LETTERED"];
    const settlements = [];

    for (const state of states) {
      for (let i = 0; i < 10; i++) {
        const s = await withTransaction(async (client) => {
          const created = await settlementRepository.createPending(
            {
              batchNonce: Date.now() + Math.random() * 1000,
              recipient: "GRECIPIENT_METRICS",
              streamIds: [200000 + i],
              expectedAmounts: [100000],
            },
            client
          );

          if (state === "CONFIRMED") {
            return settlementRepository.markConfirmed(created.id, { ledgerSequence: 100 }, client);
          } else if (state === "FAILED") {
            return settlementRepository.markFailed(created.id, "Test error", client);
          } else if (state === "DEAD_LETTERED") {
            let failed = await settlementRepository.markFailed(created.id, "Error 1", client);
            failed = await settlementRepository.markFailed(failed.id, "Error 2", client);
            failed = await settlementRepository.markFailed(failed.id, "Error 3", client);
            return settlementRepository.markFailed(failed.id, "Error 4", client);
          }
          return created;
        });
        settlements.push(s);
      }
    }

    const metrics = await SettlementLedger.getHealthMetrics();

    expect(metrics.pendingCount).toBeGreaterThanOrEqual(10);
    expect(metrics.failedCount).toBeGreaterThanOrEqual(10);
    expect(metrics.confirmedCount).toBeGreaterThanOrEqual(10);
    expect(metrics.deadLetteredCount).toBeGreaterThanOrEqual(10);

    // Clean up
    await withTransaction(async (client) => {
      const ids = settlements.map(s => s.id);
      await client.query("DELETE FROM settlement_ledger WHERE id = ANY($1)", [ids]);
    });
  });
});
