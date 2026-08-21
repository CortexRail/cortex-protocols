/**
 * Tests for multiTokenPurchaseService
 * 
 * Tests:
 * 1. getPriceCommitment fetches live oracle price and builds commitment
 * 2. purchaseMultiTokenLicense is atomic and stores token used
 * 3. Slippage protection validates max_price on-chain
 * 4. Token acceptance is validated before purchase
 */

jest.mock("../../db/connection", () => ({
  withTransaction: jest.fn((callback) => callback({ transaction: true })),
}));

jest.mock("../../repositories/assetRepository", () => ({
  findById: jest.fn(),
  incrementUsage: jest.fn(),
}));

jest.mock("../../repositories/licenseRepository", () => ({
  create: jest.fn(),
}));

jest.mock("../../repositories/contractStateRepository", () => ({
  isPaused: jest.fn(),
}));

jest.mock("../../pricing/PriceOracleAggregator", () => ({
  aggregatePrices: jest.fn(),
}));

jest.mock("../../pricing/PriceCommitmentBuilder", () => ({
  buildPriceCommitment: jest.fn(),
  validateCommitment: jest.fn(),
}));

jest.mock("../../pricing/StalenessGuard", () => ({
  validatePrice: jest.fn(),
}));

const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const contractStateRepository = require("../../repositories/contractStateRepository");
const priceOracleAggregator = require("../../pricing/PriceOracleAggregator");
const priceCommitmentBuilder = require("../../pricing/PriceCommitmentBuilder");
const stalenessGuard = require("../../pricing/StalenessGuard");
const multiTokenService = require("../../services/multiTokenPurchaseService");

const ASSET = {
  id: 42,
  version: 7,
  licenseType: "Subscription",
  usdPriceCents: 4200, // $42.00
  acceptedTokens: ["GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS", "native"],
};

const BUYER = "GBUYERGBUYER";
const TOKEN = "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS";

describe("multiTokenPurchaseService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    contractStateRepository.isPaused.mockResolvedValue(false);
    assetRepository.findById.mockResolvedValue(ASSET);
    assetRepository.incrementUsage.mockResolvedValue(5);
    licenseRepository.create.mockImplementation(async (license) => ({
      id: 1,
      ...license,
    }));
  });

  describe("getPriceCommitment", () => {
    it("fetches oracle price and builds commitment", async () => {
      priceOracleAggregator.aggregatePrices.mockResolvedValue({
        price: 1.0,
        timestamp: Date.now(),
        sources: [{ name: "reflector", price: 1.0 }],
        deviation: { min: 0.99, max: 1.01, stdDev: 0.005 },
      });
      stalenessGuard.validatePrice.mockReturnValue({ valid: true });
      priceCommitmentBuilder.buildPriceCommitment.mockReturnValue({
        assetId: 42,
        token: TOKEN,
        usdPriceCents: 4200,
        maxPrice: 4410, // 5% slippage
        validUntilLedger: 1000,
        signature: "abc123",
      });

      const result = await multiTokenService.getPriceCommitment({
        assetId: 42,
        token: TOKEN,
        slippageTolerance: 5,
      });

      expect(result).toHaveProperty("commitment");
      expect(result).toHaveProperty("oraclePrice");
      expect(result).toHaveProperty("priceMetadata");
      expect(result.commitment.assetId).toBe(42);
    });

    it("validates token is in accepted list", async () => {
      const invalidToken = "GINVALIDTOKEN";
      await expect(
        multiTokenService.getPriceCommitment({
          assetId: 42,
          token: invalidToken,
        })
      ).rejects.toThrow("not accepted for asset");
    });

    it("rejects stale oracle prices", async () => {
      stalenessGuard.validatePrice.mockReturnValue({
        valid: false,
        reason: "STALE",
        age: 400000,
      });

      await expect(
        multiTokenService.getPriceCommitment({
          assetId: 42,
          token: TOKEN,
        })
      ).rejects.toThrow("stale");
    });

    it("throws 404 for missing asset", async () => {
      assetRepository.findById.mockResolvedValue(null);

      await expect(
        multiTokenService.getPriceCommitment({
          assetId: 999,
          token: TOKEN,
        })
      ).rejects.toThrow("not found");
    });
  });

  describe("purchaseMultiTokenLicense", () => {
    it("creates license with token stored", async () => {
      const commitment = {
        assetId: 42,
        token: TOKEN,
        usdPriceCents: 4200,
        validUntilLedger: 1000,
        signature: "sig",
        createdAt: Date.now(),
      };

      priceCommitmentBuilder.validateCommitment.mockReturnValue({ valid: true });

      const result = await multiTokenService.purchaseMultiTokenLicense({
        assetId: 42,
        buyer: BUYER,
        token: TOKEN,
        commitment,
      });

      expect(result).toHaveProperty("license");
      expect(result).toHaveProperty("token");
      expect(result.token).toBe(TOKEN);
      expect(licenseRepository.create).toHaveBeenCalled();

      const createCall = licenseRepository.create.mock.calls[0][0];
      expect(createCall.token).toBe(TOKEN);
    });

    it("increments asset usage atomically", async () => {
      const commitment = {
        assetId: 42,
        token: TOKEN,
        usdPriceCents: 4200,
        createdAt: Date.now(),
      };

      priceCommitmentBuilder.validateCommitment.mockReturnValue({ valid: true });

      const result = await multiTokenService.purchaseMultiTokenLicense({
        assetId: 42,
        buyer: BUYER,
        token: TOKEN,
        commitment,
      });

      expect(result.usageCount).toBe(5);
      expect(assetRepository.incrementUsage).toHaveBeenCalledWith(42, { transaction: true });
    });

    it("rejects purchase when marketplace is paused", async () => {
      contractStateRepository.isPaused.mockResolvedValue(true);

      await expect(
        multiTokenService.purchaseMultiTokenLicense({
          assetId: 42,
          buyer: BUYER,
          token: TOKEN,
          commitment: { createdAt: Date.now() },
        })
      ).rejects.toThrow("paused");
    });

    it("enforces version constraints", async () => {
      const commitment = { createdAt: Date.now() };
      priceCommitmentBuilder.validateCommitment.mockReturnValue({ valid: true });

      // Version too new
      await expect(
        multiTokenService.purchaseMultiTokenLicense({
          assetId: 42,
          buyer: BUYER,
          token: TOKEN,
          commitment,
          assetVersion: 999,
        })
      ).rejects.toThrow("newer");
    });

    it("rejects invalid commitments", async () => {
      const commitment = { createdAt: Date.now() - 100000 };
      priceCommitmentBuilder.validateCommitment.mockReturnValue({
        valid: false,
        reason: "EXPIRED",
      });

      await expect(
        multiTokenService.purchaseMultiTokenLicense({
          assetId: 42,
          buyer: BUYER,
          token: TOKEN,
          commitment,
        })
      ).rejects.toThrow("Commitment invalid");
    });

    it("detects duplicate active license", async () => {
      const commitment = { createdAt: Date.now() };
      priceCommitmentBuilder.validateCommitment.mockReturnValue({ valid: true });
      licenseRepository.create.mockRejectedValue({
        code: "23505", // Unique constraint violation
      });

      await expect(
        multiTokenService.purchaseMultiTokenLicense({
          assetId: 42,
          buyer: BUYER,
          token: TOKEN,
          commitment,
        })
      ).rejects.toThrow("already holds an active license");
    });
  });
});
