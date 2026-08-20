/**
 * Admin fraud endpoints.
 *
 * Mounts the admin router on a bare express app rather than requiring app.js.
 * That is not a stylistic choice: app.js pulls in routes/agents.js, which
 * requires services/agentService.js, which is truncated on main and fails to
 * parse — the reason routes/admin.test.js is already red. Mounting the router
 * under test keeps these cases meaningful until that file is repaired.
 */

const express = require("express");
const request = require("supertest");

const adminRouter = require("../../routes/admin");
const { errorHandler, notFoundHandler } = require("../../middleware/errorHandler");
const { query } = require("../../db/connection");
const agentRepository = require("../../repositories/agentRepository");
const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const streamRepository = require("../../repositories/streamRepository");
const usageEventRepository = require("../../repositories/usageEventRepository");
const agentFundingRepository = require("../../repositories/agentFundingRepository");
const fraudSignalRepository = require("../../repositories/fraudSignalRepository");
const fraudService = require("../../services/fraudService");
const { sybilRing } = require("../fraud/syntheticFraudScenarios");
const { truncateAll, closePool, buildAgent } = require("../helpers/testDb");

const ADMIN_KEY = "test-admin-key";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/admin", adminRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const app = buildApp();
const auth = (req) => req.set("x-admin-key", ADMIN_KEY);

let scenario;

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterAll(async () => {
  delete process.env.ADMIN_API_KEY;
  await closePool();
});

/** Seed the sybil ring from the backtest corpus and scan it once. */
async function seedFlaggedRing() {
  scenario = sybilRing({ now: Date.now() });

  for (const asset of scenario.assets) await assetRepository.create(asset);
  for (const license of scenario.licenses) await licenseRepository.create(license);
  for (const stream of scenario.streams) await streamRepository.create(stream);
  for (const funding of scenario.funding) await agentFundingRepository.upsert(funding);
  for (const event of scenario.usageEvents) await usageEventRepository.record(event);

  await fraudService.runScan({ now: scenario.window.to });
}

beforeEach(async () => {
  await truncateAll();
  await query("TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE");
});

describe("admin fraud endpoints: auth", () => {
  it.each([
    ["GET", "/api/v1/admin/fraud/signals"],
    ["GET", "/api/v1/admin/fraud/agents/GABC/graph"],
    ["POST", "/api/v1/admin/fraud/signals/1/dismiss"],
  ])("%s %s rejects a request with no admin key", async (method, path) => {
    await request(app)[method.toLowerCase()](path).expect(401);
  });

  it("rejects a wrong admin key", async () => {
    await request(app)
      .get("/api/v1/admin/fraud/signals")
      .set("x-admin-key", "nope")
      .expect(401);
  });
});

