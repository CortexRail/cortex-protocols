/**
 * Attestation repository — all SQL touching attestation_batches,
 * attestation_leaves and used_nonces.
 *
 * Split by hot path vs. audit path:
 *
 *   - `recordLeaf` / `burnNonce` / `highestCallIndex` run inside the metering
 *     transaction. They do one statement each and read nothing back that the
 *     caller does not need.
 *   - Everything else serves batching, the buyer's attestation page, and the
 *     dispute flow, where a couple of extra round trips are irrelevant.
 *
 * Every function takes an optional trailing `client` so it can join a
 * caller-managed transaction, per the repoUtils contract.
 */

const { run, toMs, normalizePagination, buildMeta } = require("./repoUtils");

const LEAF_COLUMNS = `
  id, batch_ref, stream_id, call_index, request_hash, response_hash,
  attested_at, nonce, signature, signer, leaf_hash, verify_reason, created_at
`;

const BATCH_COLUMNS = `
  id, stream_id, batch_id, seller, merkle_root, call_count, first_call_index,
  last_call_index, batch_signature, status, voided_calls, refunded_amount,
  tx_hash, recorded_at, created_at, updated_at
`;

/**
 * Row → the attestation shape the crypto layer expects.
 *
 * The signed fields keep their snake_case wire names (canonical.js reads them
 * by those exact keys); the bookkeeping fields around them use the camelCase
 * the rest of the repository layer returns. Mixing the two conventions in one
 * object is deliberate — renaming a signed field on the way out would mean
 * renaming it back before every verification.
 */
function mapLeaf(row) {
  if (!row) return null;
  return {
    stream_id: Number(row.stream_id),
    call_index: Number(row.call_index),
    request_hash: row.request_hash,
    response_hash: row.response_hash,
    timestamp: Number(row.attested_at),
    nonce: row.nonce,
    signature: row.signature,
    signer: row.signer,
    leaf_hash: row.leaf_hash,

    id: row.id,
    batchRef: row.batch_ref,
    verifyReason: row.verify_reason,
    createdAt: toMs(row.created_at),
  };
}

function mapBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    streamId: Number(row.stream_id),
    batchId: row.batch_id === null ? null : Number(row.batch_id),
    seller: row.seller,
    merkleRoot: row.merkle_root,
    callCount: Number(row.call_count),
    firstCallIndex: Number(row.first_call_index),
    lastCallIndex: Number(row.last_call_index),
    batchSignature: row.batch_signature,
    status: row.status,
    voidedCalls: Number(row.voided_calls),
    refundedAmount: Number(row.refunded_amount),
    txHash: row.tx_hash,
    recordedAt: toMs(row.recorded_at),
    createdAt: toMs(row.created_at),
    updatedAt: toMs(row.updated_at),
  };
}

// ── Leaves ───────────────────────────────────────────────────────────────────

/**
 * Archive one attestation.
 *
 * ON CONFLICT DO NOTHING on (stream_id, call_index) makes this idempotent: a
 * retried metering request re-inserts the same leaf rather than erroring. The
 * RETURNING clause is empty on conflict, so the caller gets null and can tell
 * the two cases apart.
 */
async function recordLeaf(leaf, client) {
  const { rows } = await run(
    `INSERT INTO attestation_leaves
       (batch_ref, stream_id, call_index, request_hash, response_hash,
        attested_at, nonce, signature, signer, leaf_hash, verify_reason)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (stream_id, call_index) DO NOTHING
     RETURNING ${LEAF_COLUMNS}`,
    [
      leaf.stream_id,
      leaf.call_index,
      leaf.request_hash,
      leaf.response_hash,
      leaf.timestamp,
      leaf.nonce,
      leaf.signature,
      leaf.signer,
      leaf.leaf_hash,
      leaf.verifyReason || "OK",
    ],
    client
  );
  return mapLeaf(rows[0]);
}

/** The un-batched tail of a stream, oldest call first. */
async function findUnbatchedLeaves(streamId, limit = 100, client) {
  const { rows } = await run(
    `SELECT ${LEAF_COLUMNS}
       FROM attestation_leaves
      WHERE stream_id = $1 AND batch_ref IS NULL
      ORDER BY call_index ASC
      LIMIT $2`,
    [streamId, limit],
    client
  );
  return rows.map(mapLeaf);
}

/** Every leaf in a batch, in call order — the archive a buyer audits. */
async function findLeavesByBatchRef(batchRef, client) {
  const { rows } = await run(
    `SELECT ${LEAF_COLUMNS}
       FROM attestation_leaves
      WHERE batch_ref = $1
      ORDER BY call_index ASC`,
    [batchRef],
    client
  );
  return rows.map(mapLeaf);
}

async function findLeafByCallIndex(streamId, callIndex, client) {
  const { rows } = await run(
    `SELECT ${LEAF_COLUMNS}
       FROM attestation_leaves
      WHERE stream_id = $1 AND call_index = $2`,
    [streamId, callIndex],
    client
  );
  return mapLeaf(rows[0]);
}

/** Claim a contiguous run of leaves for a batch. */
async function attachLeavesToBatch(batchRef, streamId, firstCallIndex, lastCallIndex, client) {
  const { rowCount } = await run(
    `UPDATE attestation_leaves
        SET batch_ref = $1
      WHERE stream_id = $2
        AND batch_ref IS NULL
        AND call_index BETWEEN $3 AND $4`,
    [batchRef, streamId, firstCallIndex, lastCallIndex],
    client
  );
  return rowCount;
}

// ── Nonces ───────────────────────────────────────────────────────────────────

/**
 * Burn a nonce. Returns false when it was already spent on this stream, which
 * is the replay signal — the unique constraint does the work, so two concurrent
 * metering transactions cannot both win.
 */
