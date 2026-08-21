/**
 * Tests for PriceCommitmentBuilder
 * 
 * Tests:
 * 1. Commitment correctly calculates max_price with slippage
 * 2. Commitment expiration is set correctly
 * 3. Signature validation works
 * 4. Expired commitments are rejected
 * 5. Basket commitments build multiple items
 */

const priceCommitmentBuilder = require("../../pricing/PriceCommitmentBuilder");

describe("PriceCommitmentBuilder", () => {
  describe("buildPriceCommitment", () => {
    it("builds a valid commitment", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      expect(commitment).toHaveProperty("version");
      expect(commitment).toHaveProperty("assetId");
      expect(commitment).toHaveProperty("token");
      expect(commitment).toHaveProperty("usdPriceCents");
      expect(commitment).toHaveProperty("maxPrice");
      expect(commitment).toHaveProperty("validUntilLedger");
      expect(commitment).toHaveProperty("signature");
      expect(commitment.assetId).toBe(42n);
      expect(commitment.usdPriceCents).toBe(4200n);
    });

    it("applies slippage tolerance to max_price", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 10000, // $100.00
        slippageTolerance: 5, // 5%
      });

      // $100 * 1.05 = $105
      expect(commitment.maxPrice).toBe(10500n);
    });

    it("sets expiration ledger correctly", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
        maxLedgerOffset: 100,
      });

      // validUntilLedger should be current + offset
      expect(commitment.validUntilLedger).toBeGreaterThan(0);
    });

    it("throws on invalid parameters", () => {
      expect(() => {
        priceCommitmentBuilder.buildPriceCommitment({
          // Missing assetId
          token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
          usdPriceCents: 4200,
        });
      }).toThrow();

      expect(() => {
        priceCommitmentBuilder.buildPriceCommitment({
          assetId: 42,
          // Missing token
          usdPriceCents: 4200,
        });
      }).toThrow();

      expect(() => {
        priceCommitmentBuilder.buildPriceCommitment({
          assetId: 42,
          token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
          usdPriceCents: 0, // Invalid price
        });
      }).toThrow();
    });
  });

  describe("signCommitment & validateCommitment", () => {
    it("signs a commitment deterministically", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      const sig1 = commitment.signature;
      
      // Rebuild with same data—should produce same signature
      const commitment2 = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      const sig2 = commitment2.signature;
      expect(sig1).toBe(sig2);
    });

    it("validates a fresh commitment", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      const validation = priceCommitmentBuilder.validateCommitment(commitment);
      expect(validation.valid).toBe(true);
      expect(validation.reason).toBe("VALID");
    });

    it("rejects expired commitments", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      // Manually set old createdAt
      commitment.createdAt = Date.now() - 120 * 1000; // 2 minutes old

      const validation = priceCommitmentBuilder.validateCommitment(commitment);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe("EXPIRED");
    });

    it("rejects tampered commitments", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      // Tamper with the commitment
      commitment.usdPriceCents = 10000n;

      const validation = priceCommitmentBuilder.validateCommitment(commitment);
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe("INVALID_SIGNATURE");
    });

    it("rejects commitments missing signature", () => {
      const validation = priceCommitmentBuilder.validateCommitment({ });
      expect(validation.valid).toBe(false);
      expect(validation.reason).toBe("MISSING_SIGNATURE");
    });
  });

  describe("toContractFormat", () => {
    it("converts commitment to contract format", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      const contractFormat = priceCommitmentBuilder.toContractFormat(commitment);

      expect(contractFormat).toHaveProperty("asset_id");
      expect(contractFormat).toHaveProperty("token");
      expect(contractFormat).toHaveProperty("usd_price_cents");
      expect(contractFormat).toHaveProperty("max_price");
      expect(contractFormat).toHaveProperty("valid_until_ledger");
      expect(contractFormat.asset_id).toBe("42");
    });
  });

  describe("buildBasketCommitments", () => {
    it("builds commitments for multiple items", () => {
      const items = [
        {
          assetId: 1,
          token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
          usdPriceCents: 1000,
        },
        {
          assetId: 2,
          token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
          usdPriceCents: 2000,
        },
      ];

      const basketCommitments = priceCommitmentBuilder.buildBasketCommitments(items);

      expect(basketCommitments.length).toBe(2);
      expect(basketCommitments[0].assetId).toBe(1);
      expect(basketCommitments[1].assetId).toBe(2);
      expect(basketCommitments[0].commitment).toHaveProperty("signature");
    });

    it("skips failed items in basket", () => {
      const items = [
        {
          assetId: 1,
          token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
          usdPriceCents: 1000,
        },
        {
          assetId: 2,
          // Missing token - will fail
          usdPriceCents: 2000,
        },
        {
          assetId: 3,
          token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
          usdPriceCents: 3000,
        },
      ];

      const basketCommitments = priceCommitmentBuilder.buildBasketCommitments(items);

      expect(basketCommitments.length).toBe(2);
      expect(basketCommitments[0].assetId).toBe(1);
      expect(basketCommitments[1].assetId).toBe(3);
    });

    it("throws if all items fail", () => {
      const items = [
        { assetId: 1, usdPriceCents: 1000 }, // Missing token
      ];

      expect(() => {
        priceCommitmentBuilder.buildBasketCommitments(items);
      }).toThrow("Failed to build any valid price commitments");
    });
  });

  describe("COMMITMENT_VALIDITY_SECONDS", () => {
    it("expires commitments after 60 seconds", () => {
      const commitment = priceCommitmentBuilder.buildPriceCommitment({
        assetId: 42,
        token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
        usdPriceCents: 4200,
      });

      // Simulate passing 61 seconds
      commitment.createdAt = Date.now() - 61 * 1000;

      const validation = priceCommitmentBuilder.validateCommitment(commitment);
      expect(validation.valid).toBe(false);
    });
  });
});
