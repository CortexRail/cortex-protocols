const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const Redis = require("ioredis");

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

/**
 * publicReadLimiter
 * Limit for public read endpoints (e.g. GET /assets, GET /agents).
 * 100 requests per minute per IP address.
 */
const publicReadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  store: store,
});

/**
 * writeLimiter
 * Limit for write endpoints (e.g. POST /assets, POST /agents).
 * 10 requests per minute per Stellar address.
 */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests
  standardHeaders: true,
  legacyHeaders: false,
  store: store,
  keyGenerator: (req, _res) => {
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