describe("GET /api/v1/admin/fraud/signals", () => {
  it("returns an empty page when nothing has been flagged", async () => {
    const res = await auth(request(app).get("/api/v1/admin/fraud/signals")).expect(200);

    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it("lists signals worst-first with the related asset attached", async () => {
    await seedFlaggedRing();

    const res = await auth(request(app).get("/api/v1/admin/fraud/signals?limit=100")).expect(200);

    expect(res.body.meta.total).toBeGreaterThan(0);
    const scores = res.body.data.map((s) => s.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    for (const signal of res.body.data) {
      expect(signal.explanation.length).toBeGreaterThan(20);
      // Asset-scoped findings carry their asset; address-scoped ones carry null.
      if (signal.assetId === null) expect(signal.asset).toBeNull();
      else expect(signal.asset.id).toBe(signal.assetId);
    }
  });

  it("filters by detector and by risk tier", async () => {
    await seedFlaggedRing();

    const sybil = await auth(
      request(app).get("/api/v1/admin/fraud/signals?detector=sybil_graph&limit=100")
    ).expect(200);
    expect(sybil.body.data.length).toBeGreaterThan(0);
    expect(sybil.body.data.every((s) => s.detector === "sybil_graph")).toBe(true);

    const critical = await auth(
      request(app).get("/api/v1/admin/fraud/signals?riskTier=critical&limit=100")
    ).expect(200);
    expect(critical.body.data.every((s) => s.riskTier === "critical")).toBe(true);
  });

  it("paginates", async () => {
    await seedFlaggedRing();

    const res = await auth(request(app).get("/api/v1/admin/fraud/signals?page=1&limit=2")).expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.limit).toBe(2);
    expect(res.body.meta.pages).toBeGreaterThan(1);
  });

  it("rejects an unknown detector", async () => {
    await auth(request(app).get("/api/v1/admin/fraud/signals?detector=telepathy")).expect(422);
  });
});

describe("GET /api/v1/admin/fraud/agents/:id/graph", () => {
  it("returns the cluster subgraph for a flagged address", async () => {
    await seedFlaggedRing();
    const member = scenario.labels.fraudAddresses[1];

    const res = await auth(
      request(app).get(`/api/v1/admin/fraud/agents/${member}/graph`)
    ).expect(200);

    expect(res.body.found).toBe(true);
    expect(res.body.cluster.size).toBe(9);
    expect(res.body.cluster.members).toContain(member);
    expect(res.body.subgraph.nodes.length).toBe(9);
    expect(res.body.subgraph.edges.length).toBeGreaterThan(0);

    // The score shown must be the one the detector computed, not a re-derivation.
    expect(res.body.score.fired).toBe(true);
    expect(res.body.score.value).toBeGreaterThanOrEqual(res.body.score.threshold);
    expect(res.body.signals.length).toBeGreaterThan(0);
  });

  it("resolves a numeric agent id to its owner address", async () => {
    await seedFlaggedRing();
    const operator = scenario.labels.fraudAddresses[0];
    const agent = await agentRepository.create(buildAgent({ owner: operator }));

    const res = await auth(
      request(app).get(`/api/v1/admin/fraud/agents/${agent.id}/graph`)
    ).expect(200);

    expect(res.body.address).toBe(operator);
    expect(res.body.found).toBe(true);
  });

  it("404s for an agent id that does not exist", async () => {
    await auth(request(app).get("/api/v1/admin/fraud/agents/424242/graph")).expect(404);
  });

  it("reports an address with no edges in the window rather than failing", async () => {
    const res = await auth(
      request(app).get("/api/v1/admin/fraud/agents/GNOBODYATALL/graph")
    ).expect(200);

    expect(res.body.found).toBe(false);
    expect(res.body.cluster).toBeNull();
    expect(res.body.signals).toEqual([]);
  });
});

describe("POST /api/v1/admin/fraud/signals/:id/dismiss", () => {
  async function firstOpenSignal() {
    const { data } = await fraudSignalRepository.findAll({ status: "open" }, { page: 1, limit: 1 });
    return data[0];
  }

  it("dismisses a signal and records the reason", async () => {
    await seedFlaggedRing();
    const signal = await firstOpenSignal();

    const res = await auth(
      request(app)
        .post(`/api/v1/admin/fraud/signals/${signal.id}/dismiss`)
        .send({ dismissedBy: "moderator@example.com", reason: "known integration partner" })
    ).expect(200);

    expect(res.body.status).toBe("dismissed");
    expect(res.body.dismissedBy).toBe("moderator@example.com");
    expect(res.body.dismissReason).toBe("known integration partner");
  });

  it("writes the decision to the tamper-evident audit log", async () => {
    await seedFlaggedRing();
    const signal = await firstOpenSignal();

    await auth(
      request(app)
        .post(`/api/v1/admin/fraud/signals/${signal.id}/dismiss`)
        .send({ dismissedBy: "moderator@example.com", reason: "false positive" })
    ).expect(200);

    const { rows } = await query(
      "SELECT event_type, actor, subject_id, payload FROM audit_log WHERE event_type = $1",
      ["FRAUD_SIGNAL_DISMISSED"]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("moderator@example.com");
    expect(rows[0].subject_id).toBe(signal.agentAddress);
    expect(rows[0].payload.signalId).toBe(signal.id);
    expect(rows[0].payload.reason).toBe("false positive");
  });

  it("409s when the signal has already been dismissed", async () => {
    await seedFlaggedRing();
    const signal = await firstOpenSignal();
    const dismiss = () =>
      auth(
        request(app)
          .post(`/api/v1/admin/fraud/signals/${signal.id}/dismiss`)
          .send({ dismissedBy: "moderator@example.com" })
      );

    await dismiss().expect(200);
    await dismiss().expect(409);
  });

  it("404s for a signal that does not exist", async () => {
    await auth(
      request(app)
        .post("/api/v1/admin/fraud/signals/999999/dismiss")
        .send({ dismissedBy: "moderator@example.com" })
    ).expect(404);
  });

  it("422s without an operator identity", async () => {
    await seedFlaggedRing();
    const signal = await firstOpenSignal();

    await auth(
      request(app).post(`/api/v1/admin/fraud/signals/${signal.id}/dismiss`).send({})
    ).expect(422);
  });

  it("lets a dismissed signal drop out of the open queue", async () => {
    await seedFlaggedRing();
    const signal = await firstOpenSignal();

    await auth(
      request(app)
        .post(`/api/v1/admin/fraud/signals/${signal.id}/dismiss`)
        .send({ dismissedBy: "moderator@example.com" })
    ).expect(200);

    const open = await auth(
      request(app).get("/api/v1/admin/fraud/signals?status=open&limit=100")
    ).expect(200);

    expect(open.body.data.map((s) => s.id)).not.toContain(signal.id);
  });
});
