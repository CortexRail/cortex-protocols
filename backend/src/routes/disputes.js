/**
 * Dispute & Arbitration REST API routes.
 */

const { Router } = require("express");
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const {
  filePurchaseDispute,
  getArbitratorQueue,
  castArbitratorVote,
  getDisputeDetails,
} = require("../services/disputeService");

const router = Router();

/**
 * POST /api/v1/disputes
 * File a purchase dispute with evidence upload/text.
 */
router.post(
  "/",
  [
    body("licenseId").isInt({ min: 1 }),
    body("buyer").isString().isLength({ min: 56, max: 56 }),
    body("evidenceText").isString().isLength({ min: 5, max: 10000 }),
    body("disputeId").optional().isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { disputeId, licenseId, buyer, evidenceText } = req.body;
    const result = await filePurchaseDispute({
      disputeId: disputeId ? Number(disputeId) : undefined,
      licenseId: Number(licenseId),
      buyer,
      evidenceText,
    });
    res.status(201).json(result);
  })
);

/**
 * GET /api/v1/disputes/queue
 * Retrieve arbitrator dispute review queue.
 */
router.get(
  "/queue",
  asyncHandler(async (req, res) => {
    const queue = await getArbitratorQueue();
    res.json({ queue });
  })
);

/**
 * GET /api/v1/disputes/:disputeId
 * Retrieve dispute details by ID.
 */
router.get(
  "/:disputeId",
  [param("disputeId").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params;
    const dispute = await getDisputeDetails(Number(disputeId));
    res.json(dispute);
  })
);

/**
 * POST /api/v1/disputes/:disputeId/vote
 * Cast arbitrator vote for a dispute.
 */
router.post(
  "/:disputeId/vote",
  [
    param("disputeId").isInt({ min: 1 }),
    body("arbitrator").isString().isLength({ min: 56, max: 56 }),
    body("vote").isIn(["FullRefund", "PartialRefund", "ReleaseToSeller"]),
    body("bps").optional().isInt({ min: 0, max: 10000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params;
    const { arbitrator, vote, bps } = req.body;
    const result = await castArbitratorVote({
      disputeId: Number(disputeId),
      arbitrator,
      vote,
      bps: bps != null ? Number(bps) : null,
    });
    res.json(result);
  })
);

module.exports = router;
