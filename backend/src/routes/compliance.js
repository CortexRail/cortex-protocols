/**
 * Compliance & audit routes — all admin-only.
 *
 * Mounted at /api/v1/admin by app.js (alongside the existing admin router).
 *
 * POST /api/v1/admin/compliance/export
 *   Create a tracked export request; processing happens asynchronously.
 *   Returns the compliance_request row with status 'processing'.
 *
 * POST /api/v1/admin/compliance/erase
 *   Create a tracked erasure request; processing happens asynchronously.
 *   Returns the compliance_request row with status 'processing'.
 *
 * GET /api/v1/admin/compliance/requests
 *   List all compliance requests, newest first. Filter by type/status.
 *
 * GET /api/v1/admin/compliance/requests/:id
 *   Fetch a single request (includes export_bundle if completed).
 *
 * GET /api/v1/admin/compliance/requests/:id/download
 *   Download the export bundle JSON for a completed export request.
 *   Requires the `?token=` query param that was issued at completion.
 *
 * GET /api/v1/admin/audit/verify
 *   Run AuditChainVerifier on demand. Returns pass/fail + first broken link.
 *
 * GET /api/v1/admin/audit/entries
 *   Paginated audit log entries.
 *
 * GET /api/v1/admin/audit/anchors
 *   List Merkle anchor records.
 *
 * GET /api/v1/admin/audit/anchors/:id/prove/:seq
 *   Return a Merkle inclusion proof for a specific seq in a specific anchor.
 *
 * POST /api/v1/admin/audit/anchor
 *   Trigger an immediate on-demand Merkle anchor.
 */

const { Router } = require("express");
const { body, query: qv, param } = require("express-validator");
const requireAdmin = require("../middleware/requireAdmin");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { query } = require("../db/connection");
const { AuditLogWriter, EVENT_TYPES } = require("../audit/AuditLogWriter");
const { AuditChainVerifier } = require("../audit/AuditChainVerifier");
const { MerkleAnchor } = require("../audit/MerkleAnchor");
const { ComplianceExportService } = require("../audit/ComplianceExportService");
const { ErasureService } = require("../audit/ErasureService");

const router = Router();

// Every route requires admin auth.
router.use(requireAdmin);

// ── Compliance: Export ────────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/compliance/export
 *
 * Body: { subjectId: string, requestedBy: string }
 *
 * Creates a compliance_request row, kicks off async export processing,
 * and returns the row immediately (status: 'processing').
 */
router.post(
  "/compliance/export",
  [
    body("subjectId").isString().trim().isLength({ min: 1, max: 200 }),
    body("requestedBy").isString().trim().isLength({ min: 1, max: 200 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { subjectId, requestedBy } = req.body;

    // Audit the request before processing.
    const writer = AuditLogWriter.getInstance();
    await writer.append({
      eventType: EVENT_TYPES.COMPLIANCE_EXPORT_REQUESTED,
      actor: requestedBy,
      subjectId,
      payload: { requestedBy },
    });

    // Create the tracked request row.
    const { rows } = await query(
      `INSERT INTO compliance_requests (request_type, subject_id, requested_by, status)
       VALUES ('export', $1, $2, 'pending')
       RETURNING id, request_type, subject_id, requested_by, status, created_at`,
      [subjectId, requestedBy]
    );
    const requestRow = rows[0];

    // Kick off async processing — don't await so the response is immediate.
    const service = new ComplianceExportService();
    service.processExport(requestRow.id).catch((err) => {
      console.error(`[compliance] export ${requestRow.id} failed:`, err.message);
    });

    res.status(202).json({
      message: "Export request accepted and processing asynchronously.",
      request: mapRequest(requestRow),
    });
  })
);

// ── Compliance: Erasure ───────────────────────────────────────────────────────

/**
 * POST /api/v1/admin/compliance/erase
 *
 * Body: { subjectId: string, requestedBy: string, confirmed: true }
 *
 * `confirmed: true` is required to prevent accidental erasure — the UI must
 * explicitly surface the immutability warning before enabling this action.
 */
router.post(
  "/compliance/erase",
  [
    body("subjectId").isString().trim().isLength({ min: 1, max: 200 }),
    body("requestedBy").isString().trim().isLength({ min: 1, max: 200 }),
    body("confirmed")
      .equals("true")
      .withMessage("confirmed must be the string 'true' to acknowledge erasure constraints"),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { subjectId, requestedBy } = req.body;

    const writer = AuditLogWriter.getInstance();
    await writer.append({
      eventType: EVENT_TYPES.COMPLIANCE_ERASURE_REQUESTED,
      actor: requestedBy,
      subjectId,
      payload: { requestedBy },
    });

    const { rows } = await query(
      `INSERT INTO compliance_requests (request_type, subject_id, requested_by, status)
       VALUES ('erasure', $1, $2, 'pending')
       RETURNING id, request_type, subject_id, requested_by, status, created_at`,
      [subjectId, requestedBy]
    );
    const requestRow = rows[0];

    const service = new ErasureService();
    service.processErasure(requestRow.id).catch((err) => {
      console.error(`[compliance] erasure ${requestRow.id} failed:`, err.message);
    });

    res.status(202).json({
      message: "Erasure request accepted and processing asynchronously.",
      immutabilityNotice: {
        cannotErase: [
          "On-chain Stellar transactions (permanent on the network)",
          "events_log — raw on-chain event records",
          "merkle_anchors — on-chain Merkle commitments",
          "audit_log structural chain (entry_hash / prev_hash / seq — preserved for integrity)",
        ],
        willPseudonymise: [
          "agents.owner",
          "assets.owner",
          "licenses.buyer",
          "streams.sender / recipient",
          "reports.reporter",
          "admin_actions.operator + args/result payload",
          "audit_log.actor + subject_id + payload content",
        ],
        pseudonymisationNote:
          "PII fields are replaced with a stable, irreversible PSEUDONYM_<hash> token. " +
          "The same original value always produces the same token. " +
          "Pseudonymisation is idempotent — repeating the request produces no further changes.",
      },
      request: mapRequest(requestRow),
    });
  })
);

