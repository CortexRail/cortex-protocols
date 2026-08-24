const { Router } = require("express");
const { query, param, body } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { listLicensesForBuyer, topUpLicense } = require("../services/licenseService");
const { isValidStellarAddress } = require("../utils/stellar");
const { writeLimiter } = require("../middleware/rateLimiter");

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

/**
 * POST /api/v1/licenses/:id/topup
 * Buy additional calls for an existing usage-based license.
 */
router.post(
  "/:id/topup",
  writeLimiter,
  [
    param("id").isInt({ min: 1 }),
    body("buyer")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("calls").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await topUpLicense({
      licenseId: Number(req.params.id),
      buyer: req.body.buyer,
      calls: Number(req.body.calls),
    });
    res.status(201).json(result);
  })
);

module.exports = router;
