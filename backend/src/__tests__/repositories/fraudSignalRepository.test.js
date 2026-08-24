/**
 * fraud_signals upsert semantics.
 *
 * The whole idempotency story rests on one partial unique index —
 * (detector, agent_address, COALESCE(asset_id, 0)) WHERE status <> 'dismissed'
 * — and on ON CONFLICT inferring exactly that index. These tests pin that
 * against a real Postgres, because an inference mismatch fails at runtime,
 * not at load time.
 */

const { query } = require("../../db/connection");
const assetRepository = require("../../repositories/assetRepository");
const fraudSignalRepository = require("../../repositories/fraudSignalRepository");
const reportRepository = require("../../repositories/reportRepository");
const { truncateAll, closePool, buildAsset, OWNER_A, OWNER_B } = require("../helpers/testDb");

let asset;

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(buildAsset());
});

afterAll(async () => {
  await closePool();
});

const SCAN_A = "11111111-1111-4111-8111-111111111111";
const SCAN_B = "22222222-2222-4222-8222-222222222222";

function buildSignal(overrides = {}) {
  const now = Date.now();
  return {
    scanId: SCAN_A,
    detector: "wash_usage",
    agentAddress: OWNER_A,
    assetId: asset.id,
    score: 0.5,
    riskTier: "medium",
    evidence: { summary: "seed", metrics: { calls: 10 } },
    explanation: "Seed explanation.",
    windowStart: now - 3_600_000,
    windowEnd: now,
    ...overrides,
  };
}