// ── Compliance: Request queue ────────────────────────────────────────────────

/**
 * GET /api/v1/admin/compliance/requests
 */
router.get(
  "/compliance/requests",
  [
    qv("type").optional().isIn(["export", "erasure"]),
    qv("status").optional().isIn(["pending", "processing", "completed", "failed"]),
    qv("page").optional().isInt({ min: 1 }),
    qv("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { type, status, page = 1, limit = 20 } = req.query;
    const safeLimit = Math.min(100, Math.max(1, Number(limit)));
    const offset = (Math.max(1, Number(page)) - 1) * safeLimit;

    const params = [];
    const clauses = [];
    if (type) { params.push(type); clauses.push(`request_type = $${params.length}`); }
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const countRes = await query(
      `SELECT count(*)::bigint AS total FROM compliance_requests ${where}`,
      params
    );
    const total = Number(countRes.rows[0].total);

    params.push(safeLimit, offset);
    const { rows } = await query(
      `SELECT id, request_type, subject_id, requested_by, status,
              result_summary, download_token, created_at, completed_at
       FROM compliance_requests ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: rows.map(mapRequest),
      meta: { total, page: Number(page), limit: safeLimit, pages: Math.ceil(total / safeLimit) },
    });
  })
);

/**
 * GET /api/v1/admin/compliance/requests/:id
 */
router.get(
  "/compliance/requests/:id",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, request_type, subject_id, requested_by, status,
              result_summary, export_bundle, download_token, error_message,
              created_at, completed_at
       FROM compliance_requests WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Request not found" });
    // Omit the full bundle from this view to keep the payload small.
    const row = { ...rows[0] };
    const hasBundle = !!row.export_bundle;
    delete row.export_bundle;
    res.json({ ...mapRequest(row), hasBundleAvailable: hasBundle });
  })
);

/**
 * GET /api/v1/admin/compliance/requests/:id/download?token=<token>
 * Download the export bundle for a completed export request.
 */
router.get(
  "/compliance/requests/:id/download",
  [
    param("id").isInt({ min: 1 }),
    qv("token").isString().isLength({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, request_type, status, export_bundle, download_token, subject_id
       FROM compliance_requests WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Request not found" });
    const row = rows[0];

    if (row.request_type !== "export") {
      return res.status(400).json({ error: "Only export requests have downloadable bundles" });
    }
    if (row.status !== "completed") {
      return res.status(400).json({ error: `Request is not yet completed (status: ${row.status})` });
    }
    if (!row.export_bundle) {
      return res.status(404).json({ error: "Export bundle not found" });
    }

    // Constant-time token comparison.
    const { createHash, timingSafeEqual } = require("crypto");
    const provided = createHash("sha256").update(String(req.query.token)).digest();
    const stored = createHash("sha256").update(String(row.download_token)).digest();
    if (!timingSafeEqual(provided, stored)) {
      return res.status(403).json({ error: "Invalid download token" });
    }

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="compliance_export_${row.subject_id}_${row.id}.json"`
    );
    res.json(row.export_bundle);
  })
);

