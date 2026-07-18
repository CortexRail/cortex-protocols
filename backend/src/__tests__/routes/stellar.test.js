/**
 * Tests for GET /api/v1/stellar/account/:publicKey/transactions
 *
 * The Horizon SDK is mocked so these tests run without a real network
 * connection or a live Stellar node.
 */

"use strict";

const request = require("supertest");
const app = require("../../app");
const { cacheClear } = require("../../services/transactionService");

// ── Mock the Horizon server ───────────────────────────────────────────────────

// We need to mock before the module cache loads the real horizonServer.
// Jest hoists jest.mock() calls automatically.
jest.mock("../../config/stellar", () => {
  const buildOpsCall = (ops) => ({
    call: jest.fn().mockResolvedValue({ records: ops }),
    limit: jest.fn().mockReturnThis(),
  });

  const mockHorizonServer = {
    loadAccount: jest.fn(),
    feeStats: jest.fn(),
    transactions: jest.fn(),
    operations: jest.fn(),
  };

  return {
    horizonServer: mockHorizonServer,
    rpcServer: {},
    NETWORK: "testnet",
    CONTRACT_IDS: {
      marketplace: "CCMARKETPLACE000000000000000000000000000000000000000000",
      micropayments: "CCMICROPAY0000000000000000000000000000000000000000000",
      agentRegistry: "CCAGENTREGISTRY000000000000000000000000000000000000000",
    },
    NETWORK_CONFIG: {},
  };
});

// Grab the mock after jest.mock hoisting so we can configure behaviour per test.
const { horizonServer, CONTRACT_IDS } = require("../../config/stellar");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_KEY = "GBQNX4XFBKZ2S2GZPB2XVVZ5VVQYHXQAQYYVRJXPVDGXNVKGKBFLR3";
const UNKNOWN_KEY = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGEWNG5PZWXU2CQKM4PAT";

function makeTx(overrides = {}) {
  return {
    hash: "abc123",
    ledger_attr: 50000,
    created_at: "2026-07-18T10:00:00Z",
    successful: true,
    fee_charged: "100",
    operation_count: 1,
    paging_token: "50000",
    contract_ids: [CONTRACT_IDS.marketplace],
    ...overrides,
  };
}

function makeOp(overrides = {}) {
  return {
    id: "op-1",
    type: "invoke_host_function",
    function: "purchase_license",
    source_account: VALID_KEY,
    contract_id: CONTRACT_IDS.marketplace,
    parameters: [{ name: "asset_id", value: "3" }],
    ...overrides,
  };
}

