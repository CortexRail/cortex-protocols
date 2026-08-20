const { Router } = require("express");
const { body, param, query } = require("express-validator");
const requireAdmin = require("../middleware/requireAdmin");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { listReportsForAdmin } = require("../services/reportService");
const fraudService = require("../services/fraudService");
const { DETECTORS, RISK_TIERS } = require("../repositories/fraudSignalRepository");

const router = Router();

// Every route in this file is an admin-only operation.
router.use(requireAdmin);

/**
 * GET /api/v1/admin/reports
 * List moderation reports, most recent first, with the related asset
 * attached to each. Gated by the x-admin-key header.
 */
router.get(
  "/reports",
  [
    query("status").optional().isIn([
      "Pending",
      "UnderReview",
      "Resolved",
      "Dismissed",
    ]),
    query("assetId").optional().isInt({ min: 1 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { status, assetId, page, limit } = req.query;
    const result = await listReportsForAdmin({
      status,
      assetId: assetId !== undefined ? Number(assetId) : undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

// ── Fraud detection ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/fraud/signals
 * The risk queue. Filterable by risk tier, detector, status, and subject;
 * ordered worst-first by default, `sort=recent` for the chronological view.
 */
router.get(
  "/fraud/signals",
  [
    query("status").optional().isIn(["open", "dismissed", "reported"]),
    query("detector").optional().isIn(DETECTORS),
    query("riskTier").optional().isIn(RISK_TIERS),
    query("agentAddress").optional().isString().trim().isLength({ min: 1, max: 120 }),
    query("assetId").optional().isInt({ min: 1 }),
    query("minScore").optional().isFloat({ min: 0, max: 1 }),
    query("scanId").optional().isUUID(),
    query("sort").optional().isIn(["score", "recent"]),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { status, detector, riskTier, agentAddress, assetId, minScore, scanId, sort, page, limit } =
      req.query;

    const result = await fraudService.listSignals({
      status,
      detector,
      riskTier,
      agentAddress,
      assetId: assetId !== undefined ? Number(assetId) : undefined,
      minScore: minScore !== undefined ? Number(minScore) : undefined,
      scanId,
      sort,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/admin/fraud/agents/:id/graph
 * The sybil-cluster subgraph around an address, for visualisation.
 *
 * `:id` accepts either an agent id or a Stellar address — the graph is built
 * over addresses, and a numeric id is resolved to its owner (see
 * fraudService.resolveAgentAddress).
 */
router.get(
  "/fraud/agents/:id/graph",
  [
    param("id").isString().trim().isLength({ min: 1, max: 120 }),
    query("lookbackHours").optional().isInt({ min: 1, max: 720 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { lookbackHours } = req.query;
    const graph = await fraudService.getAgentGraph(req.params.id, {
      lookbackHours: lookbackHours ? Number(lookbackHours) : undefined,
    });
    res.json(graph);
  })
);

/**
 * POST /api/v1/admin/fraud/signals/:id/dismiss
 * Mark a signal as a false positive. The reason is retained as tuning data and
 * the decision is written to the tamper-evident audit log.
 */
router.post(
  "/fraud/signals/:id/dismiss",
  [
    param("id").isInt({ min: 1 }),
    body("dismissedBy").isString().trim().isLength({ min: 1, max: 120 }),
    body("reason").optional().isString().trim().isLength({ max: 1_000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const signal = await fraudService.dismissSignal(Number(req.params.id), {
      dismissedBy: req.body.dismissedBy,
      reason: req.body.reason ?? null,
    });
    res.json(signal);
  })
);

module.exports = router;
