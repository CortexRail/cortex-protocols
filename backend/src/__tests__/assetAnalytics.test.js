const request = require("supertest");
const app = require("../app");
const assetRepository = require("../repositories/assetRepository");
const licenseRepository = require("../repositories/licenseRepository");
const usageEventRepository = require("../repositories/usageEventRepository");
const { truncateAll, closePool, buildAsset, buildUsageEvent, OWNER_A, OWNER_B } = require("./helpers/testDb");

let asset;

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(buildAsset({ owner: OWNER_A, licenseType: "UsageBased" }));
});

afterAll(async () => {
  await closePool();
});

describe("GET /api/v1/assets/:id/usage", () => {
  it("returns the calls-and-revenue series for the owner", async () => {
    const now = Date.now();
    await usageEventRepository.record(
      buildUsageEvent({ assetId: asset.id, occurredAt: now, pricePaid: 100 })
    );

    const res = await request(app)
      .get(`/api/v1/assets/${asset.id}/usage`)
      .query({ owner: OWNER_A, from: now - 3_600_000, to: now + 3_600_000 })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].calls).toBe(1);
    expect(res.body.data[0].revenue).toBe(100);
  });

  it("rejects a non-owner with 403", async () => {
    await request(app)
      .get(`/api/v1/assets/${asset.id}/usage`)
      .query({ owner: OWNER_B })
      .expect(403);
  });

  it("returns 404 for an unknown asset", async () => {
    await request(app)
      .get("/api/v1/assets/999999/usage")
      .query({ owner: OWNER_A })
      .expect(404);
  });

  it("rejects a malformed owner", async () => {
    await request(app)
      .get(`/api/v1/assets/${asset.id}/usage`)
      .query({ owner: "too-short" })
      .expect(422);
  });
});

describe("GET /api/v1/assets/:id/top-callers", () => {
  it("returns callers sorted by call count, scoped to the asset", async () => {
    const now = Date.now();
    const otherAsset = await assetRepository.create(buildAsset({ owner: OWNER_A }));
    await usageEventRepository.record(
      buildUsageEvent({ assetId: asset.id, caller: OWNER_B, occurredAt: now })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: asset.id, caller: OWNER_B, occurredAt: now })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: otherAsset.id, caller: OWNER_B, occurredAt: now })
    );

    const res = await request(app)
      .get(`/api/v1/assets/${asset.id}/top-callers`)
      .query({ owner: OWNER_A })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].caller).toBe(OWNER_B);
    expect(res.body.data[0].calls).toBe(2);
  });

  it("rejects a non-owner with 403", async () => {
    await request(app)
      .get(`/api/v1/assets/${asset.id}/top-callers`)
      .query({ owner: OWNER_B })
      .expect(403);
  });
});

describe("GET /api/v1/assets/:id/revenue-breakdown", () => {
  it("breaks revenue down by license type for the owner", async () => {
    await licenseRepository.create({
      assetId: asset.id,
      buyer: OWNER_B,
      licenseType: "UsageBased",
      pricePaid: 400_000,
      callsRemaining: 100,
    });

    const res = await request(app)
      .get(`/api/v1/assets/${asset.id}/revenue-breakdown`)
      .query({ owner: OWNER_A })
      .expect(200);

    expect(res.body.totalRevenue).toBe(400_000);
    expect(res.body.data).toEqual([
      { licenseType: "UsageBased", licenseCount: 1, revenue: 400_000 },
    ]);
  });

  it("rejects a non-owner with 403", async () => {
    await request(app)
      .get(`/api/v1/assets/${asset.id}/revenue-breakdown`)
      .query({ owner: OWNER_B })
      .expect(403);
  });
});

describe("GET /api/v1/assets/:id/remaining-calls", () => {
  it("sums remaining calls across active usage-based licenses", async () => {
    await licenseRepository.create({
      assetId: asset.id,
      buyer: OWNER_B,
      licenseType: "UsageBased",
      pricePaid: 100_000,
      callsRemaining: 42,
    });

    const res = await request(app)
      .get(`/api/v1/assets/${asset.id}/remaining-calls`)
      .query({ owner: OWNER_A })
      .expect(200);

    expect(res.body).toEqual({ activeLicenseCount: 1, totalRemaining: 42 });
  });

  it("rejects a non-owner with 403", async () => {
    await request(app)
      .get(`/api/v1/assets/${asset.id}/remaining-calls`)
      .query({ owner: OWNER_B })
      .expect(403);
  });
});

describe("POST /api/v1/licenses/:id/topup", () => {
  it("adds calls and increases price_paid at the derived per-call rate", async () => {
    const license = await licenseRepository.create({
      assetId: asset.id,
      buyer: OWNER_B,
      licenseType: "UsageBased",
      pricePaid: 100_000, // 100 calls at asset.price (1_000_000) / 100 = 10_000/call
      callsRemaining: 5,
    });

    const res = await request(app)
      .post(`/api/v1/licenses/${license.id}/topup`)
      .send({ buyer: OWNER_B, calls: 10 })
      .expect(201);

    expect(res.body.callsAdded).toBe(10);
    expect(res.body.amountCharged).toBe(100_000); // 10_000/call * 10 calls
    expect(res.body.license.callsRemaining).toBe(15);
    expect(res.body.license.pricePaid).toBe(200_000);
  });

  it("rejects a buyer that doesn't own the license", async () => {
    const license = await licenseRepository.create({
      assetId: asset.id,
      buyer: OWNER_B,
      licenseType: "UsageBased",
      pricePaid: 100_000,
      callsRemaining: 5,
    });

    await request(app)
      .post(`/api/v1/licenses/${license.id}/topup`)
      .send({ buyer: OWNER_A, calls: 10 })
      .expect(403);
  });

  it("rejects a non-usage-based license", async () => {
    const perpetualAsset = await assetRepository.create(buildAsset({ licenseType: "Perpetual" }));
    const license = await licenseRepository.create({
      assetId: perpetualAsset.id,
      buyer: OWNER_B,
      licenseType: "Perpetual",
      pricePaid: 1_000_000,
      callsRemaining: null,
    });

    await request(app)
      .post(`/api/v1/licenses/${license.id}/topup`)
      .send({ buyer: OWNER_B, calls: 10 })
      .expect(400);
  });

  it("rejects an unknown license with 404", async () => {
    await request(app)
      .post("/api/v1/licenses/999999/topup")
      .send({ buyer: OWNER_B, calls: 10 })
      .expect(404);
  });

  it("rejects a non-positive calls value", async () => {
    const license = await licenseRepository.create({
      assetId: asset.id,
      buyer: OWNER_B,
      licenseType: "UsageBased",
      pricePaid: 100_000,
      callsRemaining: 5,
    });

    await request(app)
      .post(`/api/v1/licenses/${license.id}/topup`)
      .send({ buyer: OWNER_B, calls: 0 })
      .expect(422);
  });
});
