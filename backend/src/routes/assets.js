const { Router } = require("express");
const { body, query, param } = require("express-validator");
const validate = require("../middleware/validate");
const {
  listAssets,
  getAsset,
  indexAsset,
  ASSET_TYPES,
  LICENSE_TYPES,
} = require("../services/assetService");

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
    query("minPrice").optional().isInt({ min: 0 }),
    query("maxPrice").optional().isInt({ min: 0 }),
    query("search").optional().isString().trim().isLength({ max: 100 }),
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
  ],
  validate,
  (req, res) => {
    const { assetType, licenseType, minPrice, maxPrice, search, page, limit } =
      req.query;

    const result = listAssets({
      assetType,
      licenseType,
      minPrice: minPrice !== undefined ? Number(minPrice) : undefined,
      maxPrice: maxPrice !== undefined ? Number(maxPrice) : undefined,
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });

    res.json(result);
  }
);

/**
 * GET /api/v1/assets/:id
 * Get a single asset by its on-chain ID.
 */
router.get(
  "/:id",
  [param("id").isInt({ min: 1 })],
  validate,
  (req, res) => {
    const asset = getAsset(req.params.id);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }
    res.json(asset);
  }
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
  (req, res) => {
    const asset = indexAsset(req.body);
    res.status(201).json(asset);
  }
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
