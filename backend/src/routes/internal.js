const { Router } = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const { healthCheck, getPoolStats } = require("../db/connection");

const router = Router();

/**
 * GET /api/v1/internal/db-stats
 * Admin-only operational endpoint: connection pool utilization and a
 * database health probe. Guarded by requireAdmin (x-admin-key header).
 */
router.get("/db-stats", requireAdmin, async (_req, res, next) => {
  try {
    const [database, pool] = [await healthCheck(), getPoolStats()];
    res.json({
      pool,
      database,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
