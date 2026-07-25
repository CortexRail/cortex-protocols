const request = require("supertest");
const app = require("../../app");
const assetRepository = require("../../repositories/assetRepository");
const { truncateAll, closePool, buildAsset, OWNER_A } = require("../helpers/testDb");

const ADMIN_KEY = "test-admin-key";

beforeAll(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterAll(async () => {
  delete process.env.ADMIN_API_KEY;
  await closePool();
});

beforeEach(async () => {
  await truncateAll();
});

describe("GET /api/v1/admin/reports", () => {
  it("rejects requests without the admin key", async () => {
    await request(app).get("/api/v1/admin/reports").expect(401);
  });

  it("rejects requests with a wrong admin key", async () => {
    await request(app)
      .get("/api/v1/admin/reports")
      .set("x-admin-key", "nope")
      .expect(401);
  });

  it("returns reports with the related asset attached", async () => {
    const asset = await assetRepository.create(buildAsset());
    await request(app)
      .post(`/api/v1/assets/${asset.id}/report`)
      .send({ reporter: OWNER_A, reason: "Spam" })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/admin/reports")
      .set("x-admin-key", ADMIN_KEY)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].asset).not.toBeNull();
    expect(res.body.data[0].asset.id).toBe(asset.id);
    expect(res.body.meta.total).toBe(1);
  });

  it("filters by assetId", async () => {
    const assetA = await assetRepository.create(buildAsset());
    const assetB = await assetRepository.create(buildAsset());
    await request(app)
      .post(`/api/v1/assets/${assetA.id}/report`)
      .send({ reporter: OWNER_A, reason: "Spam" })
      .expect(201);
    await request(app)
      .post(`/api/v1/assets/${assetB.id}/report`)
      .send({ reporter: OWNER_A, reason: "Other" })
      .expect(201);

    const res = await request(app)
      .get(`/api/v1/admin/reports?assetId=${assetA.id}`)
      .set("x-admin-key", ADMIN_KEY)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].assetId).toBe(assetA.id);
  });

  it("filters by status", async () => {
    const asset = await assetRepository.create(buildAsset());
    await request(app)
      .post(`/api/v1/assets/${asset.id}/report`)
      .send({ reporter: OWNER_A, reason: "Spam" })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/admin/reports?status=Resolved")
      .set("x-admin-key", ADMIN_KEY)
      .expect(200);

    expect(res.body.data).toHaveLength(0);
  });

  it("returns 422 for an invalid status filter", async () => {
    await request(app)
      .get("/api/v1/admin/reports?status=NotAStatus")
      .set("x-admin-key", ADMIN_KEY)
      .expect(422);
  });

  it("returns 503 when no admin key is configured at all", async () => {
    delete process.env.ADMIN_API_KEY;
    try {
      await request(app)
        .get("/api/v1/admin/reports")
        .set("x-admin-key", ADMIN_KEY)
        .expect(503);
    } finally {
      process.env.ADMIN_API_KEY = ADMIN_KEY;
    }
  });
});
