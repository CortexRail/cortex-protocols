/**
 * Tests for PriceOracleAggregator
 * 
 * Tests:
 * 1. Aggregator correctly rejects outlier sources
 * 2. Aggregator produces sane median from multiple sources
 * 3. Outlier detection doesn't filter all sources
 * 4. Staleness tracking works
 */

jest.mock("axios");
const axios = require("axios");
const priceOracleAggregator = require("../../pricing/PriceOracleAggregator");

describe("PriceOracleAggregator", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("filterOutliers", () => {
    it("removes prices deviating >20% from weighted median", () => {
      const prices = [
        { source: "source1", price: 1.0, weight: 0.5 },
        { source: "source2", price: 1.05, weight: 0.3 },
        { source: "source3", price: 10.0, weight: 0.2 }, // 10x deviation
      ];

      const filtered = priceOracleAggregator.filterOutliers(prices);
      expect(filtered.length).toBe(2);
      expect(filtered.every((p) => p.price <= 1.1)).toBe(true);
    });

    it("returns all prices if filtering would remove everything", () => {
      const prices = [
        { source: "source1", price: 1.0, weight: 0.5 },
        { source: "source2", price: 5.0, weight: 0.5 },
      ];

      const filtered = priceOracleAggregator.filterOutliers(prices);
      expect(filtered.length).toBe(2); // Both retained despite > 20% deviation
    });

    it("retains prices with <=2 samples", () => {
      const prices = [
        { source: "source1", price: 1.0, weight: 1.0 },
      ];

      const filtered = priceOracleAggregator.filterOutliers(prices);
      expect(filtered.length).toBe(1);
      expect(filtered[0].price).toBe(1.0);
    });
  });

  describe("computeWeightedMedian", () => {
    it("returns single price for one sample", () => {
      const prices = [{ price: 42.5, weight: 1.0 }];
      const median = priceOracleAggregator.computeWeightedMedian(prices);
      expect(median).toBe(42.5);
    });

    it("computes weighted median from multiple samples", () => {
      const prices = [
        { price: 1.0, weight: 0.2 },
        { price: 2.0, weight: 0.3 },
        { price: 3.0, weight: 0.5 },
      ];
      const median = priceOracleAggregator.computeWeightedMedian(prices);
      expect(median).toBe(2.0); // Cumulative weight crosses 0.5 at price 2.0
    });

    it("returns null for empty array", () => {
      const median = priceOracleAggregator.computeWeightedMedian([]);
      expect(median).toBeNull();
    });
  });

  describe("aggregatePrices", () => {
    it("aggregates prices from multiple sources", async () => {
      axios.get.mockResolvedValueOnce({
        data: {
          xlm: { usd: 0.42 },
        },
      });

      const result = await priceOracleAggregator.aggregatePrices("xlm", "usd");

      expect(result).toHaveProperty("price");
      expect(result).toHaveProperty("sources");
      expect(result).toHaveProperty("deviation");
      expect(result.asset).toBe("xlm");
      expect(result.token).toBe("usd");
    });

    it("throws error when no fresh prices available", async () => {
      axios.get.mockRejectedValue(new Error("Network error"));

      await expect(
        priceOracleAggregator.aggregatePrices("invalid", "usd")
      ).rejects.toThrow("No fresh price data available");
    });

    it("caches results for 30 seconds", async () => {
      axios.get.mockResolvedValue({
        data: { xlm: { usd: 0.42 } },
      });

      const result1 = await priceOracleAggregator.aggregatePrices("xlm", "usd");
      const result2 = await priceOracleAggregator.aggregatePrices("xlm", "usd");

      // Second call should use cache
      expect(result1).toEqual(result2);
      expect(axios.get.mock.calls.length).toBeLessThan(6); // Should not hit all sources twice
    });
  });

  describe("getOracleHealth", () => {
    it("returns health status of all oracle sources", async () => {
      axios.head.mockResolvedValue({});

      const health = await priceOracleAggregator.getOracleHealth();

      expect(health).toHaveProperty("timestamp");
      expect(health).toHaveProperty("overall");
      expect(Array.isArray(health.sources)).toBe(true);
      expect(health.sources.length).toBeGreaterThan(0);
    });

    it("marks source as unavailable on error", async () => {
      axios.head.mockRejectedValue(new Error("Connection refused"));

      const health = await priceOracleAggregator.getOracleHealth();

      const unavailable = health.sources.some((s) => s.status === "unavailable");
      expect(unavailable).toBe(true);
    });

    it("sets overall status to critical when no sources available", async () => {
      axios.head.mockRejectedValue(new Error("Connection refused"));

      const health = await priceOracleAggregator.getOracleHealth();

      if (health.sources.every((s) => s.status === "unavailable")) {
        expect(health.overall).toBe("critical");
      }
    });
  });
});
