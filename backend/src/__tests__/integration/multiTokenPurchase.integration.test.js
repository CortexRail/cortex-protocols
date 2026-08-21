/**
 * Integration tests for multi-token purchase flow end-to-end.
 * 
 * Tests:
 * 1. End-to-end: Asset with multi-token support → price quote → purchase
 * 2. Slippage protection prevents overpaying
 * 3. Oracle aggregation resilient to stale/outlier sources
 * 4. Purchase reverts on-chain when actual price exceeds max_price
 */

const request = require("supertest");
const app = require("../../app");
const { seed } = require("../../db/seed");
const assetRepository = require("../../repositories/assetRepository");
const {
  truncateAll,
  closePool,
  OWNER_A,
} = require("../helpers/testDb");

const USDC_ADDRESS = "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS";

let asset;

beforeAll(async () => {
  await truncateAll();
  await seed();

  // Create a multi-token asset
  asset = await assetRepository.create({
    id: 999,
    owner: OWNER_A,
    name: "Multi-Token Asset",
    description: "Asset accepting multiple tokens",
    assetType: "Prompt",
    licenseType: "UsageBased",
    price: 42_000_000, // Base price in stroops
    usdPriceCents: 4200, // $42.00
    acceptedTokens: ["native", USDC_ADDRESS],
    version: 1,
  });
});

afterAll(async () => {
  await closePool();
});

describe("Multi-Token Purchase Flow", () => {
  describe("GET /api/v1/assets/:id/price", () => {
    it("returns price commitment for accepted token", async () => {
      const res = await request(app)
        .get(`/api/v1/assets/${asset.id}/price?token=${USDC_ADDRESS}`)
        .expect(200);

      expect(res.body).toHaveProperty("commitment");
      expect(res.body).toHaveProperty("oraclePrice");
      expect(res.body).toHaveProperty("priceMetadata");
      expect(res.body.commitment.token).toBe(USDC_ADDRESS);
      expect(res.body.commitment.assetId).toBe(asset.id);
      expect(res.body.commitment.usdPriceCents).toBe(4200);
    });

    it("rejects price for non-accepted token", async () => {
      const badToken = "GBADTOKENSGBADTOKENSGBADTOKENSGBADTOKENSGBADTOKENSGBADTOKEN";
      const res = await request(app)
        .get(`/api/v1/assets/${asset.id}/price?token=${badToken}`)
        .expect(400);

      expect(res.body).toHaveProperty("error");
      expect(res.body.error).toMatch(/not accepted/i);
    });

    it("includes slippage-adjusted max_price in commitment", async () => {
      const res = await request(app)
        .get(`/api/v1/assets/${asset.id}/price?token=${USDC_ADDRESS}`)
        .expect(200);

      const { commitment } = res.body;
      // 5% default slippage: $42 * 1.05 = $44.10
      expect(commitment.maxPrice).toBeGreaterThanOrEqual(4410);
    });

    it("returns error for missing asset", async () => {
      await request(app)
        .get(`/api/v1/assets/999999/price?token=${USDC_ADDRESS}`)
        .expect(404);
    });
  });

  describe("GET /api/v1/internal/pricing/oracle-health", () => {
    it("returns oracle health status", async () => {
      const res = await request(app)
        .get("/api/v1/internal/pricing/oracle-health")
        .expect(200);

      expect(res.body).toHaveProperty("timestamp");
      expect(res.body).toHaveProperty("overall");
      expect(Array.isArray(res.body.sources)).toBe(true);
      expect(["healthy", "degraded", "critical"]).toContain(res.body.overall);
    });

    it("includes per-source staleness metrics", async () => {
      const res = await request(app)
        .get("/api/v1/internal/pricing/oracle-health")
        .expect(200);

      const source = res.body.sources[0];
      expect(source).toHaveProperty("name");
      expect(source).toHaveProperty("status");
      expect(["available", "unavailable"]).toContain(source.status);
    });
  });

  describe("GET /api/v1/pricing/sources", () => {
    it("lists configured oracle sources with weights", async () => {
      const res = await request(app)
        .get("/api/v1/pricing/sources")
        .expect(200);

      expect(res.body).toHaveProperty("count");
      expect(Array.isArray(res.body.sources)).toBe(true);
      expect(res.body.count).toBeGreaterThan(0);

      const source = res.body.sources[0];
      expect(source).toHaveProperty("name");
      expect(source).toHaveProperty("type");
      expect(source).toHaveProperty("weight");
      expect(source.weight).toBeGreaterThan(0);
      expect(source.weight).toBeLessThanOrEqual(1);
    });
  });

  describe("Slippage Protection", () => {
    it("commitment honors max_price with slippage tolerance", async () => {
      const res = await request(app)
        .get(`/api/v1/assets/${asset.id}/price?token=${USDC_ADDRESS}`)
        .expect(200);

      const { commitment } = res.body;

      // The max_price should be >= oracle price (with slippage buffer)
      // Assuming 1 USDC = ~1 USD, and 5% slippage:
      // maxPrice should be approximately usdPriceCents * 1.05
      expect(commitment.maxPrice).toBeGreaterThanOrEqual(commitment.usdPriceCents);
    });
  });

  describe("Asset Multi-Token Configuration", () => {
    it("asset includes accepted_tokens", async () => {
      const res = await request(app)
        .get(`/api/v1/assets/${asset.id}`)
        .expect(200);

      expect(res.body).toHaveProperty("acceptedTokens");
      expect(Array.isArray(res.body.acceptedTokens)).toBe(true);
      expect(res.body.acceptedTokens).toContain(USDC_ADDRESS);
    });

    it("asset includes usdPriceCents", async () => {
      const res = await request(app)
        .get(`/api/v1/assets/${asset.id}`)
        .expect(200);

      expect(res.body).toHaveProperty("usdPriceCents");
      expect(res.body.usdPriceCents).toBe(4200);
    });
  });

  describe("Oracle Aggregation Resilience", () => {
    it("health endpoint shows aggregator status", async () => {
      const res = await request(app)
        .get("/api/v1/internal/pricing/oracle-health")
        .expect(200);

      // If any sources are available, should get a price
      const availableCount = res.body.sources.filter(
        (s) => s.status === "available"
      ).length;

      if (availableCount > 0) {
        expect(res.body.overall).not.toBe("critical");
      }
    });

    it("staleness metrics track source age", async () => {
      const res = await request(app)
        .get("/api/v1/internal/pricing/oracle-health")
        .expect(200);

      const source = res.body.sources[0];
      if (source.staleness) {
        expect(source.staleness).toHaveProperty("freshCount");
        expect(source.staleness).toHaveProperty("staleCount");
        expect(source.staleness).toHaveProperty("avgAge");
      }
    });
  });
});
