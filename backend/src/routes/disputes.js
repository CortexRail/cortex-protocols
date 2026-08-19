/**
 * Dispute & Arbitration REST API routes for both Agent Registry disputes
 * and Marketplace Purchase disputes.
 */

const { Router } = require("express");
const { body, param, query } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { isValidStellarAddress } = require("../utils/stellar");
const disputeService = require("../services/disputeService");

const router = Router();

// ── Marketplace Purchase Disputes ───────────────────────────────────────────

/**
 * POST /api/v1/disputes/purchase
 * File a marketplace purchase dispute with evidence upload/text.
 */
router.post(
  "/purchase",
  [
    body("licenseId").isInt({ min: 1 }),
    body("buyer").isString().isLength({ min: 56, max: 56 }),
    body("evidenceText").isString().isLength({ min: 5, max: 10000 }),
    body("disputeId").optional().isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { disputeId, licenseId, buyer, evidenceText } = req.body;
    const result = await disputeService.filePurchaseDispute({
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
 * GET /api/v1/disputes/purchase/queue
 * Retrieve arbitrator purchase dispute review queue.
 */
const getQueueHandler = asyncHandler(async (_req, res) => {
  const queue = await disputeService.getArbitratorQueue();
  res.json({ queue });
});
router.get("/queue", getQueueHandler);
router.get("/purchase/queue", getQueueHandler);

/**
 * GET /api/v1/disputes/purchase/:disputeId
 * Retrieve purchase dispute details by ID.
 */
router.get(
  "/purchase/:disputeId",
  [param("disputeId").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const { disputeId } = req.params;
    const dispute = await disputeService.getDisputeDetails(Number(disputeId));
    res.json(dispute);
  })
);

/**
 * POST /api/v1/disputes/purchase/:disputeId/vote
 * Cast arbitrator vote for a purchase dispute.
 */
router.post(
  "/purchase/:disputeId/vote",
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
    const result = await disputeService.castArbitratorVote({
      disputeId: Number(disputeId),
      arbitrator,
      vote,
      bps: bps != null ? Number(bps) : null,
    });
    res.json(result);
  })
);

// ── Agent Registry Reputation Disputes ───────────────────────────────────

/**
 * GET /api/v1/disputes
 * Disputes still open for voting, soonest deadline first.
 */
router.get(
  "/",
  [
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await disputeService.getActiveDisputes({
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/disputes/agent/:address
 * Every dispute an address is involved in, as complainant or respondent.
 */
router.get(
  "/agent/:address",
  [
    param("address").custom(isValidStellarAddress).withMessage("must be a valid Stellar public key"),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await disputeService.getDisputesForAgent(req.params.address, {
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/disputes/:id
 */
router.get(
  "/:id",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const dispute = await disputeService.getDispute(req.params.id);
    if (!dispute) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    res.json(dispute);
  })
);

/**
 * POST /api/v1/disputes
 * Index a dispute opened on-chain, optionally with its evidence bundle.
 * The response carries the digest the filer must commit on-chain.
 */
router.post(
  "/",
  [
    body("id").isInt({ min: 1 }),
    body("complainant")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("respondent")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("evidence").optional(),
    body("evidenceHash").optional().isString().isLength({ min: 64, max: 64 }),
    body("closesAt").optional().isInt({ min: 0 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const dispute = await disputeService.fileDispute({
      id: Number(req.body.id),
      complainant: req.body.complainant,
      respondent: req.body.respondent,
      evidence: req.body.evidence ?? null,
      evidenceHash: req.body.evidenceHash,
      closesAt: req.body.closesAt ? Number(req.body.closesAt) : undefined,
    });
    res.status(201).json(dispute);
  })
);

/**
 * POST /api/v1/disputes/:id/evidence
 * Upload (or replace) the off-chain evidence bundle. Returns its SHA-256
 * digest — the value to pass as `evidence_hash` when calling the contract.
 */
router.post(
  "/:id/evidence",
  [param("id").isInt({ min: 1 }), body("evidence").exists()],
  validate,
  asyncHandler(async (req, res) => {
    const result = await disputeService.submitEvidence(
      req.params.id,
      req.body.evidence
    );
    if (!result) {
      return res.status(404).json({ error: "Dispute not found" });
    }
    res.status(201).json(result);
  })
);

module.exports = router;
