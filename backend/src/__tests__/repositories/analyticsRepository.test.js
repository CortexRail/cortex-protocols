const analyticsRepository = require("../../repositories/analyticsRepository");
const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const { truncateAll, closePool, buildAsset, OWNER_A, OWNER_B } = require("../helpers/testDb");

let asset;

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(buildAsset({ licenseType: "UsageBased" }));
});

afterAll(async () => {
  await closePool();
});

describe("analyticsRepository.getRevenueByAssetLicenseType", () => {
  it("groups revenue by license type for one asset", async () => {
    await licenseRepository.create({
      assetId: asset.id,
      buyer: OWNER_B,
      licenseType: "UsageBased",
      pricePaid: 500_000,
      callsRemaining: 100,
    });

    const otherAsset = await assetRepository.create(buildAsset({ licenseType: "Perpetual" }));
    await licenseRepository.create({
      assetId: otherAsset.id,
      buyer: OWNER_A,
      licenseType: "Perpetual",
      pricePaid: 1_000_000,
      callsRemaining: null,
    });

    const rows = await analyticsRepository.getRevenueByAssetLicenseType(asset.id);

    expect(rows).toEqual([{ licenseType: "UsageBased", licenseCount: 1, revenue: 500_000 }]);
  });

  it("sums multiple licenses of the same type and orders by revenue desc", async () => {
    const buyerA = OWNER_A;
    const buyerB = OWNER_B;
    await licenseRepository.create({
      assetId: asset.id,
      buyer: buyerA,
      licenseType: "UsageBased",
      pricePaid: 300_000,
      callsRemaining: 100,
    });
    await licenseRepository.create({
      assetId: asset.id,
      buyer: buyerB,
      licenseType: "UsageBased",
      pricePaid: 200_000,
      callsRemaining: 100,
    });

    const rows = await analyticsRepository.getRevenueByAssetLicenseType(asset.id);
    expect(rows).toEqual([{ licenseType: "UsageBased", licenseCount: 2, revenue: 500_000 }]);
  });

  it("returns an empty array for an asset with no licenses", async () => {
    expect(await analyticsRepository.getRevenueByAssetLicenseType(asset.id)).toEqual([]);
  });
});
