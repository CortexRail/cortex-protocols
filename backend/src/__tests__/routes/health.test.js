const request = require("supertest");

// Valid contract strkey (testnet example address) so Contract() parses it.
const MARKETPLACE_ID =
  "CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE";

const mockGetLatestLedger = jest.fn();
const mockGetLedgerEntries = jest.fn();
const mockFeeStats = jest.fn();
const mockContractIds = { marketplace: "", micropayments: "", agentRegistry: "" };

jest.mock("../../config/stellar", () => ({
  NETWORK: "testnet",
  networkPassphrase: "Test SDF Network ; September 2015",
  rpcUrl: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
  rpcServer: {
    getLatestLedger: (...args) => mockGetLatestLedger(...args),
    getLedgerEntries: (...args) => mockGetLedgerEntries(...args),
  },
  horizonServer: {
    feeStats: (...args) => mockFeeStats(...args),
  },
  CONTRACT_IDS: mockContractIds,
}));

const app = require("../../app");
const { closePool } = require("../helpers/testDb");

afterAll(async () => {
  await closePool();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockContractIds.marketplace = "";
  mockContractIds.micropayments = "";
  mockContractIds.agentRegistry = "";
  mockGetLatestLedger.mockResolvedValue({ sequence: 123456 });
  mockFeeStats.mockResolvedValue({ last_ledger_base_fee: "100" });
  mockGetLedgerEntries.mockResolvedValue({ entries: [] });
});

describe("GET /health/contracts", () => {
  it("reports ok when RPC is reachable and no contracts are configured", async () => {
    const res = await request(app).get("/health/contracts").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.network).toBe("testnet");
    expect(res.body.rpc).toEqual(
      expect.objectContaining({ healthy: true, latestLedger: 123456 })
    );
    expect(res.body.horizon.healthy).toBe(true);
    expect(res.body.contracts.marketplace).toEqual({
      configured: false,
      deployed: null,
    });
    expect(res.body.timestamp).toBeDefined();
  });

  it("reports ok when a configured contract is found on the ledger", async () => {
    mockContractIds.marketplace = MARKETPLACE_ID;
    mockGetLedgerEntries.mockResolvedValue({ entries: [{ key: "instance" }] });

    const res = await request(app).get("/health/contracts").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.contracts.marketplace).toEqual(
      expect.objectContaining({
        configured: true,
        contractId: MARKETPLACE_ID,
        deployed: true,
      })
    );
  });

  it("degrades when a configured contract is missing from the ledger", async () => {
    mockContractIds.marketplace = MARKETPLACE_ID;
    mockGetLedgerEntries.mockResolvedValue({ entries: [] });

    const res = await request(app).get("/health/contracts").expect(503);

    expect(res.body.status).toBe("degraded");
    expect(res.body.contracts.marketplace).toEqual(
      expect.objectContaining({
        deployed: false,
        error: "contract instance not found on ledger",
      })
    );
  });

  it("degrades when the contract ID is malformed", async () => {
    mockContractIds.marketplace = "not-a-contract-id";

    const res = await request(app).get("/health/contracts").expect(503);

    expect(res.body.status).toBe("degraded");
    expect(res.body.contracts.marketplace.deployed).toBe(false);
    expect(res.body.contracts.marketplace.error).toBeDefined();
  });

  it("degrades when the RPC node is unreachable", async () => {
    mockGetLatestLedger.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const res = await request(app).get("/health/contracts").expect(503);

    expect(res.body.status).toBe("degraded");
    expect(res.body.rpc).toEqual(
      expect.objectContaining({
        healthy: false,
        error: "connect ECONNREFUSED",
      })
    );
  });

  it("stays ok when only Horizon is down", async () => {
    mockFeeStats.mockRejectedValue(new Error("horizon timeout"));

    const res = await request(app).get("/health/contracts").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.horizon).toEqual(
      expect.objectContaining({ healthy: false, error: "horizon timeout" })
    );
  });
});
