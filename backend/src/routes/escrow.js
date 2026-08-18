/**
 * Escrow REST API routes.
 */

const { Router } = require("express");
const { param, query } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { getEscrowWithCountdown, getEscrowsForBuyer } = require("../services/escrowService");

const router = Router();

/**
 * GET /api/v1/escrow/buyer/:buyer
 * Retrieve all escrow holds for a buyer.
 */
router.get(
  "/buyer/:buyer",
  [param("buyer").isString().isLength({ min: 56, max: 56 })],
  validate,
  asyncHandler(async (req, res) => {
    const { buyer } = req.params;
    const escrows = await getEscrowsForBuyer(buyer);
    res.json({ escrows });
  })
);

/**
 * GET /api/v1/escrow/:licenseId
 * Retrieve escrow hold details and countdown for a license.
 */
router.get(
  "/:licenseId",
  [
    param("licenseId").isInt({ min: 1 }),
    query("currentLedger").optional().isInt({ min: 0 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { licenseId } = req.params;
    const { currentLedger } = req.query;
    const result = await getEscrowWithCountdown(
      Number(licenseId),
      currentLedger ? Number(currentLedger) : 0
    );
    res.json(result);
  })
);

module.exports = router;
