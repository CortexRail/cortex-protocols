jest.mock("../../services/assetService", () => ({
  listAssets: jest.fn(),
  getAsset: jest.fn(),
  indexAsset: jest.fn(),
  ASSET_TYPES: ["Prompt"],
  LICENSE_TYPES: ["Perpetual"],
}));

jest.mock("../../services/licenseService", () => ({
  purchaseLicense: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const assetService = require("../../services/assetService");
const licenseService = require("../../services/licenseService");
const assetsRouter = require("../../routes/assets");
const { errorHandler } = require("../../middleware/errorHandler");

const BUYER = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";
const ASSET = { id: 42, version: 7, availableVersions: [3, 4, 5, 6, 7] };

const app = express();
app.use(express.json());
app.use("/api/v1/assets", assetsRouter);
app.use(errorHandler);

describe("asset version API responses", () => {
  beforeEach(() => jest.clearAllMocks());

  it("includes version data in list responses", async () => {
    assetService.listAssets.mockResolvedValue({
      data: [ASSET],
      meta: { total: 1 },
    });
    const res = await request(app).get("/api/v1/assets").expect(200);
    expect(res.body.data[0]).toMatchObject(ASSET);
  });

  it("includes version data in detail responses", async () => {
    assetService.getAsset.mockResolvedValue(ASSET);
    const res = await request(app).get("/api/v1/assets/42").expect(200);
    expect(res.body).toMatchObject(ASSET);
  });
});

describe("asset version purchase request", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    licenseService.purchaseLicense.mockResolvedValue({
      license: { assetId: 42, assetVersion: 7 },
      usageCount: 1,
    });
  });

  it("passes an omitted assetVersion through for service defaulting", async () => {
    await request(app)
      .post("/api/v1/assets/42/purchase")
      .send({ buyer: BUYER })
      .expect(201);
    expect(licenseService.purchaseLicense).toHaveBeenCalledWith({
      assetId: 42,
      buyer: BUYER,
      assetVersion: undefined,
    });
  });

  it("passes an integer assetVersion to the service", async () => {
    await request(app)
      .post("/api/v1/assets/42/purchase")
      .send({ buyer: BUYER, assetVersion: 3 })
      .expect(201);
    expect(licenseService.purchaseLicense).toHaveBeenCalledWith(
      expect.objectContaining({ assetVersion: 3 })
    );
  });

  it.each([0, -1, 1.5, "3"])(
    "rejects invalid assetVersion %p",
    async (assetVersion) => {
      await request(app)
        .post("/api/v1/assets/42/purchase")
        .send({ buyer: BUYER, assetVersion })
        .expect(422);
      expect(licenseService.purchaseLicense).not.toHaveBeenCalled();
    }
  );
});