async function burnNonce(streamId, nonce, callIndex, client) {
  const { rowCount } = await run(
    `INSERT INTO used_nonces (stream_id, nonce, call_index)
     VALUES ($1, $2, $3)
     ON CONFLICT (stream_id, nonce) DO NOTHING`,
    [streamId, nonce, callIndex],
    client
  );
  return rowCount > 0;
}

async function isNonceUsed(streamId, nonce, client) {
  const { rows } = await run(
    `SELECT 1 FROM used_nonces WHERE stream_id = $1 AND nonce = $2`,
    [streamId, nonce],
    client
  );
  return rows.length > 0;
}

/**
 * Highest call_index ever accepted on a stream, or null for a fresh stream.
 *
 * Read from used_nonces rather than attestation_leaves so the monotonic rule
 * survives a leaf being voided or archived away: a spent index stays spent.
 */
async function highestCallIndex(streamId, client) {
  const { rows } = await run(
    `SELECT MAX(call_index) AS highest FROM used_nonces WHERE stream_id = $1`,
    [streamId],
    client
  );
  const highest = rows[0]?.highest;
  return highest === null || highest === undefined ? null : Number(highest);
}

// ── Batches ──────────────────────────────────────────────────────────────────

async function createBatch(batch, client) {
  const { rows } = await run(
    `INSERT INTO attestation_batches
       (stream_id, seller, merkle_root, call_count, first_call_index,
        last_call_index, batch_signature, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING ${BATCH_COLUMNS}`,
    [
      batch.streamId,
      batch.seller,
      batch.merkleRoot,
      batch.callCount,
      batch.firstCallIndex,
      batch.lastCallIndex,
      batch.batchSignature,
    ],
    client
  );
  return mapBatch(rows[0]);
}

/** Record the on-chain outcome of a submitted batch. */
async function markRecorded(id, { batchId, txHash }, client) {
  const { rows } = await run(
    `UPDATE attestation_batches
        SET batch_id = $2, tx_hash = $3, status = 'recorded',
            recorded_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING ${BATCH_COLUMNS}`,
    [id, batchId, txHash || null],
    client
  );
  return mapBatch(rows[0]);
}

/**
 * Mirror a successful challenge.
 *
 * A batch lands in 'voided' when every call was reversed and 'challenged' when
 * only a suffix was — the distinction the frontend renders, and the reason
 * voided_calls is stored rather than inferred from the status.
 */
async function markVoided(id, { voidedCalls, refundedAmount, txHash }, client) {
  const { rows } = await run(
    `UPDATE attestation_batches
        SET voided_calls = $2,
            refunded_amount = $3,
            tx_hash = COALESCE($4, tx_hash),
            status = CASE WHEN $2 >= call_count THEN 'voided' ELSE 'challenged' END,
            updated_at = now()
      WHERE id = $1
      RETURNING ${BATCH_COLUMNS}`,
    [id, voidedCalls, refundedAmount, txHash || null],
    client
  );
  return mapBatch(rows[0]);
}

async function findBatchById(id, client) {
  const { rows } = await run(
    `SELECT ${BATCH_COLUMNS} FROM attestation_batches WHERE id = $1`,
    [id],
    client
  );
  return mapBatch(rows[0]);
}

/** Look a batch up by the id the contract assigned it. */
async function findBatchByOnChainId(streamId, batchId, client) {
  const { rows } = await run(
    `SELECT ${BATCH_COLUMNS}
       FROM attestation_batches
      WHERE stream_id = $1 AND batch_id = $2`,
    [streamId, batchId],
    client
  );
  return mapBatch(rows[0]);
}

/** Paginated batch list for one stream, newest first. */
async function findBatchesByStream(streamId, pagination = {}, client) {
  const { page, limit, offset } = normalizePagination(pagination);

  const [list, count] = await Promise.all([
    run(
      `SELECT ${BATCH_COLUMNS}
         FROM attestation_batches
        WHERE stream_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2 OFFSET $3`,
      [streamId, limit, offset],
      client,
      "read"
    ),
    run(
      `SELECT COUNT(*)::int AS total FROM attestation_batches WHERE stream_id = $1`,
      [streamId],
      client,
      "read"
    ),
  ]);

  const total = count.rows[0]?.total ?? 0;
  return { data: list.rows.map(mapBatch), meta: buildMeta(total, page, limit) };
}

async function findPendingBatches(limit = 50, client) {
  const { rows } = await run(
    `SELECT ${BATCH_COLUMNS}
       FROM attestation_batches
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
    client
  );
  return rows.map(mapBatch);
}

/**
 * Postgres-backed stores for AttestationVerifier.
 *
 * The verifier calls `has` then `add`; both take the pg client the metering
 * transaction is already holding, so a nonce is only durably burnt if the call
 * it paid for was also durably billed.
 */
function createStores() {
  return {
    nonceStore: {
      has: (streamId, nonce, client) => isNonceUsed(streamId, nonce, client),
      add: (streamId, nonce, client, callIndex) =>
        burnNonce(streamId, nonce, callIndex, client),
    },
    indexStore: {
      highest: (streamId, client) => highestCallIndex(streamId, client),
      // used_nonces carries call_index on the row the nonce store just wrote,
      // so the high-water mark needs no separate write of its own.
      set: async () => {},
    },
  };
}

module.exports = {
  recordLeaf,
  findUnbatchedLeaves,
  findLeavesByBatchRef,
  findLeafByCallIndex,
  attachLeavesToBatch,
  burnNonce,
  isNonceUsed,
  highestCallIndex,
  createBatch,
  markRecorded,
  markVoided,
  findBatchById,
  findBatchByOnChainId,
  findBatchesByStream,
  findPendingBatches,
  createStores,
  mapLeaf,
  mapBatch,
};
