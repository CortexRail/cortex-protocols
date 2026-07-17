const { Router } = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const requireAdmin = require("../middleware/requireAdmin");
const { getPoolStats, healthCheck } = require("../db/connection");

const router = Router();

/**
 * GET /api/v1/internal/db-stats
 * Connection-pool utilization and database health. Admin-only.
 */
router.get(
  "/db-stats",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const database = await healthCheck();
    res.json({
      pool: getPoolStats(),
      database,
      timestamp: new Date().toISOString(),
    });
  })
);

module.exports = router;
