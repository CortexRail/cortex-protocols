/**
 * Shared helpers for integration tests running against the containerized
 * PostgreSQL instance (see globalSetup.js).
 */

const { query, closePool } = require("../../db/connection");

/**
 * Wipe every table between tests. CASCADE covers the FK chains
 * (licenses/reports → assets) and RESTART IDENTITY resets BIGSERIAL ids
 * so tests can assert on them deterministically.
 */
async function truncateAll() {
  await query(
    "TRUNCATE TABLE reports, licenses, events_log, streams, agents, assets RESTART IDENTITY CASCADE"
  );
}

// ── Fixture builders ─────────────────────────────────────────────────────────

// Real, checksum-valid Ed25519 public keys (generated via Keypair.random()) —
// route validation now checks the StrKey checksum, so placeholder-looking
// strings of the right length are no longer sufficient here.
const OWNER_A = "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT";
const OWNER_B = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";

let nextId = 1;

function uniqueId() {
  return nextId++;
}

function buildAsset(overrides = {}) {
  return {
    id: uniqueId(),
    owner: OWNER_A,
    name: "Test Asset",
    description: "A test asset for integration testing.",
    assetType: "Prompt",
    licenseType: "Perpetual",
    price: 1_000_000,
    version: 1,
    usageCount: 0,
    isActive: true,
    tags: ["test"],
    ...overrides,
  };
}

function buildAgent(overrides = {}) {
  return {
    id: uniqueId(),
    owner: OWNER_A,
    name: "Test Agent",
    description: "A test agent for integration testing.",
    capabilities: ["Reasoning"],
    reputation: 5000,
    totalTransactions: 0,
    isActive: true,
    ...overrides,
  };
}

function buildStream(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: uniqueId(),
    sender: OWNER_A,
    recipient: OWNER_B,
    token: "native",
    deposit: 10_000_000,
    ratePerSecond: 100,
    startTime: now,
    endTime: now + 100_000,
    status: "Active",
    withdrawn: 0,
    ...overrides,
  };
}

function buildEvent(overrides = {}) {
  return {
    ledger: 1000,
    contractId: "CCMARKETPLACE000000000000000000000000000000000000000000",
    topic: ["LISTED"],
    payload: { assetId: 1 },
    txHash: `tx-${uniqueId()}`,
    ...overrides,
  };
}

module.exports = {
  truncateAll,
  closePool,
  buildAsset,
  buildAgent,
  buildStream,
  buildEvent,
  OWNER_A,
  OWNER_B,
};
