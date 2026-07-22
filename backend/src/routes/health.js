const { Router } = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { getConnectivityReport } = require("../services/healthService");

const router = Router();

/**
 * GET /health/contracts
 * Deep health check: Soroban RPC / Horizon reachability and deployment
 * status of every configured contract. Returns 503 when degraded so load
 * balancers and uptime monitors can alert on it.
 */
router.get(
  "/contracts",
  asyncHandler(async (_req, res) => {
    const report = await getConnectivityReport();
    res.status(report.status === "ok" ? 200 : 503).json(report);
  })
);

module.exports = router;
