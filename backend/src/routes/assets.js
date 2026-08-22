const { Router } = require("express");
const { body, query, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const {
  listAssets,
  getAsset,
  indexAsset,
  removeAsset,
  ASSET_TYPES,
  LICENSE_TYPES,
} = require("../services/assetService");
const assetRepository = require("../repositories/assetRepository");
const { purchaseLicense } = require("../services/licenseService");
const { fileReport, REPORT_REASONS } = require("../services/reportService");
const { isValidStellarAddress } = require("../utils/stellar");
const { publicReadLimiter, writeLimiter } = require("../middleware/rateLimiter");

const router = Router();

/**
 * @swagger
 * /api/v1/assets:
 *   get:
 *     summary: List intelligence assets with optional filtering & pagination.
 *     tags: [Assets]
 *     parameters:
 *       - in: query
 *         name: assetType
 *         schema:
 *           type: string
 *       - in: query
 *         name: licenseType
 *         schema:
 *           type: string
 *       - in: query
 *         name: owner
 *         schema:
 *           type: string
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: integer
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: integer
 *       - in: query
 *         name: search
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
 *         description: A list of assets
 */
router.get(
  "/",
  publicReadLimiter,
  [
    query("assetType").optional().isIn(ASSET_TYPES),
    query("licenseType").optional().isIn(LICENSE_TYPES),
    query("owner").optional().isString().isLength({ min: 56, max: 56 }),
    query("minPrice").optional().isInt({ min: 0 }),
    query("maxPrice").optional().isInt({ min: 0 }),
    query("search").optional().isString().trim().isLength({ max: 100 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const {
      assetType,
      licenseType,
      owner,
      minPrice,
      maxPrice,
      search,
      page,
      limit,
    } = req.query;

    const result = await listAssets({
      assetType,
      licenseType,
      owner,
      minPrice: minPrice !== undefined ? Number(minPrice) : undefined,
      maxPrice: maxPrice !== undefined ? Number(maxPrice) : undefined,
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });

    res.json(result);
  })
);

/**
 * @swagger
 * /api/v1/assets/{id}/delist:
 *   post:
 *     summary: Soft-delete an asset owned by the caller.
 *     tags: [Assets]
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
 *               owner:
 *                 type: string
 *     responses:
 *       200:
 *         description: Asset delisted
 */
router.post(
  "/:id/delist",
  writeLimiter,
  [
    param("id").isInt({ min: 1 }),
    body("owner").isString().isLength({ min: 56, max: 56 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const asset = await getAsset(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }
    if (asset.owner !== req.body.owner) {
      return res.status(403).json({ error: "Not the asset owner" });
    }
    const deleted = await removeAsset(asset.id);
    res.json({ success: deleted });
  })
);

/**
 * @swagger
 * /api/v1/assets/{id}/price:
 *   patch:
 *     summary: Update the price of an asset owned by the caller.
 *     tags: [Assets]
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
 *               owner:
 *                 type: string
 *               price:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Price updated
 */
router.patch(
  "/:id/price",
  writeLimiter,
  [
    param("id").isInt({ min: 1 }),
    body("owner").isString().isLength({ min: 56, max: 56 }),
    body("price").isInt({ min: 0 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const asset = await getAsset(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }
    if (asset.owner !== req.body.owner) {
      return res.status(403).json({ error: "Not the asset owner" });
    }
    const updated = await assetRepository.update(asset.id, {
      price: req.body.price,
    });
    res.json(updated);
  })
);

/**
 * @swagger
 * /api/v1/assets/{id}:
 *   get:
 *     summary: Get a single asset by its on-chain ID.
 *     tags: [Assets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Asset details
 */
router.get(
  "/:id",
  publicReadLimiter,
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const asset = await getAsset(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }
    res.json(asset);
  })
);

/**
 * @swagger
 * /api/v1/assets:
 *   post:
 *     summary: Index an asset (called by event listener after on-chain listing).
 *     tags: [Assets]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id:
 *                 type: integer
 *               owner:
 *                 type: string
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               assetType:
 *                 type: string
 *               licenseType:
 *                 type: string
 *               price:
 *                 type: integer
 *               version:
 *                 type: integer
 *               tags:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       201:
 *         description: Asset created
 */
router.post(
  "/",
  writeLimiter,
  [
    body("id").isInt({ min: 1 }),
    body("owner")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("name").isString().trim().isLength({ min: 1, max: 200 }),
    body("description").isString().trim().isLength({ min: 1, max: 2000 }),
    body("assetType").isIn(ASSET_TYPES),
    body("licenseType").isIn(LICENSE_TYPES),
    body("price").isInt({ min: 0 }),
    body("version").optional().isInt({ min: 1 }),
    body("tags").optional().isArray(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const asset = await indexAsset(req.body);
    res.status(201).json(asset);
  })
);

/**
 * @swagger
 * /api/v1/assets/{id}/purchase:
 *   post:
 *     summary: Purchase a license for an asset.
 *     tags: [Assets]
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
 *               buyer:
 *                 type: string
 *               assetVersion:
 *                 type: integer
 *     responses:
 *       201:
 *         description: License purchased
 */
router.post(
  "/:id/purchase",
  writeLimiter,
  [
    param("id").isInt({ min: 1 }),
    body("buyer")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("assetVersion")
      .optional()
      .custom(Number.isInteger)
      .withMessage("must be an integer")
      .bail()
      .custom((value) => value >= 1)
      .withMessage("must be greater than or equal to 1"),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await purchaseLicense({
      assetId: Number(req.params.id),
      buyer: req.body.buyer,
      assetVersion: req.body.assetVersion,
    });
    res.status(201).json(result);
  })
);

/**
 * @swagger
 * /api/v1/assets/{id}/report:
 *   post:
 *     summary: File a moderation report against an asset.
 *     tags: [Assets]
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
 *               reporter:
 *                 type: string
 *               reason:
 *                 type: string
 *               details:
 *                 type: string
 *     responses:
 *       201:
 *         description: Report filed
 */
router.post(
  "/:id/report",
  writeLimiter,
  [
    param("id").isInt({ min: 1 }),
    body("reporter")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar public key"),
    body("reason").isIn(REPORT_REASONS),
    body("details").optional().isString().trim().isLength({ max: 2000 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await fileReport({
      assetId: Number(req.params.id),
      reporter: req.body.reporter,
      reason: req.body.reason,
      details: req.body.details,
    });
    res.status(201).json(result);
  })
);

/**
 * @swagger
 * /api/v1/assets/{id}/price:
 *   get:
 *     summary: Get current converted price in a requested token with commitment payload.
 *     tags: [Assets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Price commitment
 */
router.get(
  "/:id/price",
  [
    param("id").isInt({ min: 1 }),
    query("token")
      .isString()
      .bail()
      .custom(isValidStellarAddress)
      .withMessage("must be a valid Stellar token address"),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { getPriceCommitment } = require("../services/multiTokenPurchaseService");
    const commitment = await getPriceCommitment({
      assetId: Number(req.params.id),
      token: req.query.token,
    });
    res.json(commitment);
  })
);

/**
 * @swagger
 * /api/v1/assets/types/list:
 *   get:
 *     summary: Return all valid asset types and license types.
 *     tags: [Assets]
 *     responses:
 *       200:
 *         description: List of types
 */
router.get("/types/list", publicReadLimiter, (_req, res) => {
  res.json({ assetTypes: ASSET_TYPES, licenseTypes: LICENSE_TYPES });
});

module.exports = router;

// Note: search queries are logged at debug level for analytics
