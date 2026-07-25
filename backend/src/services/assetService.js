/**
 * Asset service — same public interface as the old in-memory version,
 * now backed by PostgreSQL through assetRepository. All functions that
 * touch data are async; routes await them.
 */

const assetRepository = require("../repositories/assetRepository");

/**
 * Asset types matching the on-chain enum.
 */
const ASSET_TYPES = [
  "Prompt",
  "Workflow",
  "ReasoningChain",
  "Dataset",
  "Evaluator",
  "MemorySystem",
  "ModelInstruction",
  "Tool",
];

/**
 * License types matching the on-chain enum.
 */
const LICENSE_TYPES = ["Perpetual", "UsageBased", "Subscription", "OpenSource"];

/**
 * Index an asset from an on-chain event or direct API call.
 * Upserts by on-chain id, so re-indexing after contract updates is safe.
 */
async function indexAsset(assetData) {
  return assetRepository.create(assetData);
}

/**
 * Get all active assets with optional filtering, full-text search, and
 * pagination.
 */
async function listAssets({
  assetType,
  licenseType,
  minPrice,
  maxPrice,
  search,
  page = 1,
  limit = 20,
} = {}) {
  const filters = { assetType, licenseType, minPrice, maxPrice };
  const pagination = { page, limit };

  if (search) {
    return assetRepository.search(search, filters, pagination);
  }
  return assetRepository.findAll(filters, pagination);
}

/**
 * Get a single active asset by ID.
 */
async function getAsset(id) {
  return assetRepository.findById(id);
}

/**
 * Soft-delete an asset (called on delist event). The row is preserved for
 * audit and existing licenses; it disappears from queries.
 */
async function removeAsset(id) {
  return assetRepository.softDelete(id);
}

/**
 * Advance the current indexed version after an on-chain UPDATED event.
 */
async function updateAssetVersion(id, version) {
  return assetRepository.updateVersion(id, version);
}

/**
 * Normalize a tag string to lowercase kebab-case.
 */
function normalizeTag(tag) {
  return tag.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

module.exports = {
  indexAsset,
  listAssets,
  getAsset,
  removeAsset,
  updateAssetVersion,
  normalizeTag,
  ASSET_TYPES,
  LICENSE_TYPES,
};
