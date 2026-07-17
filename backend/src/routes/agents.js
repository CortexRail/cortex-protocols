const { Router } = require("express");
const { body, query, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const {
  listAgents,
  getAgent,
  registerAgent,
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
    body("owner").isString().isLength({ min: 56, max: 56 }),
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
 * GET /api/v1/agents/capabilities/list
 */
router.get("/capabilities/list", (_req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

module.exports = router;
