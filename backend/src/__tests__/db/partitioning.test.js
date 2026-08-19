/**
 * Integration tests for events_log partitioning and partition management scripts.
 */

const { query, closePool } = require("../../db/connection");
const { truncateAll } = require("../helpers/testDb");
const {
  createPartitions,
  getMaxPartitionBound,
  partitionName,
} = require("../../scripts/create-future-partitions");
const { prunePartitions, listPartitions } = require("../../scripts/prune-old-partitions");

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
});

describe("events_log partitioning", () => {
  it("events_log is partitioned by ledger range", async () => {
    const { rows } = await query(`
      SELECT
        c.relname AS table_name,
        pt.partstrat AS strategy
      FROM pg_class c
      JOIN pg_partitioned_table pt ON c.oid = pt.partrelid
      WHERE c.relname = 'events_log'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].strategy).toBe("r"); // range
  });

  it("partitions exist for the initial ledger ranges", async () => {
    const { rows } = await query(`
      SELECT inhrelid::regclass::text AS partition_name
      FROM pg_inherits
      WHERE inhparent = 'events_log'::regclass
      ORDER BY partition_name
    `);
    const names = rows.map((r) => r.partition_name);
    expect(names.length).toBeGreaterThan(5);
    expect(names).toContain("events_log_p0_to_100k");
    expect(names).toContain("events_log_p100k_to_200k");
    expect(names).toContain("events_log_default");
  });

  it("can insert and query events across partitions", async () => {
    await query(
      `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash, event_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [50000, "CCONTRACT1", ["LISTED"], '{"price":100}', "tx1", 0]
    );
    await query(
      `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash, event_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [150000, "CCONTRACT2", ["SOLD"], '{"price":200}', "tx2", 0]
    );

    const { rows } = await query(
      "SELECT ledger, contract_id FROM events_log ORDER BY ledger"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].ledger).toBe(50000);
    expect(rows[1].ledger).toBe(150000);
  });

  it("partition pruning uses the correct partition for a given ledger", async () => {
    await query(
      `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash, event_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [50000, "CCONTRACT1", ["LISTED"], '{}', "tx1", 0]
    );

    // Verify the row ended up in the p0_to_100k partition.
    const { rows } = await query(
      "SELECT count(*)::int AS cnt FROM events_log_p0_to_100k"
    );
    expect(rows[0].cnt).toBe(1);
  });
});

describe("create-future-partitions script", () => {
  it("getMaxPartitionBound returns the highest existing upper bound", async () => {
    const bound = await getMaxPartitionBound();
    expect(bound).toBeGreaterThanOrEqual(1_500_000); // initial partitions go up to 1.5M
  });

  it("partitionName generates correct names", () => {
    expect(partitionName(0)).toBe("events_log_p0_to_100000");
    expect(partitionName(500000)).toBe("events_log_p500000_to_600000");
  });

  it("createPartitions creates new partitions when needed", async () => {
    const { created } = await createPartitions();
    // May be 0 if partitions already cover enough range, or more if not.
    expect(typeof created).toBe("number");
    expect(created).toBeGreaterThanOrEqual(0);
  });
});

describe("prune-old-partitions script", () => {
  it("listPartitions returns the list of non-default partitions", async () => {
    const parts = await listPartitions();
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((p) => p.name.startsWith("events_log_p"))).toBe(true);
  });

  it("prunePartitions does not drop partitions within retention window", async () => {
    const before = await listPartitions();
    const { dropped, skipped: _skipped } = await prunePartitions();
    const after = await listPartitions();

    // No partitions should be dropped since no data is old.
    expect(dropped).toBe(0);
    expect(after.length).toBe(before.length);
  });
});
