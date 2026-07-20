const { Router } = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const { getPoolStats, healthCheck } = require("../db/connection");
const { getMetrics, getDeadLetters, getStatus } = require("../pipeline/EventPipeline");

const router = Router();

router.get("/db-stats", requireAdmin, async (_req, res, next) => {
  try {
    const database = await healthCheck();
    const status = database.healthy ? 200 : 503;

    res.status(status).json({
      pool: getPoolStats(),
      database,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/pipeline-metrics", requireAdmin, async (_req, res, next) => {
  try {
    res.json(getMetrics());
  } catch (err) {
    next(err);
  }
});

router.get("/dead-letters", requireAdmin, async (_req, res, next) => {
  try {
    res.json({ deadLetters: getDeadLetters(), status: getStatus() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
