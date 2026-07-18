jest.mock("../../db/connection", () => ({
  withTransaction: jest.fn((callback) => callback({ transaction: true })),
}));

jest.mock("../../repositories/assetRepository", () => ({
  findById: jest.fn(),
  incrementUsage: jest.fn(),
}));

jest.mock("../../repositories/licenseRepository", () => ({
  create: jest.fn(),
  consumeCall: jest.fn(),
  findByBuyerAndAsset: jest.fn(),
  findAllByBuyer: jest.fn(),
  expire: jest.fn(),
}));

const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const { purchaseLicense } = require("../../services/licenseService");

const ASSET = {
  id: 42,
  version: 7,
  licenseType: "Subscription",
  price: 9_876_543,
};

describe("licenseService asset version selection", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    assetRepository.findById.mockResolvedValue(ASSET);
    assetRepository.incrementUsage.mockResolvedValue(12);
    licenseRepository.create.mockImplementation(async (license) => ({
      id: 1,
      ...license,
    }));
  });

  it("defaults an omitted version to the current asset version", async () => {
    const result = await purchaseLicense({ assetId: 42, buyer: "GBUYER" });
    expect(result.license.assetVersion).toBe(7);
  });

  it.each([7, 3])("stores purchasable version %i", async (assetVersion) => {
    const result = await purchaseLicense({
      assetId: 42,
      buyer: "GBUYER",
      assetVersion,
    });
    expect(result.license.assetVersion).toBe(assetVersion);
  });

  it("uses current price and license type for a historical version", async () => {
    const { license } = await purchaseLicense({
      assetId: 42,
      buyer: "GBUYER",
      assetVersion: 3,
    });
    expect(license.pricePaid).toBe(ASSET.price);
    expect(license.licenseType).toBe(ASSET.licenseType);
  });

  it.each([
    [0, /positive integer/i],
    [-1, /positive integer/i],
    [1.5, /positive integer/i],
    [8, /newer than current/i],
    [2, /unavailable/i],
  ])("rejects invalid or unavailable version %s", async (assetVersion, error) => {
    await expect(
      purchaseLicense({ assetId: 42, buyer: "GBUYER", assetVersion })
    ).rejects.toThrow(error);
    expect(assetRepository.incrementUsage).not.toHaveBeenCalled();
    expect(licenseRepository.create).not.toHaveBeenCalled();
  });
});
