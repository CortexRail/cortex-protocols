const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const Redis = require("ioredis");

const envNumber = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

// Default to in-memory store for tests if no redis URL is provided,
// otherwise use ioredis with fallback to localhost.
let store;
if (process.env.NODE_ENV === "test" && !process.env.REDIS_URL) {
  // express-rate-limit 7+ and 8+ uses memory store by default if `store` is omitted.
  store = undefined;
} else {
  const redisClient = new Redis(process.env.REDIS_URL || "redis://localhost:6379");
  store = new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
  });
}

const defaultPublicReadLimit = envNumber(
  "PUBLIC_READ_LIMIT_MAX",
  process.env.NODE_ENV === "test" ? 100 : 1000,
);
const defaultWriteLimit = envNumber(
  "WRITE_LIMIT_MAX",
  process.env.NODE_ENV === "test" ? 10 : 60,
);

/**
 * publicReadLimiter
 * Limit for public read endpoints (e.g. GET /assets, GET /agents).
 * Default is intentionally generous in non-test environments so a burst of
 * real-world traffic does not trip a 429 before the DB layer can answer.
 */
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: defaultPublicReadLimit,
  standardHeaders: true,
  legacyHeaders: false,
  store,
});

/**
 * writeLimiter
 * Limit for write endpoints (e.g. POST /assets, POST /agents).
 */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: defaultWriteLimit,
  standardHeaders: true,
  legacyHeaders: false,
  store,
  keyGenerator: (req, res) => {
    // Determine the relevant Stellar address from the body based on the endpoint.
    const address =
      req.body?.owner ||
      req.body?.buyer ||
      req.body?.reporter ||
      req.body?.voter;

    // Fall back to IP address (using built-in ipKeyGenerator to correctly handle IPv6) if no Stellar address is found in the body.
    return address || rateLimit.ipKeyGenerator(req, res);
  },
});

module.exports = {
  publicReadLimiter,
  writeLimiter,
};
