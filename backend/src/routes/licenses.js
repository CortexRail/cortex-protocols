const { Router } = require("express");
const { query } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { listLicensesForBuyer } = require("../services/licenseService");

const router = Router();

/**
 * GET /api/v1/licenses
 * List all licenses held by a buyer.
 */
router.get(
  "/",
  [
    query("buyer").isString().isLength({ min: 56, max: 56 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { buyer, page, limit } = req.query;
    const result = await listLicensesForBuyer(buyer, {
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 50,
    });
    res.json(result);
  })
);

module.exports = router;
