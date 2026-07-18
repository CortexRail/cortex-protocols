/**
 * License repository — all SQL touching the `licenses` table lives here.
 */

const { run, toMs, msParam, normalizePagination, buildMeta } = require("./repoUtils");

const COLUMNS = `
  id, asset_id, buyer, license_type, price_paid, calls_remaining,
  expires_at, is_active, purchased_at, updated_at
`;

function mapLicense(row) {
  if (!row) return null;
  return {
    id: row.id,
    assetId: row.asset_id,
    buyer: row.buyer,
    licenseType: row.license_type,
    pricePaid: row.price_paid,
    callsRemaining: row.calls_remaining,
    expiresAt: toMs(row.expires_at),
    isActive: row.is_active,
    purchasedAt: toMs(row.purchased_at),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Create a license. A partial unique index guarantees at most one ACTIVE
 * license per (asset, buyer) — violations surface as pg error 23505.
 */
async function create(license, client) {
  const {
    assetId,
    buyer,
    licenseType,
    pricePaid = 0,
    callsRemaining = null,
    expiresAt = null,
  } = license;

  const { rows } = await run(
    `INSERT INTO licenses
       (asset_id, buyer, license_type, price_paid, calls_remaining, expires_at)
     VALUES
       ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000.0))
     RETURNING ${COLUMNS}`,
    [assetId, buyer, licenseType, pricePaid, callsRemaining, msParam(expiresAt)],
    client
  );
  return mapLicense(rows[0]);
}

async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM licenses WHERE id = $1`,
    [id],
    client
  );
  return mapLicense(rows[0]);
}

/**
 * The buyer's currently-valid license for an asset, if any.
 */
async function findByBuyerAndAsset(buyer, assetId, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM licenses
     WHERE buyer = $1
       AND asset_id = $2
       AND is_active
       AND (expires_at IS NULL OR expires_at > now())`,
    [buyer, assetId],
    client
  );
  return mapLicense(rows[0]);
}

/**
 * Every license (active or not) a buyer has ever held, newest first.
 */
async function findAllByBuyer(buyer, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);

  const countResult = await run(
    "SELECT count(*)::bigint AS total FROM licenses WHERE buyer = $1",
    [buyer],
    client
  );
  const total = Number(countResult.rows[0].total);

  const { rows } = await run(
    `SELECT ${COLUMNS} FROM licenses
     WHERE buyer = $1
     ORDER BY purchased_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [buyer, limit, offset],
    client
  );

  return { data: rows.map(mapLicense), meta: buildMeta(total, page, limit) };
}

/**
 * Set the metered-call counter to an absolute value.
 */
async function updateCallsRemaining(id, callsRemaining, client) {
  const { rows } = await run(
    `UPDATE licenses SET calls_remaining = $2, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, callsRemaining],
    client
  );
  return mapLicense(rows[0]);
}

/**
 * Atomically consume one metered call.
 *
 * - unlimited licenses (calls_remaining IS NULL) pass through untouched
 * - metered licenses decrement only while calls remain
 * - exhausted or inactive licenses return null
 */
async function consumeCall(id, client) {
  const { rows } = await run(
    `UPDATE licenses
     SET calls_remaining = CASE
           WHEN calls_remaining IS NULL THEN NULL
           ELSE calls_remaining - 1
         END,
         updated_at = now()
     WHERE id = $1
       AND is_active
       AND (calls_remaining IS NULL OR calls_remaining > 0)
     RETURNING ${COLUMNS}`,
    [id],
    client
  );
  return mapLicense(rows[0]);
}

/**
 * Deactivate a license (subscription lapse, revocation, exhaustion).
 */
async function expire(id, client) {
  const { rows } = await run(
    `UPDATE licenses SET is_active = FALSE, updated_at = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id],
    client
  );
  return mapLicense(rows[0]);
}

module.exports = {
  create,
  findById,
  findByBuyerAndAsset,
  findAllByBuyer,
  updateCallsRemaining,
  consumeCall,
  expire,
};
