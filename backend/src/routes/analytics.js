const { Router } = require("express");
const { query } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { getRevenueByOwner } = require("../repositories/analyticsRepository");

const router = Router();

/**
 * GET /api/v1/analytics/revenue
 * Revenue breakdown per asset for a given owner.
 */
router.get(
  "/revenue",
  [
    query("owner").isString().isLength({ min: 56, max: 56 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const data = await getRevenueByOwner(req.query.owner);
    const totalRevenue = data.reduce((sum, r) => sum + r.totalRevenue, 0);
    res.json({ data, totalRevenue });
  })
);

module.exports = router;
