const request = require("supertest");
const app = require("../app");
const { seed } = require("../db/seed");
const assetRepository = require("../repositories/assetRepository");
const licenseRepository = require("../repositories/licenseRepository");
const {
  truncateAll,
  closePool,
  OWNER_A,
  OWNER_B,
} = require("./helpers/testDb");

// Right length (56 chars), right "G" prefix, but an invalid checksum.
const BAD_CHECKSUM_KEY =
  "GA234567A234567A234567A234567A234567A234567A234567A23456";

function createVersionedAsset(id, overrides = {}) {
  return assetRepository.create({
    id,
    owner: OWNER_A,
    name: `Versioned asset ${id}`,
    description: "Version-aware purchase fixture.",
    assetType: "Prompt",
    licenseType: "UsageBased",
    price: 765_432,
    version: 7,
    tags: ["versioned"],
    ...overrides,
  });
}

beforeAll(async () => {
  await truncateAll();
  await seed();
});

afterAll(async () => {
  await closePool();
});

describe("GET /api/v1/assets", () => {
  it("returns a list of assets", async () => {
    const res = await request(app).get("/api/v1/assets").expect(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("meta");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    res.body.data.forEach((asset) => {
      expect(asset.version).toBe(1);
      expect(asset.availableVersions).toEqual([1]);
    });
  });

  it("filters by assetType", async () => {
    const res = await request(app)
      .get("/api/v1/assets?assetType=Prompt")
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
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

  it("full-text searches across name and description", async () => {
    const res = await request(app)
      .get("/api/v1/assets?search=financial")
      .expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].name).toMatch(/financial/i);
  });

  it("filters by price range", async () => {
    const res = await request(app)
      .get("/api/v1/assets?minPrice=1000000&maxPrice=10000000")
      .expect(200);
    res.body.data.forEach((a) => {
      expect(a.price).toBeGreaterThanOrEqual(1_000_000);
      expect(a.price).toBeLessThanOrEqual(10_000_000);
    });
  });
});

describe("GET /api/v1/assets/:id", () => {
  it("returns an asset by id", async () => {
    const res = await request(app).get("/api/v1/assets/1").expect(200);
    expect(res.body.id).toBe(1);
    expect(res.body.version).toBe(1);
    expect(res.body.availableVersions).toEqual([1]);
  });

  it("returns 404 for unknown id", async () => {
    await request(app).get("/api/v1/assets/99999").expect(404);
  });
});

describe("POST /api/v1/assets", () => {
  it("indexes a new asset and persists it", async () => {
    const payload = {
      id: 900,
      owner: OWNER_B,
      name: "Persistence Test Asset",
      description: "Should survive a process restart now that we have Postgres.",
      assetType: "Dataset",
      licenseType: "OpenSource",
      price: 0,
      version: 3,
      tags: ["persistence", "postgres"],
    };

    const created = await request(app)
      .post("/api/v1/assets")
      .send(payload)
      .expect(201);
    expect(created.body.id).toBe(900);
    expect(created.body.version).toBe(3);
    expect(created.body.availableVersions).toEqual([1, 2, 3]);

    const fetched = await request(app).get("/api/v1/assets/900").expect(200);
    expect(fetched.body.name).toBe("Persistence Test Asset");
    expect(fetched.body.tags).toEqual(["persistence", "postgres"]);
  });

  it("rejects invalid payloads", async () => {
    await request(app)
      .post("/api/v1/assets")
      .send({ id: 901, name: "incomplete" })
      .expect(422);
  });

  it("rejects an owner with an invalid checksum, naming the field", async () => {
    const res = await request(app)
      .post("/api/v1/assets")
      .send({
        id: 902,
        owner: BAD_CHECKSUM_KEY,
        name: "Bad Owner Asset",
        description: "Should fail validation before reaching the DB.",
        assetType: "Dataset",
        licenseType: "OpenSource",
        price: 0,
      })
      .expect(422);

    expect(res.body.details.some((d) => d.path === "owner")).toBe(true);
  });
});

describe("POST /api/v1/assets/:id/purchase", () => {
  it("purchases a license and increments usage count atomically", async () => {
    const before = await request(app).get("/api/v1/assets/2").expect(200);

    const res = await request(app)
      .post("/api/v1/assets/2/purchase")
      .send({ buyer: OWNER_B })
      .expect(201);

    expect(res.body.license.assetId).toBe(2);
    expect(res.body.license.buyer).toBe(OWNER_B);
    expect(res.body.usageCount).toBe(before.body.usageCount + 1);
  });

  it("rejects a duplicate active license with 409", async () => {
    await request(app)
      .post("/api/v1/assets/2/purchase")
      .send({ buyer: OWNER_B })
      .expect(409);
  });

  it("returns 404 when the asset does not exist", async () => {
    await request(app)
      .post("/api/v1/assets/424242/purchase")
      .send({ buyer: OWNER_B })
      .expect(404);
  });

  it("validates the buyer address", async () => {
    await request(app)
      .post("/api/v1/assets/2/purchase")
      .send({ buyer: "too-short" })
      .expect(422);
  });

  it("rejects a buyer with the right length but an invalid checksum", async () => {
    const res = await request(app)
      .post("/api/v1/assets/2/purchase")
      .send({ buyer: BAD_CHECKSUM_KEY })
      .expect(422);

    expect(res.body.details.some((d) => d.path === "buyer")).toBe(true);
  });

  it("defaults an omitted assetVersion to the current version", async () => {
    const asset = await createVersionedAsset(920);
    const res = await request(app)
      .post(`/api/v1/assets/${asset.id}/purchase`)
      .send({ buyer: OWNER_B })
      .expect(201);

    expect(res.body.license.assetVersion).toBe(7);
  });

  it("purchases the current version explicitly", async () => {
    const asset = await createVersionedAsset(921);
    const res = await request(app)
      .post(`/api/v1/assets/${asset.id}/purchase`)
      .send({ buyer: OWNER_B, assetVersion: 7 })
      .expect(201);

    expect(res.body.license.assetVersion).toBe(7);
  });

  it("purchases a retained historical version using current terms", async () => {
    const asset = await createVersionedAsset(922, {
      licenseType: "Subscription",
      price: 8_765_432,
    });
    const res = await request(app)
      .post(`/api/v1/assets/${asset.id}/purchase`)
      .send({ buyer: OWNER_B, assetVersion: 3 })
      .expect(201);

    expect(res.body.license.assetVersion).toBe(3);
    expect(res.body.license.pricePaid).toBe(8_765_432);
    expect(res.body.license.licenseType).toBe("Subscription");

    const stored = await licenseRepository.findByBuyerAndAsset(
      OWNER_B,
      asset.id
    );
    expect(stored.assetVersion).toBe(3);
  });

  it.each([
    [0, "zero"],
    [-1, "negative"],
    [1.5, "non-integer number"],
    ["3", "numeric string"],
  ])("rejects %s as a %s assetVersion", async (assetVersion) => {
    await request(app)
      .post("/api/v1/assets/923/purchase")
      .send({ buyer: OWNER_B, assetVersion })
      .expect(422);
  });

  it("rejects a future asset version", async () => {
    const asset = await createVersionedAsset(924);
    const res = await request(app)
      .post(`/api/v1/assets/${asset.id}/purchase`)
      .send({ buyer: OWNER_B, assetVersion: 8 })
      .expect(400);
    expect(res.body.error).toMatch(/newer than current/i);
  });

  it("rejects an evicted asset version", async () => {
    const asset = await createVersionedAsset(925);
    const res = await request(app)
      .post(`/api/v1/assets/${asset.id}/purchase`)
      .send({ buyer: OWNER_B, assetVersion: 2 })
      .expect(400);
    expect(res.body.error).toMatch(/unavailable/i);
  });
});

describe("GET /api/v1/assets/types/list", () => {
  it("returns asset types and license types", async () => {
    const res = await request(app).get("/api/v1/assets/types/list").expect(200);
    expect(Array.isArray(res.body.assetTypes)).toBe(true);
    expect(Array.isArray(res.body.licenseTypes)).toBe(true);
  });
});
