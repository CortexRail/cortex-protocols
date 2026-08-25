/**
 * Channel repository — all SQL touching the `channels` table lives here.
 *
 * `findOpenChannel` is the hook metering routing decisions go through:
 * "route through a channel when one exists for (buyer, seller), falling
 * back to the existing stream path when it does not" is exactly a call to
 * this function before falling back to the stream lookup already used by
 * MeteringEngine.
 */

const { run, toMs } = require("./repoUtils");

const COLUMNS = `
  id, party_a, party_b, token, deposit_a, deposit_b, status,
  closer, dispute_deadline, indexed_at, updated_at
`;

function mapChannel(row) {
  if (!row) return null;
  return {
    id: row.id,
    partyA: row.party_a,
    partyB: row.party_b,
    token: row.token,
    depositA: row.deposit_a,
    depositB: row.deposit_b,
    status: row.status,
    closer: row.closer,
    disputeDeadline: row.dispute_deadline,
    indexedAt: toMs(row.indexed_at),
    updatedAt: toMs(row.updated_at),
  };
}

/**
 * Upsert a channel by its on-chain id — the indexer's entry point whenever
 * it observes `OPENED`, `UNILATERAL_CLOSE`, `DISPUTED`, `COOP_CLS`,
 * `PUNISHED`, or `FRC_CLS` on the channels contract.
 */
async function upsert(channel, client) {
  const {
    id,
    partyA,
    partyB,
    token,
    depositA,
    depositB,
    status = "Open",
    closer = null,
    disputeDeadline = null,
  } = channel;

  const { rows } = await run(
    `INSERT INTO channels
       (id, party_a, party_b, token, deposit_a, deposit_b, status, closer, dispute_deadline)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       status           = EXCLUDED.status,
       closer           = EXCLUDED.closer,
       dispute_deadline = EXCLUDED.dispute_deadline,
       updated_at       = now()
     RETURNING ${COLUMNS}`,
    [id, partyA, partyB, token, depositA, depositB, status, closer, disputeDeadline],
    client
  );
  return mapChannel(rows[0]);
}

/**
 * The channel a buyer would use to pay a seller right now, if any — an
 * open channel between the two addresses for this token. Direction-agnostic:
 * `party_a`/`party_b` on-chain doesn't imply buyer/seller, so this checks
 * both orderings.
 */
async function findOpenChannel(buyer, seller, token, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM channels
     WHERE status = 'Open'
       AND token = $3
       AND ((party_a = $1 AND party_b = $2) OR (party_a = $2 AND party_b = $1))
     ORDER BY id DESC
     LIMIT 1`,
    [buyer, seller, token],
    client,
    "read"
  );
  return mapChannel(rows[0]);
}

async function findById(id, client) {
  const { rows } = await run(
    `SELECT ${COLUMNS} FROM channels WHERE id = $1`,
    [id],
    client,
    "read"
  );
  return mapChannel(rows[0]);
}

async function updateStatus(id, status, { closer = undefined, disputeDeadline = undefined } = {}, client) {
  const { rows } = await run(
    `UPDATE channels SET
       status           = $2,
       closer           = COALESCE($3, closer),
       dispute_deadline = COALESCE($4, dispute_deadline),
       updated_at       = now()
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, status, closer ?? null, disputeDeadline ?? null],
    client
  );
  return mapChannel(rows[0]);
}

module.exports = {
  upsert,
  findOpenChannel,
  findById,
  updateStatus,
  _mapChannel: mapChannel,
};
