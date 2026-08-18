const { Router } = require("express");
const requireAdmin = require("../middleware/requireAdmin");
const { getPoolStats, healthCheck } = require("../db/connection");
const { getMetrics, getDeadLetters, getStatus } = require("../pipeline/EventPipeline");
const { getLagStats } = require("../db/ReplicaLagMonitor");
const SettlementLedger = require("../protocol/SettlementLedger");
const SettlementReconciler = require("../protocol/SettlementReconciler");
const DeadLetterQueue = require("../protocol/DeadLetterQueue");

const router = Router();

router.get("/db-stats", requireAdmin, async (_req, res, next) => {
  try {
    const database = await healthCheck();
    const status = database.healthy ? 200 : 503;

    res.status(status).json({
      pool: getPoolStats(),
      lag: getLagStats(),
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

// Settlement health endpoint
router.get("/settlements/health", requireAdmin, async (_req, res, next) => {
  try {
    const ledgerMetrics = await SettlementLedger.getHealthMetrics();
    const dlqStats = await DeadLetterQueue.getStats();
    
    res.json({
      ledger: ledgerMetrics,
      deadLetterQueue: dlqStats,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// List divergent streams
router.get("/settlements/divergent", requireAdmin, async (req, res, next) => {
  try {
    const filters = {
      type: req.query.type,
      since: req.query.since ? Number(req.query.since) : undefined,
    };
    
    const divergences = await SettlementReconciler.getRecentDivergences(filters);
    
    res.json({
      divergences,
      count: divergences.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// Retry a dead-lettered settlement
router.post("/settlements/:id/retry", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const settlement = await DeadLetterQueue.retry(id);
    
    res.json({
      settlement,
      message: `Settlement ${id} queued for retry`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// Discard a dead-lettered settlement
router.post("/settlements/:id/discard", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: "Reason is required for discarding" });
    }
    
    const settlement = await DeadLetterQueue.discard(id, reason);
    
    res.json({
      settlement,
      message: `Settlement ${id} discarded`,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// List dead-lettered settlements
router.get("/settlements/dead-lettered", requireAdmin, async (req, res, next) => {
  try {
    const pagination = {
      limit: req.query.limit ? Number(req.query.limit) : 100,
      offset: req.query.offset ? Number(req.query.offset) : 0,
    };
    
    const settlements = await DeadLetterQueue.list(pagination);
    
    res.json({
      settlements,
      count: settlements.length,
      pagination,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
