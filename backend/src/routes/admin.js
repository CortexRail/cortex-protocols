const { Router } = require("express");
const { query } = require("express-validator");
const requireAdmin = require("../middleware/requireAdmin");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { listReportsForAdmin } = require("../services/reportService");

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

module.exports = router;
