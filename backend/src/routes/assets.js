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

const router = Router();

/**
 * GET /api/v1/assets
 * List intelligence assets with optional filtering & pagination.
 */
router.get(
  "/",
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
 * POST /api/v1/assets
 * Index an asset (called by event listener after on-chain listing).
 */
router.post(
  "/",
  [
    body("id").isInt({ min: 1 }),
    body("owner").isString().isLength({ min: 56, max: 56 }),
    body("name").isString().trim().isLength({ min: 1, max: 200 }),
    body("description").isString().trim().isLength({ min: 1, max: 2000 }),
    body("assetType").isIn(ASSET_TYPES),
    body("licenseType").isIn(LICENSE_TYPES),
    body("price").isInt({ min: 0 }),
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
  [
    param("id").isInt({ min: 1 }),
    body("buyer").isString().isLength({ min: 56, max: 56 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const result = await purchaseLicense({
      assetId: Number(req.params.id),
      buyer: req.body.buyer,
    });
    res.status(201).json(result);
  })
);

/**
 * GET /api/v1/assets/types/list
 * Return all valid asset types and license types.
 */
router.get("/types/list", (_req, res) => {
  res.json({ assetTypes: ASSET_TYPES, licenseTypes: LICENSE_TYPES });
});

module.exports = router;

// Note: search queries are logged at debug level for analytics
