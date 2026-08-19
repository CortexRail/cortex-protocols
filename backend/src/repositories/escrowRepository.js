/**
 * Escrow Repository — SQL database interactions for `escrow_holds`.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = `
  license_id, buyer, seller, token, amount, created_ledger, hold_until_ledger,
  status, created_at, updated_at
`;

function mapEscrow(row) {
  if (!row) return null;
  return {
    licenseId: Number(row.license_id),
    buyer: row.buyer,
    seller: row.seller,
    token: row.token,
    amount: row.amount,
    createdLedger: Number(row.created_ledger),
    holdUntilLedger: Number(row.hold_until_ledger),
    status: row.status,
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

async function upsert(escrow, client) {
  const {
    licenseId,
    buyer,
    seller,
    token,
    amount,
    createdLedger,
    holdUntilLedger,
    status = "Held",
  } = escrow;

  const { rows } = await run(
    `INSERT INTO escrow_holds
       (license_id, buyer, seller, token, amount, created_ledger, hold_until_ledger, status)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (license_id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = now()
     RETURNING ${COLUMNS}`,
    [licenseId, buyer, seller, token, amount, createdLedger, holdUntilLedger, status],
    client
  );
  return mapEscrow(rows[0]);
}

async function findByLicenseId(licenseId, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM escrow_holds WHERE license_id = $1`,
    [licenseId],
    client
  );
  return mapEscrow(rows[0]);
}

async function updateStatus(licenseId, status, client) {
  const { rows } = await run(
    `UPDATE escrow_holds SET status = $2, updated_at = now()
     WHERE license_id = $1
     RETURNING ${COLUMNS}`,
    [licenseId, status],
    client
  );
  return mapEscrow(rows[0]);
}

async function findAllByBuyer(buyer, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM escrow_holds WHERE buyer = $1 ORDER BY created_at DESC`,
    [buyer],
    client
  );
  return rows.map(mapEscrow);
}

module.exports = {
  upsert,
  findByLicenseId,
  updateStatus,
  findAllByBuyer,
};