// ── Audit: Chain verification ────────────────────────────────────────────────

/**
 * GET /api/v1/admin/audit/verify
 *
 * Run the full chain verifier on demand. May take several seconds on large
 * logs; the result includes the first broken link if any.
 */
router.get(
  "/audit/verify",
  asyncHandler(async (_req, res) => {
    const verifier = new AuditChainVerifier();
    const result = await verifier.verify();
    res.json(result);
  })
);

// ── Audit: Log entries ───────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/audit/entries
 */
router.get(
  "/audit/entries",
  [
    qv("eventType").optional().isString().isLength({ max: 100 }),
    qv("actor").optional().isString().isLength({ max: 200 }),
    qv("subjectId").optional().isString().isLength({ max: 200 }),
    qv("page").optional().isInt({ min: 1 }),
    qv("limit").optional().isInt({ min: 1, max: 200 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const writer = AuditLogWriter.getInstance();
    const result = await writer.findRecent({
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 50,
      eventType: req.query.eventType,
      actor: req.query.actor,
      subjectId: req.query.subjectId,
    });
    res.json(result);
  })
);

// ── Audit: Merkle anchors ────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/audit/anchors
 */
router.get(
  "/audit/anchors",
  [
    qv("page").optional().isInt({ min: 1 }),
    qv("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const anchor = MerkleAnchor.getInstance();
    const result = await anchor.listAnchors({
      page: req.query.page ? Number(req.query.page) : 1,
      limit: req.query.limit ? Number(req.query.limit) : 20,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/admin/audit/anchors/:id/prove/:seq
 * Return a Merkle inclusion proof for a specific audit log seq.
 */
router.get(
  "/audit/anchors/:id/prove/:seq",
  [
    param("id").isInt({ min: 1 }),
    param("seq").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const anchor = MerkleAnchor.getInstance();
    // Fetch the anchor to verify the id matches the range.
    const { rows } = await query(
      "SELECT * FROM merkle_anchors WHERE id = $1",
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: "Anchor not found" });
    const anchorRow = rows[0];
    const seq = Number(req.params.seq);

    if (seq < Number(anchorRow.from_seq) || seq > Number(anchorRow.to_seq)) {
      return res.status(400).json({
        error: `seq ${seq} is not in anchor range [${anchorRow.from_seq}, ${anchorRow.to_seq}]`,
      });
    }

    const proof = await anchor.proveInclusion(seq);
    if (!proof) return res.status(404).json({ error: "Could not generate proof for this seq" });
    res.json(proof);
  })
);

/**
 * POST /api/v1/admin/audit/anchor
 * Trigger an immediate on-demand Merkle anchor of all unanchored entries.
 */
router.post(
  "/audit/anchor",
  asyncHandler(async (_req, res) => {
    const anchor = MerkleAnchor.getInstance();
    const lastAnchorRes = await query(
      `SELECT COALESCE(MAX(to_seq), 0) AS last_seq
       FROM merkle_anchors WHERE status IN ('submitted', 'confirmed')`
    );
    const lastAnchoredSeq = Number(lastAnchorRes.rows[0].last_seq);

    const maxSeqRes = await query(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM audit_log"
    );
    const maxSeq = Number(maxSeqRes.rows[0].max_seq);

    if (maxSeq <= lastAnchoredSeq) {
      return res.json({ message: "Nothing to anchor — all entries already covered.", maxSeq, lastAnchoredSeq });
    }

    const result = await anchor.anchorNow(lastAnchoredSeq + 1, maxSeq);
    res.status(201).json(result);
  })
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestType: row.request_type,
    subjectId: row.subject_id,
    requestedBy: row.requested_by,
    status: row.status,
    resultSummary: row.result_summary || null,
    downloadToken: row.download_token || null,
    errorMessage: row.error_message || null,
    createdAt: row.created_at instanceof Date ? row.created_at.getTime() : Number(row.created_at),
    completedAt: row.completed_at
      ? row.completed_at instanceof Date ? row.completed_at.getTime() : Number(row.completed_at)
      : null,
  };
}

module.exports = router;
