/**
 * Asset repository — all SQL touching the `assets` table lives here.
 */

const {
  run,
  toMs,
  msParam,
  normalizePagination,
  buildMeta,
  escapeLike,
} = require("./repoUtils");

const COLUMNS = `
  id, owner, name, description, asset_type, license_type, price,
  version, usage_count, is_active, tags, created_at, indexed_at, updated_at,
  deleted_at
`;

function availableVersions(version) {
  const minimumVersion = Math.max(1, version - 4);
  return Array.from(
    { length: version - minimumVersion + 1 },
    (_, index) => minimumVersion + index
  );
}

function mapAsset(row) {
  if (!row) return null;
  const version = Number(row.version);
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    description: row.description,
    assetType: row.asset_type,
    licenseType: row.license_type,
    price: row.price,
    version,
    availableVersions: availableVersions(version),
    usageCount: row.usage_count,
    isActive: row.is_active,
    tags: row.tags,
    createdAt: toMs(row.created_at),
    indexedAt: toMs(row.indexed_at),
    updatedAt: toMs(row.updated_at),
    deletedAt: toMs(row.deleted_at),
  };
}

/**
 * Upsert an asset by its on-chain id. Re-indexing an existing asset
 * refreshes every mutable field plus indexed_at.
 */
async function create(asset, client) {
  const hasVersion = asset.version !== undefined;
  const {
    id,
    owner,
    name,
    description = "",
    assetType,
    licenseType,
    price = 0,
    version = 1,
    usageCount = 0,
    isActive = true,
    tags = [],
    createdAt,
  } = asset;

  const { rows } = await run(
    `INSERT INTO assets
       (id, owner, name, description, asset_type, license_type, price, version,
        usage_count, is_active, tags, created_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb,
        COALESCE(to_timestamp($12::double precision / 1000.0), now()))
     ON CONFLICT (id) DO UPDATE SET
       owner        = EXCLUDED.owner,
       name         = EXCLUDED.name,
       description  = EXCLUDED.description,
       asset_type   = EXCLUDED.asset_type,
       license_type = EXCLUDED.license_type,
       price        = EXCLUDED.price,
       version      = CASE WHEN $13 THEN EXCLUDED.version ELSE assets.version END,
       usage_count  = EXCLUDED.usage_count,
       is_active    = EXCLUDED.is_active,
       tags         = EXCLUDED.tags,
       indexed_at   = now(),
       updated_at   = now()
     RETURNING ${COLUMNS}`,
    [
      id,
      owner,
      name,
      description,
      assetType,
      licenseType,
      price,
      version,
      usageCount,
      isActive,
      JSON.stringify(tags),
      msParam(createdAt),
      hasVersion,
    ],
    client
  );
  return mapAsset(rows[0]);
}

/**
 * Fetch one asset. Soft-deleted assets are hidden unless includeInactive.
 */
async function findById(id, { includeInactive = false } = {}, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM assets
     WHERE id = $1 ${includeInactive ? "" : "AND is_active"}`,
    [id],
    client
  );
  return mapAsset(rows[0]);
}

/**
 * Shared WHERE builder for findAll/search.
 */
function buildFilterClauses(filters, params) {
  const clauses = [];

  if (!filters.includeInactive) clauses.push("is_active");
  if (filters.assetType) {
    params.push(filters.assetType);
    clauses.push(`asset_type = $${params.length}`);
  }
  if (filters.licenseType) {
    params.push(filters.licenseType);
    clauses.push(`license_type = $${params.length}`);
  }
  if (filters.minPrice !== undefined && filters.minPrice !== null) {
    params.push(filters.minPrice);
    clauses.push(`price >= $${params.length}`);
  }
  if (filters.maxPrice !== undefined && filters.maxPrice !== null) {
    params.push(filters.maxPrice);
    clauses.push(`price <= $${params.length}`);
  }
  if (filters.owner) {
    params.push(filters.owner);
    clauses.push(`owner = $${params.length}`);
  }
  if (filters.tag) {
    params.push(JSON.stringify([filters.tag]));
    clauses.push(`tags @> $${params.length}::jsonb`);
  }

  return clauses;
}

/**
 * List assets with filters + pagination.
 */
async function findAll(filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);
  const params = [];
  const clauses = buildFilterClauses(filters, params);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM assets ${where}`,
    params,
    client
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM assets ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client
  );

  return { data: rows.map(mapAsset), meta: buildMeta(total, page, limit) };
}

