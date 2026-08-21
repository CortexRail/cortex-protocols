const { Router } = require("express");
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const approvalWorkflowService = require("../services/approvalWorkflowService");

const router = Router();

// POST /api/v1/orgs/:orgId/approval-policy
router.post(
  "/orgs/:orgId/approval-policy",
  [
    param("orgId").isString().notEmpty(),
    body("threshold").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { orgId } = req.params;
    const { threshold } = req.body;
    const policy = await approvalWorkflowService.upsertPolicy(orgId, threshold);
    res.json(policy);
  })
);

// GET /api/v1/orgs/:orgId/proposals
router.get(
  "/orgs/:orgId/proposals",
  [param("orgId").isString().notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { orgId } = req.params;
    const proposals = await approvalWorkflowService.listPendingProposals(orgId);
    res.json(proposals);
  })
);

// In a real app we'd construct a real Stellar transaction for Freighter.
// Here we return a mock unsigned XDR for the signer to sign.
const MOCK_UNSIGNED_XDR = "AAAAAgAAAAB...mock_xdr...";

// POST /api/v1/proposals/:id/approve
router.post(
  "/proposals/:id/approve",
  [
    param("id").isInt({ min: 1 }),
    body("signer").isString().notEmpty()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const proposalId = Number(req.params.id);
    const { signer } = req.body;
    
    await approvalWorkflowService.recordApproval(proposalId, signer, "approved");
    
    // Return unsigned XDR for Freighter
    res.json({ success: true, unsignedXdr: MOCK_UNSIGNED_XDR });
  })
);

// POST /api/v1/proposals/:id/reject
router.post(
  "/proposals/:id/reject",
  [
    param("id").isInt({ min: 1 }),
    body("signer").isString().notEmpty()
  ],
  validate,
  asyncHandler(async (req, res) => {
    const proposalId = Number(req.params.id);
    const { signer } = req.body;
    
    await approvalWorkflowService.recordApproval(proposalId, signer, "rejected");
    
    res.json({ success: true, unsignedXdr: MOCK_UNSIGNED_XDR });
  })
);

module.exports = router;
