const { Router } = require("express");
const { query, param } = require("express-validator");
const rateLimit = require("express-rate-limit");
const { MemoryStore } = rateLimit;
const validate = require("../middleware/validate");
const stellarConfig = require("../config/stellar");
const { horizonServer, rpcServer, NETWORK, CONTRACT_IDS } = stellarConfig;
const { getAccountTransactions } = require("../services/transactionService");
const { fundAccount } = require("../services/friendbotService");
const { isValidStellarAddress } = require("../utils/stellar");

const router = Router();

// ── Per-IP rate limiter for the Friendbot funding endpoint ────────────────────
// 1 request per IP per 60-minute window. The store is kept as a standalone
// reference so tests can reset it between cases.
const fundLimiterStore = new MemoryStore();
const fundRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 1,
  store: fundLimiterStore,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Only one Friendbot request is allowed per IP per hour. Please try again later." },
});

// ── Per-key rate limiter for the transactions endpoint ────────────────────────
// Keyed on the publicKey path param so each Stellar address gets its own quota.
// 30 requests per 60-second window per key.
const txRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.params.publicKey || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests for this public key. Please wait before retrying." },
});

/**
 * GET /api/v1/stellar/account/:publicKey
 * Fetch account balances from Horizon.
 */
router.get(
  "/account/:publicKey",
  [
    param("publicKey")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
  ],
  validate,
  async (req, res, next) => {
    try {
      const account = await horizonServer.loadAccount(req.params.publicKey);
      res.json({
        publicKey: account.account_id,
        sequence: account.sequence,
        balances: account.balances,
        subentryCount: account.subentry_count,
      });
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: "Account not found on network" });
      }
      next(err);
    }
  }
);

/**
 * GET /api/v1/stellar/network
 * Return current network config and contract addresses.
 */
router.get("/network", (_req, res) => {
  res.json({
    network: NETWORK,
    contracts: CONTRACT_IDS,
    rpcUrl: process.env.STELLAR_RPC_URL,
    horizonUrl: process.env.STELLAR_HORIZON_URL,
  });
});

/**
 * GET /api/v1/stellar/fee
 * Fetch current recommended fee from Horizon.
 */
router.get("/fee", async (_req, res, next) => {
  try {
    const feeStats = await horizonServer.feeStats();
    res.json({
      baseFee: feeStats.last_ledger_base_fee,
      p50: feeStats.fee_charged.p50,
      p90: feeStats.fee_charged.p90,
      p99: feeStats.fee_charged.p99,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/stellar/account/:publicKey/transactions
 *
 * Returns a paginated list of Horizon transactions for the given public key,
 * filtered to those involving known contract addresses, with each operation
 * parsed into a human-readable summary.
 *
 * Query params:
 *   page    — 1-based page number (default: 1)
 *   limit   — records per page, 1–200 (default: 20)
 *   cursor  — Horizon paging token; when supplied, overrides `page`
 *
 * Caching: results are cached for 5 seconds per (publicKey × page × limit × cursor).
 * Rate limiting: 30 requests per 60-second window per public key.
 */
router.get(
  "/account/:publicKey/transactions",
  txRateLimiter,
  [
    param("publicKey")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 200 }),
    query("cursor").optional().isString().trim(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { publicKey } = req.params;
      const { page, limit, cursor } = req.query;

      const result = await getAccountTransactions(publicKey, {
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20,
        cursor: cursor || undefined,
      });

      res.json(result);
    } catch (err) {
      if (err.response?.status === 404) {
        return res.status(404).json({ error: "Account not found on network" });
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/stellar/fund
 *
 * Funds a Testnet account via Stellar Friendbot, for developer onboarding.
 *
 * Body: { "publicKey": "G..." }
 *
 * Restrictions:
 *   - Testnet only — returns 403 when the server is configured for Mainnet.
 *   - Rate limited to 1 request per IP per hour — returns 429 once exceeded.
 */
router.post("/fund", fundRateLimiter, async (req, res, next) => {
  const { publicKey } = req.body || {};

  if (!publicKey || typeof publicKey !== "string") {
    return res.status(400).json({ error: "publicKey is required" });
  }
  if (!isValidStellarAddress(publicKey)) {
    return res.status(400).json({ error: "publicKey must be a valid Stellar public key" });
  }

  if (stellarConfig.NETWORK !== "testnet") {
    return res.status(403).json({ error: "Friendbot is only available on Stellar Testnet." });
  }

  try {
    const result = await fundAccount(publicKey);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

// Exposed so tests can clear the funding rate limiter between cases.
module.exports.resetFundRateLimiter = () => fundLimiterStore.resetAll();
