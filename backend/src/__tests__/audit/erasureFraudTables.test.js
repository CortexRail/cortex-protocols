/**
 * GDPR erasure coverage for the fraud detection tables.
 *
 * ErasureService enumerates the tables it pseudonymises by hand, so any new
 * table holding addresses is invisible to it until it is added explicitly.
 * The fraud pipeline introduced three: usage_events (caller/counterparty),
 * fraud_signals (agent_address plus an evidence payload full of addresses),
 * and agent_funding_sources (both columns are addresses).
 *
 * These tests fail loudly if a future change drops one of them again.
 */

const { query } = require("../../db/connection");
const assetRepository = require("../../repositories/assetRepository");
const usageEventRepository = require("../../repositories/usageEventRepository");
const fraudSignalRepository = require("../../repositories/fraudSignalRepository");
const agentFundingRepository = require("../../repositories/agentFundingRepository");
const reportRepository = require("../../repositories/reportRepository");
const { ErasureService } = require("../../audit/ErasureService");
const { truncateAll, closePool, buildAsset, OWNER_B } = require("../helpers/testDb");

// A checksum-valid key standing in for the erasure subject.
const SUBJECT = "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT";

let asset;

beforeEach(async () => {
  await truncateAll();
  await query("TRUNCATE TABLE compliance_requests, pseudonym_map, audit_log RESTART IDENTITY CASCADE");
  asset = await assetRepository.create(buildAsset({ owner: OWNER_B }));
});

afterAll(async () => {
  await closePool();
});

async function runErasure(subjectId = SUBJECT) {
  const { rows } = await query(
    `INSERT INTO compliance_requests (request_type, subject_id, requested_by, status)
     VALUES ('erasure', $1, 'admin', 'pending') RETURNING id`,
    [subjectId]
  );
  await new ErasureService().processErasure(rows[0].id);
}

describe("ErasureService covers the fraud tables", () => {
  it("pseudonymises the subject in usage_events, as caller and as counterparty", async () => {
    await usageEventRepository.record({
      source: "stream",
      streamId: 1,
      assetId: asset.id,
      caller: SUBJECT,
      counterparty: OWNER_B,
      pricePaid: 100,
    });
    await usageEventRepository.record({
      source: "stream",
      streamId: 2,
      assetId: asset.id,
      caller: OWNER_B,
      counterparty: SUBJECT,
      pricePaid: 100,
    });

    await runErasure();

    const { rows } = await query("SELECT caller, counterparty FROM usage_events ORDER BY id");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.caller).not.toBe(SUBJECT);
      expect(row.counterparty).not.toBe(SUBJECT);
    }
    expect(rows[0].caller).toMatch(/^PSEUDONYM_/);
    expect(rows[1].counterparty).toMatch(/^PSEUDONYM_/);
  });

  it("pseudonymises fraud_signals, including addresses buried in the evidence", async () => {
    await fraudSignalRepository.upsertActive({
      scanId: "44444444-4444-4444-8444-444444444444",
      detector: "sybil_graph",
      agentAddress: SUBJECT,
      assetId: asset.id,
      score: 0.8,
      riskTier: "high",
      evidence: {
        summary: `Possible sybil cluster including ${SUBJECT}.`,
        subgraph: { nodes: [{ address: SUBJECT, degree: 3 }], edges: [] },
      },
      explanation: `Risk HIGH for ${SUBJECT}.`,
      windowStart: Date.now() - 3_600_000,
      windowEnd: Date.now(),
    });

    await runErasure();

    const { rows } = await query("SELECT agent_address, evidence FROM fraud_signals");
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_address).toMatch(/^PSEUDONYM_/);
    // The address must be gone from the nested evidence too, not just the column.
    expect(JSON.stringify(rows[0].evidence)).not.toContain(SUBJECT);
  });

  it("pseudonymises agent_funding_sources as funded account and as funder", async () => {
    await agentFundingRepository.upsert({
      agentAddress: SUBJECT,
      fundingSource: OWNER_B,
      firstFundedAt: Date.now(),
    });
    await agentFundingRepository.upsert({
      agentAddress: OWNER_B,
      fundingSource: SUBJECT,
      firstFundedAt: Date.now(),
    });

    await runErasure();

    const { rows } = await query(
      "SELECT agent_address, funding_source FROM agent_funding_sources"
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.agent_address).not.toBe(SUBJECT);
      expect(row.funding_source).not.toBe(SUBJECT);
    }
  });

  it("scrubs the subject from an automated report's evidence payload", async () => {
    await reportRepository.upsertAutomated({
      assetId: asset.id,
      reporter: "system:fraud-scan",
      reason: "AutomatedFraud",
      details: "Risk HIGH: wash usage detected.",
      evidence: { signals: [{ detector: "wash_usage", agentAddress: SUBJECT }] },
    });

    await runErasure();

    const { rows } = await query("SELECT evidence FROM reports");
    expect(JSON.stringify(rows[0].evidence)).not.toContain(SUBJECT);
  });

  it("names the fraud tables in the erasure summary", async () => {
    await usageEventRepository.record({
      source: "stream",
      assetId: asset.id,
      caller: SUBJECT,
      counterparty: OWNER_B,
      pricePaid: 100,
    });

    await runErasure();

    const { rows } = await query(
      "SELECT result_summary FROM compliance_requests ORDER BY id DESC LIMIT 1"
    );
    expect(rows[0].result_summary.tables_modified).toContain("usage_events");
  });
});
