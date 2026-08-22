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
const { publicReadLimiter, writeLimiter } = require("../middleware/rateLimiter");

const router = Router();

/**
 * @swagger
 * /api/v1/agents:
 *   get:
 *     summary: Discover registered agents with optional filters.
 *     tags: [Agents]
 *     parameters:
 *       - in: query
 *         name: capability
 *         schema:
 *           type: string
 *       - in: query
 *         name: minReputation
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: A list of agents
 */
router.get(
  "/",
  publicReadLimiter,
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
 * @swagger
 * /api/v1/agents/capabilities/list:
 *   get:
 *     summary: List capabilities
 *     tags: [Agents]
 *     responses:
 *       200:
 *         description: list of capabilities
 */
router.get("/capabilities/list", publicReadLimiter, (_req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

/**
 * @swagger
 * /api/v1/agents/leaderboard:
 *   get:
 *     summary: Get top agents by reputation, activity, or earnings.
 *     tags: [Agents]
 *     parameters:
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Leaderboard data
 */
router.get(
  "/leaderboard",
  publicReadLimiter,
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
 * @swagger
 * /api/v1/agents/{id}:
 *   get:
 *     summary: Get agent by id
 *     tags: [Agents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Agent details
 */
router.get(
  "/:id",
  publicReadLimiter,
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
 * @swagger
 * /api/v1/agents:
 *   post:
 *     summary: Index an agent identity after on-chain registration.
 *     tags: [Agents]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               owner:
 *                 type: string
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               capabilities:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Agent created
 */
router.post(
  "/",
  writeLimiter,
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
 * @swagger
 * /api/v1/agents/{id}/reputation-history:
 *   get:
 *     summary: Get time-series reputation votes for an agent.
 *     tags: [Agents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: History data
 */
router.get(
  "/:id/reputation-history",
  publicReadLimiter,
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
 * @swagger
 * /api/v1/agents/{id}/reputation:
 *   post:
 *     summary: Submit a reputation vote (0-100) for an agent.
 *     tags: [Agents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               score:
 *                 type: integer
 *               voter:
 *                 type: string
 *     responses:
 *       201:
 *         description: Reputation submitted
 */
router.post(
  "/:id/reputation",
  writeLimiter,
  [
    param("id").isInt({ min: 1 }),
    body("score").isInt({ min: 0, max: 100 }),
    body("voter").isString().isLength({ min: 56, max: 56 }),
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
 * @swagger
 * /api/v1/agents/{id}/activity:
 *   get:
 *     summary: Get paginated on-chain event feed for an agent.
 *     tags: [Agents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Activity feed
 */
router.get(
  "/:id/activity",
  publicReadLimiter,
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
