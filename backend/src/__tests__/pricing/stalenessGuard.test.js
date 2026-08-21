/**
 * Tests for StalenessGuard
 * 
 * Tests:
 * 1. Freshness validation based on age
 * 2. Staleness detection approaching max age
 * 3. Source health tracking
 * 4. Fallback decision logic
 */

const stalenessGuard = require("../../pricing/StalenessGuard");

describe("StalenessGuard", () => {
  beforeEach(() => {
    // Reset singleton state between tests
    stalenessGuard.sourceHealth.clear();
    stalenessGuard.fallbackAttempts.clear();
  });

  describe("isFresh", () => {
    it("returns true for recent prices", () => {
      const price = { timestamp: Date.now() - 30000 }; // 30 seconds old
      expect(stalenessGuard.isFresh(price)).toBe(true);
    });

    it("returns false for stale prices", () => {
      const price = { timestamp: Date.now() - 400000 }; // 400 seconds old
      expect(stalenessGuard.isFresh(price)).toBe(false);
    });

    it("respects custom maxAge", () => {
      const price = { timestamp: Date.now() - 10000 }; // 10 seconds old
      expect(stalenessGuard.isFresh(price, 5000)).toBe(false); // 5 second max
      expect(stalenessGuard.isFresh(price, 15000)).toBe(true); // 15 second max
    });
  });

  describe("isStale", () => {
    it("detects prices approaching staleness", () => {
      const price = { timestamp: Date.now() - 200000 }; // 200 seconds old (3+ min)
      expect(stalenessGuard.isStale(price)).toBe(true);
    });

    it("returns false for fresh prices", () => {
      const price = { timestamp: Date.now() - 30000 }; // 30 seconds old
      expect(stalenessGuard.isStale(price)).toBe(false);
    });
  });

  describe("validatePrice", () => {
    it("validates fresh prices as valid", () => {
      const price = { timestamp: Date.now() - 30000 };
      const source = { name: "test-source" };
      const result = stalenessGuard.validatePrice(price, source);

      expect(result.valid).toBe(true);
      expect(result.reason).toBe("FRESH");
    });

    it("rejects stale prices", () => {
      const price = { timestamp: Date.now() - 400000 };
      const source = { name: "test-source" };
      const result = stalenessGuard.validatePrice(price, source);

      expect(result.valid).toBe(false);
      expect(result.reason).toBe("STALE");
    });

    it("flags approaching-staleness prices", () => {
      const price = { timestamp: Date.now() - 200000 };
      const source = { name: "test-source" };
      const result = stalenessGuard.validatePrice(price, source);

      expect(result.staleSoon).toBe(true);
    });

    it("records health metrics", () => {
      const price = { timestamp: Date.now() - 30000 };
      const source = { name: "reflector" };
      stalenessGuard.validatePrice(price, source);

      const health = stalenessGuard.getSourceHealth("reflector");
      expect(health.sampleCount).toBeGreaterThan(0);
      expect(health.freshCount).toBe(1);
    });
  });

  describe("shouldUseFallback", () => {
    it("returns true for stale prices", () => {
      const price = { timestamp: Date.now() - 400000 };
      const source = { name: "test-source" };
      expect(stalenessGuard.shouldUseFallback(price, source)).toBe(true);
    });

    it("returns true for approaching-staleness prices", () => {
      const price = { timestamp: Date.now() - 200000 };
      const source = { name: "test-source" };
      expect(stalenessGuard.shouldUseFallback(price, source)).toBe(true);
    });

    it("returns false for fresh prices", () => {
      const price = { timestamp: Date.now() - 30000 };
      const source = { name: "test-source" };
      expect(stalenessGuard.shouldUseFallback(price, source)).toBe(false);
    });
  });

  describe("getSourceHealth", () => {
    it("returns healthy status for sources with good samples", () => {
      const price = { timestamp: Date.now() - 30000 };
      const source = { name: "good-source" };
      stalenessGuard.validatePrice(price, source);

      const health = stalenessGuard.getSourceHealth("good-source");
      expect(health.status).toBe("healthy");
      expect(health.freshCount).toBeGreaterThan(0);
    });

    it("returns unknown status for unseen sources", () => {
      const health = stalenessGuard.getSourceHealth("nonexistent");
      expect(health.status).toBe("unknown");
      expect(health.sampleCount).toBe(0);
    });

    it("returns degraded status when failure rate > 50%", () => {
      const source = { name: "degraded-source" };
      // Record multiple failures
      for (let i = 0; i < 3; i++) {
        stalenessGuard.recordFailure("degraded-source");
      }
      // Record one success
      stalenessGuard.validatePrice({ timestamp: Date.now() - 30000 }, source);

      const health = stalenessGuard.getSourceHealth("degraded-source");
      expect(health.failureRate).toBeDefined();
    });
  });

  describe("recordFailure", () => {
    it("increments failure count for a source", () => {
      stalenessGuard.recordFailure("test-source");
      stalenessGuard.recordFailure("test-source");

      const health = stalenessGuard.getSourceHealth("test-source");
      expect(health.sampleCount).toBeDefined();
    });
  });

  describe("getAllSourceHealth", () => {
    it("returns health for all configured sources", () => {
      const allHealth = stalenessGuard.getAllSourceHealth();
      expect(Array.isArray(allHealth)).toBe(true);
      expect(allHealth.length).toBeGreaterThan(0);
      expect(allHealth[0]).toHaveProperty("source");
      expect(allHealth[0]).toHaveProperty("status");
    });
  });
});
