/**
 * Integration tests for DbRouter — read/write intent routing.
 */

const { query, closePool } = require("../../db/connection");
const { route, readQuery, writeQuery, isWriteOperation } = require("../../db/DbRouter");
const { truncateAll } = require("../helpers/testDb");

afterAll(async () => {
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
});

describe("isWriteOperation", () => {
  it("classifies create/insert/update/delete as writes", () => {
    expect(isWriteOperation("create")).toBe(true);
    expect(isWriteOperation("insert")).toBe(true);
    expect(isWriteOperation("update")).toBe(true);
    expect(isWriteOperation("updateStatus")).toBe(true);
    expect(isWriteOperation("delete")).toBe(true);
    expect(isWriteOperation("remove")).toBe(true);
    expect(isWriteOperation("upsert")).toBe(true);
    expect(isWriteOperation("expire")).toBe(true);
    expect(isWriteOperation("deactivate")).toBe(true);
    expect(isWriteOperation("append")).toBe(true);
    expect(isWriteOperation("persistLastProcessedLedger")).toBe(true);
    expect(isWriteOperation("consumeCall")).toBe(true);
    expect(isWriteOperation("recordWithdrawal")).toBe(true);
  });

  it("classifies find/get/search/list/count as reads", () => {
    expect(isWriteOperation("find")).toBe(false);
    expect(isWriteOperation("findById")).toBe(false);
    expect(isWriteOperation("findAll")).toBe(false);
    expect(isWriteOperation("findSince")).toBe(false);
    expect(isWriteOperation("getPool")).toBe(false);
    expect(isWriteOperation("getLastLedger")).toBe(false);
    expect(isWriteOperation("search")).toBe(false);
    expect(isWriteOperation("list")).toBe(false);
    expect(isWriteOperation("count")).toBe(false);
    expect(isWriteOperation("countForAsset")).toBe(false);
  });

  it("defaults to write for unknown names", () => {
    expect(isWriteOperation("doSomething")).toBe(true);
    expect(isWriteOperation("")).toBe(true);
  });
});

describe("route()", () => {
  it("routes reads to the read pool (or primary fallback)", async () => {
    const result = await route("findSince", async (client) => {
      const { rows } = await client.query("SELECT 1 AS val");
      return rows[0].val;
    });
    expect(result).toBe(1);
  });

  it("routes writes to the write pool", async () => {
    const result = await route("append", async (client) => {
      const { rows } = await client.query("SELECT 2 AS val");
      return rows[0].val;
    });
    expect(result).toBe(2);
  });

  it("respects explicit intent override", async () => {
    // Force a "read" even though the name pattern says write
    const result = await route("append", "read", async (client) => {
      const { rows } = await client.query("SELECT 3 AS val");
      return rows[0].val;
    });
    expect(result).toBe(3);
  });
});

describe("readQuery / writeQuery", () => {
  it("writeQuery inserts data on the write pool", async () => {
    await writeQuery(
      `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash, event_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [100, "CCONTRACT", "{EVT}", '{}', "tx001", 0]
    );
    const { rows } = await query("SELECT count(*)::int AS cnt FROM events_log");
    expect(rows[0].cnt).toBe(1);
  });

  it("readQuery reads data (from primary when no replica)", async () => {
    await writeQuery(
      `INSERT INTO events_log (ledger, contract_id, topic, payload, tx_hash, event_index)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [200, "CCONTRACT", "{EVT2}", '{}', "tx002", 0]
    );
    const { rows } = await readQuery("SELECT ledger FROM events_log WHERE ledger = $1", [200]);
    expect(rows[0].ledger).toBe(200);
  });
});
