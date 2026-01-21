const request = require("supertest");
const app = require("../app");

describe("GET /api/v1/assets", () => {
  it("returns a list of assets", async () => {
    const res = await request(app).get("/api/v1/assets").expect(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("filters by assetType", async () => {
    const res = await request(app)
      .get("/api/v1/assets?assetType=Prompt")
      .expect(200);
    res.body.data.forEach((a) => {
      expect(a.assetType).toBe("Prompt");
    });
  });

  it("rejects invalid assetType", async () => {
    await request(app).get("/api/v1/assets?assetType=Invalid").expect(422);
  });

  it("paginates correctly", async () => {
    const res = await request(app)
      .get("/api/v1/assets?page=1&limit=2")
      .expect(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.limit).toBe(2);
  });
});

describe("GET /api/v1/assets/:id", () => {
  it("returns an asset by id", async () => {
    const res = await request(app).get("/api/v1/assets/1").expect(200);
    expect(res.body.id).toBe(1);
  });

  it("returns 404 for unknown id", async () => {
    await request(app).get("/api/v1/assets/99999").expect(404);
  });
});

describe("GET /api/v1/assets/types/list", () => {
  it("returns asset types and license types", async () => {
    const res = await request(app).get("/api/v1/assets/types/list").expect(200);
    expect(Array.isArray(res.body.assetTypes)).toBe(true);
    expect(Array.isArray(res.body.licenseTypes)).toBe(true);
  });
});
