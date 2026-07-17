const { Router } = require("express");
const { body, param, query } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const {
  indexStream,
  getStream,
  listStreams,
  STREAM_STATUSES,
} = require("../services/streamService");

const router = Router();

/**
 * GET /api/v1/streams
 * List payment streams, optionally filtering by sender or recipient.
 */
router.get(
  "/",
  [
    query("sender").optional().isString().isLength({ min: 56, max: 56 }),
    query("recipient").optional().isString().isLength({ min: 56, max: 56 }),
    query("status").optional().isIn(STREAM_STATUSES),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { sender, recipient, status, page = "1", limit = "20" } = req.query;
    const result = await listStreams({
      sender,
      recipient,
      status,
      page: Number(page),
      limit: Number(limit),
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/streams/:id
 */
router.get(
  "/:id",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const stream = await getStream(req.params.id);
    if (!stream) {
      return res.status(404).json({ error: "Stream not found" });
    }
    res.json(stream);
  })
);

/**
 * POST /api/v1/streams
 * Index a stream after on-chain creation.
 */
router.post(
  "/",
  [
    body("id").isInt({ min: 1 }),
    body("sender").isString().isLength({ min: 56, max: 56 }),
    body("recipient").isString().isLength({ min: 56, max: 56 }),
    body("token").isString(),
    body("deposit").isInt({ min: 1 }),
    body("ratePerSecond").isInt({ min: 1 }),
    body("startTime").isInt({ min: 0 }),
    body("endTime").isInt({ min: 0 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const stream = await indexStream(req.body);
    res.status(201).json(stream);
  })
);

module.exports = router;
