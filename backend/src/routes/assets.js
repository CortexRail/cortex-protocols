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
const assetAnalyticsService = require("../services/assetAnalyticsService");
const { isValidStellarAddress } = require("../utils/stellar");
const { publicReadLimiter, writeLimiter } = require("../middleware/rateLimiter");

const router = Router();

/**
 * GET /api/v1/assets
 * List intelligence assets with optional filtering & pagination.
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
 * POST /api/v1/assets/:id/delist
 * Soft-delete an asset owned by the caller.
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
 * PATCH /api/v1/assets/:id/price
 * Update the price of an asset owned by the caller.
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
 * GET /api/v1/assets/:id
 * Get a single asset by its on-chain ID.
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
 * GET /api/v1/assets/:id/analytics
 * Returns total revenue, purchase count, unique buyer count, and revenue over time.
 * Secure with owner-only auth.
 */
router.get(
  "/:id/analytics",
  publicReadLimiter,
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const asset = await getAsset(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const signatureHex = req.header("x-stellar-signature");
    const account = req.header("x-stellar-account");

    if (!signatureHex || !account) {
      return res.status(401).json({ error: "Missing signature or account headers" });
    }

    if (account !== asset.owner) {
      return res.status(403).json({ error: "Not the asset owner" });
    }

    const { Keypair } = require("@stellar/stellar-sdk");
    try {
      const kp = Keypair.fromPublicKey(account);
      // We expect the signed message to be the stringified asset id
      const message = Buffer.from(req.params.id.toString());
      const signature = Buffer.from(signatureHex, "hex");
      if (!kp.verify(message, signature)) {
        return res.status(403).json({ error: "Invalid signature" });
      }
    } catch (err) {
      return res.status(401).json({ error: "Invalid signature format" });
    }

    const { getAssetAnalytics } = require("../repositories/analyticsRepository");
    const data = await getAssetAnalytics(asset.id);
    res.json(data);
  })
);

/**
 * POST /api/v1/assets
 * Index an asset (called by event listener after on-chain listing).
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
 * POST /api/v1/assets/:id/purchase
 * Purchase a license for an asset. Creates the license row and bumps the
 * asset's usage counter in a single transaction.
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
 * POST /api/v1/assets/:id/report
 * File a moderation report against an asset. Auto-flags the asset once its
 * report count crosses reportService.FLAG_THRESHOLD.
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
 * GET /api/v1/assets/:id/price
 * Get current converted price in a requested token with commitment payload.
 * Query param: token (Stellar address)
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
 * GET /api/v1/assets/:id/usage
 * Calls-and-revenue time series for the owner's analytics dashboard.
 * Defaults to the last 7 days, bucketed daily.
 */
router.get(
  "/:id/usage",
  publicReadLimiter,
  [
    param("id").isInt({ min: 1 }),
    query("owner").isString().isLength({ min: 56, max: 56 }),
    query("from").optional().isInt({ min: 0 }),
    query("to").optional().isInt({ min: 0 }),
    query("bucketSeconds").optional().isInt({ min: 60 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await assetAnalyticsService.getUsageSeries({
      assetId: Number(req.params.id),
      owner: req.query.owner,
      from: req.query.from !== undefined ? Number(req.query.from) : undefined,
      to: req.query.to !== undefined ? Number(req.query.to) : undefined,
      bucketSeconds: req.query.bucketSeconds !== undefined ? Number(req.query.bucketSeconds) : undefined,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/assets/:id/top-callers
 * Busiest callers for the asset in a window, most calls first.
 * Defaults to the last 30 days.
 */
router.get(
  "/:id/top-callers",
  publicReadLimiter,
  [
    param("id").isInt({ min: 1 }),
    query("owner").isString().isLength({ min: 56, max: 56 }),
    query("from").optional().isInt({ min: 0 }),
    query("to").optional().isInt({ min: 0 }),
    query("limit").optional().isInt({ min: 1, max: 50 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await assetAnalyticsService.getTopCallers({
      assetId: Number(req.params.id),
      owner: req.query.owner,
      from: req.query.from !== undefined ? Number(req.query.from) : undefined,
      to: req.query.to !== undefined ? Number(req.query.to) : undefined,
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/assets/:id/revenue-breakdown
 * Revenue for the asset broken down by license type.
 */
router.get(
  "/:id/revenue-breakdown",
  publicReadLimiter,
  [param("id").isInt({ min: 1 }), query("owner").isString().isLength({ min: 56, max: 56 })],
  validate,
  asyncHandler(async (req, res) => {
    const result = await assetAnalyticsService.getRevenueBreakdown({
      assetId: Number(req.params.id),
      owner: req.query.owner,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/assets/:id/remaining-calls
 * Aggregate remaining-call runway across active usage-based licenses.
 */
router.get(
  "/:id/remaining-calls",
  publicReadLimiter,
  [param("id").isInt({ min: 1 }), query("owner").isString().isLength({ min: 56, max: 56 })],
  validate,
  asyncHandler(async (req, res) => {
    const result = await assetAnalyticsService.getRemainingCalls({
      assetId: Number(req.params.id),
      owner: req.query.owner,
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/assets/types/list
 * Return all valid asset types and license types.
 */
router.get("/types/list", publicReadLimiter, (_req, res) => {
  res.json({ assetTypes: ASSET_TYPES, licenseTypes: LICENSE_TYPES });
});

module.exports = router;

// Note: search queries are logged at debug level for analytics