/**
 * Full-text search over name/description (weighted tsvector) with a tag
 * substring fallback, ranked by relevance. Accepts the same filters as
 * findAll.
 */
async function search(queryText, filters = {}, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);

  const params = [queryText];
  const clauses = buildFilterClauses(filters, params);

  params.push(`%${escapeLike(queryText)}%`);
  const tagMatch = `EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(tags) AS t(tag)
      WHERE t.tag ILIKE $${params.length}
    )`;
  clauses.push(
    `(search_vector @@ plainto_tsquery('english', $1) OR ${tagMatch})`
  );

  const where = `WHERE ${clauses.join(" AND ")}`;

  const countResult = await run(
    `SELECT count(*)::bigint AS total FROM assets ${where}`,
    params,
    client
  );
  const total = Number(countResult.rows[0].total);

  params.push(limit, offset);
  const { rows } = await run(
    `SELECT ${COLUMNS},
            ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
     FROM assets ${where}
     ORDER BY rank DESC, created_at DESC, id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    client
  );

  return { data: rows.map(mapAsset), meta: buildMeta(total, page, limit) };
}

/**
 * Patch mutable fields. Returns the updated asset, or null if missing.
 */
async function update(id, patch, client) {
  const columnFor = {
    owner: "owner",
    name: "name",
    description: "description",
    assetType: "asset_type",
    licenseType: "license_type",
    price: "price",
    usageCount: "usage_count",
    isActive: "is_active",
    tags: "tags",
  };

  const sets = [];
  const params = [id];

  for (const [key, column] of Object.entries(columnFor)) {
    if (patch[key] === undefined) continue;
    const value = key === "tags" ? JSON.stringify(patch[key]) : patch[key];
    params.push(value);
    sets.push(
      `${column} = $${params.length}${key === "tags" ? "::jsonb" : ""}`
    );
  }

  if (sets.length === 0) {
    throw new Error("assetRepository.update: empty patch");
  }

  const { rows } = await run(
    `UPDATE assets SET ${sets.join(", ")}, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    params,
    client
  );
  return mapAsset(rows[0]);
}

/**
 * Soft delete — the row survives for audit/licenses; queries hide it.
 */
async function softDelete(id, client) {
  const { rowCount } = await run(
    `UPDATE assets
     SET is_active = FALSE, deleted_at = now(), updated_at = now()
     WHERE id = $1 AND is_active`,
    [id],
    client
  );
  return rowCount > 0;
}

/**
 * Atomically bump usage_count. Returns the new count, or null if missing.
 */
async function incrementUsage(id, client) {
  const { rows } = await run(
    `UPDATE assets SET usage_count = usage_count + 1, updated_at = now()
     WHERE id = $1
     RETURNING usage_count`,
    [id],
    client
  );
  return rows.length ? rows[0].usage_count : null;
}

/**
 * Advance an indexed asset to the version observed in an UPDATED event.
 * GREATEST prevents a replayed or out-of-order event from regressing the
 * current version. Returns null when the asset has not been indexed yet.
 */
async function updateVersion(id, version, client) {
  const { rows } = await run(
    `UPDATE assets
     SET version = GREATEST(version, $2), updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, version],
    client
  );
  return mapAsset(rows[0]);
}

module.exports = {
  create,
  findById,
  findAll,
  search,
  update,
  softDelete,
  incrementUsage,
  updateVersion,
};