describe("fraudSignalRepository.upsertActive", () => {
  it("inserts a new signal", async () => {
    const signal = await fraudSignalRepository.upsertActive(buildSignal());

    expect(signal.id).toBeGreaterThan(0);
    expect(signal.status).toBe("open");
    expect(signal.score).toBe(0.5);
    expect(signal.detector).toBe("wash_usage");
    expect(signal.evidence).toEqual({ summary: "seed", metrics: { calls: 10 } });
  });

  it("refreshes the open signal for the same subject instead of duplicating", async () => {
    const first = await fraudSignalRepository.upsertActive(buildSignal());
    const second = await fraudSignalRepository.upsertActive(
      buildSignal({
        scanId: SCAN_B,
        score: 0.91,
        riskTier: "critical",
        explanation: "Refreshed explanation.",
      })
    );

    expect(second.id).toBe(first.id);
    expect(second.score).toBe(0.91);
    expect(second.riskTier).toBe("critical");
    expect(second.explanation).toBe("Refreshed explanation.");
    expect(second.scanId).toBe(SCAN_B);

    const all = await fraudSignalRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(1);
  });

  it("keeps a reported signal attached to its report when a later scan refreshes it", async () => {
    const signal = await fraudSignalRepository.upsertActive(buildSignal());
    const report = await reportRepository.upsertAutomated({
      assetId: asset.id,
      reporter: "system:fraud-scan",
      reason: "AutomatedFraud",
      details: "routed",
    });
    const attached = await fraudSignalRepository.attachReport(signal.id, report.id);
    expect(attached.status).toBe("reported");

    // This is the case the 'open'-only predicate got wrong: a reported signal
    // must keep absorbing re-scans rather than spawning a duplicate.
    const refreshed = await fraudSignalRepository.upsertActive(
      buildSignal({ scanId: SCAN_B, score: 0.77 })
    );

    expect(refreshed.id).toBe(signal.id);
    expect(refreshed.status).toBe("reported");
    expect(refreshed.reportId).toBe(report.id);
    expect(refreshed.score).toBe(0.77);

    const all = await fraudSignalRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(1);
  });

  it("opens a fresh row after the previous signal was dismissed", async () => {
    const first = await fraudSignalRepository.upsertActive(buildSignal());
    await fraudSignalRepository.dismiss(first.id, {
      dismissedBy: "operator@example.com",
      reason: "known integration partner",
    });

    const second = await fraudSignalRepository.upsertActive(buildSignal({ scanId: SCAN_B }));

    expect(second.id).not.toBe(first.id);

    const all = await fraudSignalRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(2);

    const dismissed = await fraudSignalRepository.findById(first.id);
    expect(dismissed.status).toBe("dismissed");
    expect(dismissed.dismissReason).toBe("known integration partner");
  });

  it("treats a NULL asset as its own subject via COALESCE", async () => {
    const a = await fraudSignalRepository.upsertActive(
      buildSignal({ detector: "sybil_graph", assetId: null })
    );
    const b = await fraudSignalRepository.upsertActive(
      buildSignal({ detector: "sybil_graph", assetId: null, score: 0.8 })
    );

    // Both address-only signals collapse onto one row...
    expect(b.id).toBe(a.id);
    expect(b.score).toBe(0.8);

    // ...while the same detector on an actual asset is a separate subject.
    const scoped = await fraudSignalRepository.upsertActive(
      buildSignal({ detector: "sybil_graph", assetId: asset.id })
    );
    expect(scoped.id).not.toBe(a.id);

    const all = await fraudSignalRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(2);
  });

  it("keeps different detectors and different agents apart", async () => {
    await fraudSignalRepository.upsertActive(buildSignal({ detector: "wash_usage" }));
    await fraudSignalRepository.upsertActive(buildSignal({ detector: "velocity" }));
    await fraudSignalRepository.upsertActive(
      buildSignal({ detector: "wash_usage", agentAddress: OWNER_B })
    );

    const all = await fraudSignalRepository.findAll({}, { page: 1, limit: 50 });
    expect(all.meta.total).toBe(3);
  });

  it("rejects a signal with no human-readable explanation", async () => {
    // The acceptance criterion "never a bare score" is a CHECK constraint,
    // so this must fail in the database, not merely in the service layer.
    await expect(
      fraudSignalRepository.upsertActive(buildSignal({ explanation: "" }))
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a score outside 0..1", async () => {
    await expect(
      fraudSignalRepository.upsertActive(buildSignal({ score: 1.5 }))
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("fraudSignalRepository queries", () => {
  it("counts open signals per tier, zero-filling absent tiers", async () => {
    await fraudSignalRepository.upsertActive(buildSignal({ riskTier: "critical", score: 0.9 }));
    await fraudSignalRepository.upsertActive(
      buildSignal({ detector: "velocity", riskTier: "high", score: 0.75 })
    );

    const counts = await fraudSignalRepository.countsByTier();

    expect(counts).toEqual({ low: 0, medium: 0, high: 1, critical: 1 });
  });

  it("filters by detector and risk tier, worst first", async () => {
    await fraudSignalRepository.upsertActive(buildSignal({ score: 0.4, riskTier: "medium" }));
    await fraudSignalRepository.upsertActive(
      buildSignal({ detector: "velocity", score: 0.95, riskTier: "critical" })
    );

    const critical = await fraudSignalRepository.findAll(
      { riskTier: "critical" },
      { page: 1, limit: 20 }
    );
    expect(critical.meta.total).toBe(1);
    expect(critical.data[0].detector).toBe("velocity");

    const all = await fraudSignalRepository.findAll({}, { page: 1, limit: 20 });
    expect(all.data.map((s) => s.score)).toEqual([0.95, 0.4]);
  });

  it("returns open signals for one agent", async () => {
    await fraudSignalRepository.upsertActive(buildSignal());
    await fraudSignalRepository.upsertActive(buildSignal({ agentAddress: OWNER_B }));

    const forAgent = await fraudSignalRepository.findOpenByAgent(OWNER_A);
    expect(forAgent).toHaveLength(1);
    expect(forAgent[0].agentAddress).toBe(OWNER_A);
  });

  it("does not dismiss a signal twice", async () => {
    const signal = await fraudSignalRepository.upsertActive(buildSignal());
    expect(await fraudSignalRepository.dismiss(signal.id, { dismissedBy: "op" })).not.toBeNull();
    expect(await fraudSignalRepository.dismiss(signal.id, { dismissedBy: "op" })).toBeNull();
  });
});

describe("fraud_signals audit trail", () => {
  it("refuses to hard-delete an asset that has fraud findings", async () => {
    await fraudSignalRepository.upsertActive(buildSignal());

    // ON DELETE RESTRICT, mirroring licenses.asset_id: fraud findings are an
    // audit trail. Assets are only ever soft-deleted in this system, so this
    // guards against a future hard delete silently destroying evidence.
    //
    // 23503 (foreign_key_violation): on the Postgres version this project
    // actually runs (16, per src/__tests__/globalSetup.js's postgres:16-alpine
    // container), RESTRICT and the default NO ACTION both raise 23503 — PG
    // does not give RESTRICT its own 23001 (restrict_violation) code until a
    // later major version.
    await expect(
      query("DELETE FROM assets WHERE id = $1", [asset.id])
    ).rejects.toMatchObject({ code: "23503" });

    const survivors = await fraudSignalRepository.findAll({}, { page: 1, limit: 10 });
    expect(survivors.meta.total).toBe(1);
  });

  it("still allows deleting an asset with no findings", async () => {
    const untouched = await assetRepository.create(buildAsset());

    await expect(
      query("DELETE FROM assets WHERE id = $1", [untouched.id])
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("survives the soft delete the application actually performs", async () => {
    const signal = await fraudSignalRepository.upsertActive(buildSignal());

    expect(await assetRepository.softDelete(asset.id)).toBe(true);

    const still = await fraudSignalRepository.findById(signal.id);
    expect(still).not.toBeNull();
    expect(still.assetId).toBe(asset.id);
  });
});
