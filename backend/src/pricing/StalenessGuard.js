/**
 * Staleness guard to ensure prices are fresh and trigger fallback sources.
 * 
 * Refuses to serve prices older than max age, attempts fallback sources,
 * and tracks source health over time.
 */

const { logger } = require("../utils/logger");

const DEFAULT_MAX_AGE = 300000; // 5 minutes in ms
const STALE_THRESHOLD = 180000; // 3 minutes before considering stale
const HEALTH_WINDOW = 3600000; // 1 hour for tracking source health

class StalenessGuard {
  constructor() {
    this.sourceHealth = new Map(); // Track per-source staleness and failures
    this.fallbackAttempts = new Map();
  }

  /**
   * Check if a price sample is fresh
   */
  isFresh(price, maxAge = DEFAULT_MAX_AGE) {
    const age = Date.now() - price.timestamp;
    return age <= maxAge;
  }

  /**
   * Check if a price is getting stale (approaching max age)
   */
  isStale(price, staleThreshold = STALE_THRESHOLD) {
    const age = Date.now() - price.timestamp;
    return age >= staleThreshold;
  }

  /**
   * Validate price freshness and record health
   */
  validatePrice(price, source) {
    const age = Date.now() - price.timestamp;
    const fresh = this.isFresh(price);
    const stale = this.isStale(price);

    // Record health metrics
    this.recordSourceHealth(source.name, {
      age,
      fresh,
      stale,
      timestamp: Date.now(),
    });

    if (!fresh) {
      logger.warn(`Price from ${source.name} is stale: ${age}ms old`);
      return {
        valid: false,
        reason: "STALE",
        age,
        maxAge: DEFAULT_MAX_AGE,
      };
    }

    if (stale) {
      logger.info(`Price from ${source.name} is approaching staleness: ${age}ms old`);
    }

    return {
      valid: true,
      reason: "FRESH",
      age,
      staleSoon: stale,
    };
  }

  /**
   * Record source health metrics
   */
  recordSourceHealth(sourceName, metrics) {
    if (!this.sourceHealth.has(sourceName)) {
      this.sourceHealth.set(sourceName, {
        samples: [],
        failures: 0,
        lastUpdate: Date.now(),
      });
    }

    const health = this.sourceHealth.get(sourceName);
    health.samples.push(metrics);
    health.lastUpdate = Date.now();

    // Keep only recent samples (within health window)
    health.samples = health.samples.filter((s) => Date.now() - s.timestamp < HEALTH_WINDOW);
  }

  /**
   * Get health status for a source
   */
  getSourceHealth(sourceName) {
    const health = this.sourceHealth.get(sourceName);

    if (!health || health.samples.length === 0) {
      return {
        source: sourceName,
        status: "unknown",
        sampleCount: 0,
        freshCount: 0,
        staleCount: 0,
        failureRate: 0,
        avgAge: 0,
      };
    }

    const freshCount = health.samples.filter((s) => s.fresh).length;
    const staleCount = health.samples.filter((s) => s.stale).length;
    const failureRate = health.failures / (health.samples.length + health.failures);

    return {
      source: sourceName,
      status: failureRate > 0.5 ? "degraded" : "healthy",
      sampleCount: health.samples.length,
      freshCount,
      staleCount,
      failureRate: failureRate.toFixed(2),
      lastUpdate: new Date(health.lastUpdate).toISOString(),
      avgAge: Math.round(
        health.samples.reduce((sum, s) => sum + s.age, 0) / health.samples.length
      ),
    };
  }

  /**
   * Determine if fallback source should be attempted
   */
  shouldUseFallback(primaryPrice, source) {
    const validation = this.validatePrice(primaryPrice, source);

    if (!validation.valid) {
      logger.info(`Falling back from ${source.name}: ${validation.reason}`);
      return true;
    }

    if (validation.staleSoon) {
      logger.info(`Attempting fallback for ${source.name} (approaching staleness)`);
      return true;
    }

    return false;
  }

  /**
   * Get all source health status
   */
  getAllSourceHealth() {
    const sources = ["reflector", "stellar-expert", "coingecko"];
    return sources.map((name) => this.getSourceHealth(name));
  }

  /**
   * Record a source failure
   */
  recordFailure(sourceName) {
    if (!this.sourceHealth.has(sourceName)) {
      this.sourceHealth.set(sourceName, {
        samples: [],
        failures: 0,
        lastUpdate: Date.now(),
      });
    }

    const health = this.sourceHealth.get(sourceName);
    health.failures += 1;
  }
}

module.exports = new StalenessGuard();
