const { Router } = require("express");
const { body, query, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { isValidStellarAddress } = require("../utils/stellar");
const {
  listAgents,
  getAgent,
  registerAgent,
  submitReputation,
  getReputationHistory,
  getActivityFeed,
  getLeaderboard,
  CAPABILITIES,
} = require("../services/agentService");

const router = Router();

/**
 * GET /api/v1/agents
 * Discover registered agents with optional filters.
 */
router.get(
  "/",
  [
    query("capability").optional().isIn(CAPABILITIES),
    query("minReputation").optional().isInt({ min: 0, max: 10000 }),
    query("search").optional().isString().trim().isLength({ max: 100 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { capability, minReputation, search, page, limit } = req.query;
    const result = await listAgents({
      capability,
      minReputation:
        minReputation !== undefined ? Number(minReputation) : undefined,
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/agents/capabilities/list
 */
router.get("/capabilities/list", (_req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

/**
 * GET /api/v1/agents/leaderboard
 * Get top agents by reputation, activity, or earnings.
 */
router.get(
  "/leaderboard",
  [query("sortBy").optional().isIn(["reputation", "activity", "earnings"]), query("limit").optional().isInt({ min: 1, max: 100 })],
  validate,
  (req, res) => {
    const sortBy = req.query.sortBy || "reputation";
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const leaderboard = getLeaderboard(sortBy, limit);
    res.json({
      data: leaderboard,
      meta: { sortBy, limit, count: leaderboard.length },
    });
  }
);

/**
 * GET /api/v1/agents/:id
 */
router.get(
  "/:id",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const agent = await getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    res.json(agent);
  })
);

/**
 * POST /api/v1/agents
 * Index an agent identity after on-chain registration.
 */
router.post(
  "/",
  [
    body("id").isInt({ min: 1 }),
    body("owner")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("name").isString().trim().isLength({ min: 1, max: 100 }),
    body("description").isString().trim().isLength({ min: 1, max: 1000 }),
    body("capabilities").isArray(),
    body("capabilities.*").isIn(CAPABILITIES),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const agent = await registerAgent(req.body);
    res.status(201).json(agent);
  })
);

/**
 * GET /api/v1/agents/:id/reputation-history
 * Get time-series reputation votes for an agent.
 */
router.get(
  "/:id/reputation-history",
  [param("id").isInt({ min: 1 }), query("limit").optional().isInt({ min: 1, max: 100 })],
  validate,
  (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    const limit = req.query.limit ? Number(req.query.limit) : 30;
    const history = getReputationHistory(req.params.id, limit);
    res.json({
      data: history,
      meta: { agentId: req.params.id, count: history.length },
    });
  }
);

/**
 * POST /api/v1/agents/:id/reputation
 * Submit a reputation vote (0-100) for an agent.
 */
router.post(
  "/:id/reputation",
  [
    param("id").isInt({ min: 1 }),
    body("score").isInt({ min: 0, max: 100 }),
    body("voter")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
  ],
  validate,
  (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    const vote = submitReputation(req.params.id, req.body.score, req.body.voter);
    res.status(201).json(vote);
  }
);

/**
 * GET /api/v1/agents/:id/activity
 * Get paginated on-chain event feed for an agent.
 */
router.get(
  "/:id/activity",
  [
    param("id").isInt({ min: 1 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  (req, res) => {
    const agent = getAgent(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const feed = getActivityFeed(req.params.id, page, limit);
    res.json(feed);
  }
);

module.exports = router;
