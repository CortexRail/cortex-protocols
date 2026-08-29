const { Router } = require("express");
const { body, param, query } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const {
  indexStream,
  getStream,
  listStreams,
  recordWithdrawal,
  STREAM_STATUSES,
} = require("../services/streamService");
const { isValidStellarAddress } = require("../utils/stellar");

const router = Router();

/**
 * @swagger
 * /api/v1/streams:
 *   get:
 *     summary: List payment streams, optionally filtering by sender or recipient.
 *     tags: [Streams]
 *     parameters:
 *       - in: query
 *         name: sender
 *         schema:
 *           type: string
 *       - in: query
 *         name: recipient
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of streams
 */
router.get(
  "/",
  [
    query("sender")
      .optional()
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    query("recipient")
      .optional()
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
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
 * @swagger
 * /api/v1/streams/{id}:
 *   get:
 *     summary: Get a stream by id
 *     tags: [Streams]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Stream details
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
 * @swagger
 * /api/v1/streams:
 *   post:
 *     summary: Index a stream after on-chain creation.
 *     tags: [Streams]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               sender:
 *                 type: string
 *               recipient:
 *                 type: string
 *               token:
 *                 type: string
 *               deposit:
 *                 type: integer
 *               ratePerSecond:
 *                 type: integer
 *               startTime:
 *                 type: integer
 *               endTime:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Stream created
 */
router.post(
  "/",
  [
    body("id").isInt({ min: 1 }),
    body("sender")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("recipient")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
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

/**
 * @swagger
 * /api/v1/streams/{id}/withdraw:
 *   post:
 *     summary: Record a withdrawal from a payment stream.
 *     tags: [Streams]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recipient:
 *                 type: string
 *               amount:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Withdrawal recorded
 */
router.post(
  "/:id/withdraw",
  [
    param("id").isInt({ min: 1 }),
    body("recipient").isString().isLength({ min: 56, max: 56 }),
    body("amount").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const stream = await getStream(req.params.id);
    if (!stream) {
      return res.status(404).json({ error: "Stream not found" });
    }
    if (stream.recipient !== req.body.recipient) {
      return res.status(403).json({ error: "Not the stream recipient" });
    }
    const updated = await recordWithdrawal(stream.id, req.body.amount);
    res.json(updated);
  })
);

module.exports = router;