/** Wire up horizonServer mocks for a successful transactions + operations call. */
function mockHorizonSuccess(txs, ops) {
  // transactions().forAccount().limit().order().includeFailed().call()
  const txBuilder = {
    forAccount: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    includeFailed: jest.fn().mockReturnThis(),
    cursor: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records: txs }),
  };
  horizonServer.transactions.mockReturnValue(txBuilder);

  // operations().forTransaction().limit().call()
  const opsBuilder = {
    forTransaction: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    call: jest.fn().mockResolvedValue({ records: ops }),
  };
  horizonServer.operations.mockReturnValue(opsBuilder);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  cacheClear();
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/v1/stellar/account/:publicKey/transactions", () => {
  // ── Happy path ─────────────────────────────────────────────────────────────

  it("returns 200 with data and meta for a valid public key", async () => {
    const tx = makeTx();
    const op = makeOp();
    mockHorizonSuccess([tx], [op]);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body).toHaveProperty("meta");
    expect(res.body.meta).toHaveProperty("page", 1);
    expect(res.body.meta).toHaveProperty("limit", 20);
    expect(res.body.meta).toHaveProperty("count");
  });

  it("returns parsed operation summaries in each transaction", async () => {
    const tx = makeTx();
    const op = makeOp({ function: "purchase_license", parameters: [{ name: "asset_id", value: "3" }] });
    mockHorizonSuccess([tx], [op]);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    const record = res.body.data[0];
    expect(record.summary).toBe("Purchased license for asset #3");
    expect(record.operations).toHaveLength(1);
    expect(record.operations[0].summary).toBe("Purchased license for asset #3");
  });

  it("includes standard transaction fields in each record", async () => {
    const tx = makeTx();
    const op = makeOp();
    mockHorizonSuccess([tx], [op]);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    const record = res.body.data[0];
    expect(record).toHaveProperty("hash", "abc123");
    expect(record).toHaveProperty("ledger", 50000);
    expect(record).toHaveProperty("createdAt", "2026-07-18T10:00:00Z");
    expect(record).toHaveProperty("successful", true);
    expect(record).toHaveProperty("feeCharged", "100");
    expect(record).toHaveProperty("operationCount", 1);
    expect(record).toHaveProperty("pagingToken");
  });

  it("respects the limit query param", async () => {
    // Return 5 transactions; request limit=2 → expect 2 in first page
    const txs = Array.from({ length: 5 }, (_, i) => makeTx({ hash: `hash-${i}`, paging_token: String(i) }));
    const op = makeOp();
    mockHorizonSuccess(txs, [op]);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions?page=1&limit=2`)
      .expect(200);

    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });

  it("returns correct meta.page value", async () => {
    mockHorizonSuccess([], []);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions?page=3&limit=10`)
      .expect(200);

    expect(res.body.meta.page).toBe(3);
    expect(res.body.meta.limit).toBe(10);
  });

  // ── Contract filtering ──────────────────────────────────────────────────────

  it("filters out transactions that do not involve known contract addresses", async () => {
    // tx1 involves the marketplace contract; tx2 has no known contract
    const tx1 = makeTx({ hash: "match", contract_ids: [CONTRACT_IDS.marketplace] });
    const tx2 = makeTx({ hash: "nomatch", contract_ids: [] });

    const txBuilder = {
      forAccount: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      includeFailed: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({ records: [tx1, tx2] }),
    };
    horizonServer.transactions.mockReturnValue(txBuilder);

    // Operations for tx1 have contract_id set; tx2 ops do not
    horizonServer.operations
      .mockReturnValueOnce({
        forTransaction: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        call: jest.fn().mockResolvedValue({
          records: [makeOp({ contract_id: CONTRACT_IDS.marketplace })],
        }),
      })
      .mockReturnValueOnce({
        forTransaction: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        call: jest.fn().mockResolvedValue({ records: [makeOp({ contract_id: "" })] }),
      });

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    // Only tx1 should survive the filter
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].hash).toBe("match");
  });

  // ── Operation summary parsing ───────────────────────────────────────────────

  it("parses list_asset operation correctly", async () => {
    mockHorizonSuccess(
      [makeTx()],
      [makeOp({ function: "list_asset", parameters: [] })]
    );

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    expect(res.body.data[0].operations[0].summary).toBe(
      "Listed a new intelligence asset"
    );
  });

  it("parses delist_asset operation correctly", async () => {
    mockHorizonSuccess(
      [makeTx()],
      [makeOp({ function: "delist_asset", parameters: [] })]
    );

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    expect(res.body.data[0].operations[0].summary).toBe("Delisted an intelligence asset");
  });

  it("parses purchase_license without asset_id param gracefully", async () => {
    mockHorizonSuccess(
      [makeTx()],
      [makeOp({ function: "purchase_license", parameters: [] })]
    );

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    expect(res.body.data[0].operations[0].summary).toBe("Purchased a license");
  });

  it("parses payment operation correctly", async () => {
    mockHorizonSuccess(
      [makeTx()],
      [makeOp({
        type: "payment",
        function: undefined,
        amount: "10.0000000",
        asset_type: "native",
        to: UNKNOWN_KEY,
        contract_id: CONTRACT_IDS.marketplace, // so it isn't filtered
      })]
    );

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    const summary = res.body.data[0].operations[0].summary;
    expect(summary).toMatch(/Payment of 10.0000000 XLM/);
  });

  // ── Caching ─────────────────────────────────────────────────────────────────

  it("returns cached response on second identical request within TTL", async () => {
    const tx = makeTx();
    const op = makeOp();
    mockHorizonSuccess([tx], [op]);

    // First call — hits Horizon
    await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    // Second call — should use cache; Horizon mocks should NOT be called again
    const txBuilderMock = horizonServer.transactions.mock.results[0]?.value;
    const callCountBefore = txBuilderMock?.call.mock.calls.length ?? 0;

    await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    // transactions().call() should still be at the same count (cache hit)
    expect(txBuilderMock?.call.mock.calls.length).toBe(callCountBefore);
  });

  // ── Validation ──────────────────────────────────────────────────────────────

  it("returns 422 for a public key shorter than 56 characters", async () => {
    await request(app)
      .get("/api/v1/stellar/account/TOOSHORT/transactions")
      .expect(422);
  });

  it("returns 422 for a public key longer than 56 characters", async () => {
    const tooLong = "G" + "B".repeat(56); // 57 chars
    await request(app)
      .get(`/api/v1/stellar/account/${tooLong}/transactions`)
      .expect(422);
  });

  it("returns 422 for a non-integer limit param", async () => {
    await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions?limit=abc`)
      .expect(422);
  });

  it("returns 422 for a limit of 0", async () => {
    await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions?limit=0`)
      .expect(422);
  });

  it("returns 422 for a limit above 200", async () => {
    await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions?limit=201`)
      .expect(422);
  });

  it("returns 422 for page less than 1", async () => {
    await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions?page=0`)
      .expect(422);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────────

  it("returns 404 when Horizon reports account not found", async () => {
    const notFoundError = { response: { status: 404 } };

    const txBuilder = {
      forAccount: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      includeFailed: jest.fn().mockReturnThis(),
      cursor: jest.fn().mockReturnThis(),
      call: jest.fn().mockRejectedValue(notFoundError),
    };
    horizonServer.transactions.mockReturnValue(txBuilder);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${UNKNOWN_KEY}/transactions`)
      .expect(404);

    expect(res.body.error).toMatch(/not found/i);
  });

  // ── Empty result ─────────────────────────────────────────────────────────────

  it("returns empty data array when no matching transactions exist", async () => {
    mockHorizonSuccess([], []);

    const res = await request(app)
      .get(`/api/v1/stellar/account/${VALID_KEY}/transactions`)
      .expect(200);

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.count).toBe(0);
    expect(res.body.meta.hasMore).toBe(false);
  });
});
