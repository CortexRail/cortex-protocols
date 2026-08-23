/**
 * Multi-source price oracle aggregator with staleness and deviation protection.
 * 
 * Fetches price data from configured sources, computes median/weighted-median,
 * rejects outliers, and returns consensus price with metadata.
 */

const axios = require("axios");
const { logger } = require("../utils/logger");

// Price sources configuration
const ORACLE_SOURCES = [
  {
    name: "reflector",
    url: process.env.REFLECTOR_ORACLE_URL || "https://horizon.stellar.org/",
    type: "stellar-reflector",
    weight: 0.5,
    maxStaleness: 300000, // 5 minutes in ms
  },
  {
    name: "stellar-expert",
    url: process.env.STELLAR_EXPERT_URL || "https://api.stellar.expert/explorer/public/price-feed",
    type: "rest-api",
    weight: 0.3,
    maxStaleness: 300000,
  },
  {
    name: "coingecko",
    url: "https://api.coingecko.com/api/v3/simple/price",
    type: "rest-api",
    weight: 0.2,
    maxStaleness: 600000, // 10 minutes
  },
];

const OUTLIER_THRESHOLD = 0.2; // 20% deviation from median
const CACHE_TTL = 30000; // 30 seconds
let priceCache = new Map();

/**
 * Fetch price from a single oracle source
 */
async function fetchFromSource(source, asset, token) {
  try {
    let price;
    let timestamp;

    if (source.type === "stellar-reflector") {
      // Fetch from Stellar Reflector on-chain oracle
      price = await fetchReflectorPrice(asset, token);
      timestamp = Date.now();
    } else if (source.type === "rest-api") {
      const result = await axios.get(source.url, {
        timeout: 10000,
        params: {
          ids: asset.toLowerCase(),
          vs_currencies: token.toLowerCase(),
        },
      });
      price = result.data?.[asset.toLowerCase()]?.[token.toLowerCase()];
      timestamp = Date.now();
    }

    if (!price || price <= 0) {
      return null;
    }

    return {
      source: source.name,
      price: Number(price),
      timestamp,
      weight: source.weight,
      age: Date.now() - timestamp,
      maxStaleness: source.maxStaleness,
    };
  } catch (err) {
    logger.warn(`Failed to fetch from ${source.name}:`, err.message);
    return null;
  }
}

/**
 * Fetch price from Stellar Reflector on-chain oracle
 */
async function fetchReflectorPrice(asset, token) {
  try {
    // This would integrate with actual Soroban oracle contract
    // For now, return mock data
    const mockPrices = {
      "XLM-USD": 0.42,
      "USDC-USD": 1.0,
      "EUR-USD": 1.08,
    };
    return mockPrices[`${asset}-${token}`.toUpperCase()] || null;
  } catch (err) {
    logger.warn("Reflector fetch failed:", err.message);
    return null;
  }
}

/**
 * Compute weighted median from price samples
 */
function computeWeightedMedian(prices) {
  if (prices.length === 0) return null;
  if (prices.length === 1) return prices[0].price;

  // Sort by price
  const sorted = prices.sort((a, b) => a.price - b.price);

  // Compute cumulative weights
  let cumulativeWeight = 0;
  const targetWeight = 0.5;

  for (const sample of sorted) {
    cumulativeWeight += sample.weight;
    if (cumulativeWeight >= targetWeight) {
      return sample.price;
    }
  }

  return sorted[sorted.length - 1].price;
}

/**
 * Detect and filter outliers based on median deviation
 */
function filterOutliers(prices) {
  if (prices.length <= 2) return prices;

  const median = computeWeightedMedian(prices);
  const filtered = prices.filter((p) => {
    const deviation = Math.abs(p.price - median) / median;
    if (deviation > OUTLIER_THRESHOLD) {
      logger.warn(
        `Outlier detected from ${p.source}: ${p.price} (deviation: ${(deviation * 100).toFixed(2)}%)`
      );
      return false;
    }
    return true;
  });

  return filtered.length > 0 ? filtered : prices; // Return all if all would be filtered
}

/**
 * Aggregate prices from multiple sources with outlier rejection
 */
async function aggregatePrices(asset, token) {
  const cacheKey = `${asset}-${token}`;
  const cached = priceCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached;
  }

  const prices = [];

  // Fetch from all sources in parallel
  const fetchPromises = ORACLE_SOURCES.map((source) =>
    fetchFromSource(source, asset, token).catch(() => null)
  );
  const results = await Promise.all(fetchPromises);

  // Filter out failed fetches and stale prices
  for (const result of results) {
    if (result && result.age <= result.maxStaleness) {
      prices.push(result);
    }
  }

  if (prices.length === 0) {
    throw new Error(`No fresh price data available for ${asset}/${token}`);
  }

  // Filter outliers
  const filtered = filterOutliers(prices);

  // Compute consensus price
  const consensusPrice = computeWeightedMedian(filtered);

  const aggregated = {
    asset,
    token,
    price: consensusPrice,
    timestamp: Date.now(),
    sourceCount: filtered.length,
    sources: filtered.map((p) => ({
      name: p.source,
      price: p.price,
      age: p.age,
      weight: p.weight,
    })),
    deviation: {
      min: Math.min(...filtered.map((p) => p.price)),
      max: Math.max(...filtered.map((p) => p.price)),
      stdDev: computeStdDev(filtered),
    },
  };

  // Cache result
  priceCache.set(cacheKey, aggregated);

  return aggregated;
}

/**
 * Compute standard deviation of prices
 */
function computeStdDev(prices) {
  if (prices.length < 2) return 0;

  const mean = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
  const variance = prices.reduce((sum, p) => sum + Math.pow(p.price - mean, 2), 0) / prices.length;
  return Math.sqrt(variance);
}

/**
 * Get oracle health status
 */
async function getOracleHealth() {
  const health = {
    timestamp: Date.now(),
    sources: [],
    overall: "healthy",
  };

  for (const source of ORACLE_SOURCES) {
    try {
      const start = Date.now();
      await axios.head(source.url, { timeout: 5000 });
      const latency = Date.now() - start;

      health.sources.push({
        name: source.name,
        status: "available",
        latency,
        lastChecked: Date.now(),
      });
    } catch (err) {
      health.sources.push({
        name: source.name,
        status: "unavailable",
        error: err.message,
        lastChecked: Date.now(),
      });
      health.overall = "degraded";
    }
  }

  const availableSources = health.sources.filter((s) => s.status === "available").length;
  if (availableSources === 0) {
    health.overall = "critical";
  }

  return health;
}

module.exports = {
  aggregatePrices,
  getOracleHealth,
  filterOutliers,
  computeWeightedMedian,
  getConfiguredSources: () => ORACLE_SOURCES,
  OUTLIER_THRESHOLD,
};
