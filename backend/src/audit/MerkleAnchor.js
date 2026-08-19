/**
 * MerkleAnchor — periodic Merkle-root anchoring of the audit log.
 *
 * Periodically (every ANCHOR_INTERVAL_ENTRIES new entries or
 * ANCHOR_INTERVAL_MS wall-clock time, whichever comes first) this module:
 *
 *   1. Reads all audit log entry_hashes since the last anchor.
 *   2. Computes a SHA-256 binary Merkle tree over those hashes.
 *   3. Submits the root to the on-chain AuditAnchorContract via
 *      stellarService.invokeContract(...).
 *   4. Records the anchor metadata in the `merkle_anchors` table.
 *
 * The Merkle proof lets any third party independently verify that a
 * specific audit entry was included in a given anchor without replaying
 * the entire log.
 *
 * # Merkle tree construction
 * - Leaves are the base64-encoded `entry_hash` values, SHA-256 hashed again.
 * - If the leaf count is odd, the last leaf is duplicated.
 * - Internal nodes are SHA-256( leftChild || rightChild ).
 * - The root is hex-encoded for readability; the on-chain call receives the
 *   raw 32-byte buffer.
 *
 * # Start / stop
 *   const anchor = MerkleAnchor.getInstance();
 *   anchor.start();
 *   anchor.stop(); // on shutdown
 */

const crypto = require("crypto");
const { query, withTransaction } = require("../db/connection");
const { AuditLogWriter, EVENT_TYPES } = require("./AuditLogWriter");

// Anchor triggers: whichever threshold is crossed first triggers an anchoring.
const ANCHOR_INTERVAL_ENTRIES = Number(process.env.AUDIT_ANCHOR_INTERVAL_ENTRIES) || 1000;
const ANCHOR_INTERVAL_MS = Number(process.env.AUDIT_ANCHOR_INTERVAL_MS) || 24 * 60 * 60 * 1000; // 24h
const POLL_INTERVAL_MS = Number(process.env.AUDIT_ANCHOR_POLL_MS) || 60_000; // check every 1min

// ── Merkle tree utilities ─────────────────────────────────────────────────────

/**
 * Hash a single leaf: SHA-256 of the raw entry_hash string (already base64).
 * This double-hashing prevents length-extension attacks.
 */
function hashLeaf(entryHash) {
  return crypto.createHash("sha256").update(entryHash, "utf8").digest();
}

/**
 * Hash two child buffers together to form a parent node.
 */
function hashPair(left, right) {
  const h = crypto.createHash("sha256");
  h.update(left);
  h.update(right);
  return h.digest();
}

/**
 * Compute the Merkle root over an array of entry_hash strings.
 *
 * Returns a hex string (64 chars). Returns the empty hex string
 * ("00...00") when the input array is empty.
 *
 * @param {string[]} entryHashes
 * @returns {string} 64-char hex string
 */
function computeMerkleRoot(entryHashes) {
  if (entryHashes.length === 0) {
    return "0".repeat(64);
  }

  let layer = entryHashes.map(hashLeaf);

  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i]; // duplicate last if odd
      next.push(hashPair(left, right));
    }
    layer = next;
  }

  return layer[0].toString("hex");
}

/**
 * Generate a Merkle inclusion proof for the entry at position `index`
 * (0-based) within the leaf array.
 *
 * The proof is an array of { sibling: hex, side: 'left'|'right' } objects
 * that can be passed to verifyMerkleProof() along with the leaf hash and root.
 *
 * @param {string[]} entryHashes
 * @param {number}   index        - 0-based index of the leaf to prove
 * @returns {Array<{ sibling: string, side: 'left'|'right' }>}
 */
function generateMerkleProof(entryHashes, index) {
  if (entryHashes.length === 0) return [];

  let layer = entryHashes.map(hashLeaf);
  let idx = index;
  const proof = [];

  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];

      // Check if our target is in this pair.
      if (i === idx || i + 1 === idx) {
        if (i === idx) {
          // Our leaf is left; sibling is right.
          proof.push({ sibling: right.toString("hex"), side: "right" });
        } else {
          // Our leaf is right; sibling is left.
          proof.push({ sibling: left.toString("hex"), side: "left" });
        }
      }

      next.push(hashPair(left, right));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Verify a Merkle inclusion proof.
 *
 * @param {string}   entryHash   - The entry_hash string for the leaf.
 * @param {Array<{ sibling: string, side: 'left'|'right' }>} proof
 * @param {string}   expectedRoot - Hex Merkle root to verify against.
 * @returns {boolean}
 */
function verifyMerkleProof(entryHash, proof, expectedRoot) {
  let current = hashLeaf(entryHash);

  for (const { sibling, side } of proof) {
    const sibBuf = Buffer.from(sibling, "hex");
    current = side === "right" ? hashPair(current, sibBuf) : hashPair(sibBuf, current);
  }

  return current.toString("hex") === expectedRoot;
}

// ── MerkleAnchor class ────────────────────────────────────────────────────────

class MerkleAnchor {
  constructor() {
    if (MerkleAnchor._instance) {
      throw new Error("Use MerkleAnchor.getInstance()");
    }
    this._timer = null;
    this._lastAnchorTime = Date.now();
    this._running = false;
  }

  static getInstance() {
    if (!MerkleAnchor._instance) {
      MerkleAnchor._instance = new MerkleAnchor();
    }
    return MerkleAnchor._instance;
  }

  /**
   * Start the periodic anchoring loop.
   */
  start() {
    if (this._timer) return;
    this._running = true;
    this._schedule();
    logger.info(`[MerkleAnchor] started (interval=${ANCHOR_INTERVAL_ENTRIES} entries / ${ANCHOR_INTERVAL_MS}ms)`);
  }

  /**
   * Stop the periodic anchoring loop gracefully.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logger.info("[MerkleAnchor] stopped");
  }

  _schedule() {
    if (!this._running) return;
    this._timer = setTimeout(async () => {
      try {
        await this._maybeAnchor();
      } catch (err) {
        logger.error("[MerkleAnchor] error during scheduled anchor check:", err.message);
      } finally {
        this._schedule();
      }
    }, POLL_INTERVAL_MS);
  }

  /**
   * Check whether a new anchor is needed and run it if so.
   */
  async _maybeAnchor() {
    const lastAnchor = await this._getLastAnchor();
    const lastAnchoredSeq = lastAnchor ? Number(lastAnchor.to_seq) : 0;

    const { rows: tailRows } = await query(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM audit_log"
    );
    const maxSeq = Number(tailRows[0].max_seq);

    if (maxSeq <= lastAnchoredSeq) return; // nothing new to anchor

    const newEntries = maxSeq - lastAnchoredSeq;
    const timeSinceLastAnchor = Date.now() - this._lastAnchorTime;

    if (newEntries < ANCHOR_INTERVAL_ENTRIES && timeSinceLastAnchor < ANCHOR_INTERVAL_MS) {
      return; // neither threshold crossed yet
    }

    await this.anchorNow(lastAnchoredSeq + 1, maxSeq);
  }

  /**
   * Immediately anchor all entries in the range [fromSeq, toSeq].
   * Can be called directly for on-demand anchoring.
   *
   * @param {number} fromSeq - Inclusive lower bound.
   * @param {number} toSeq   - Inclusive upper bound.
   * @returns {Promise<object>} The merkle_anchors row.
   */
  async anchorNow(fromSeq, toSeq) {
    if (fromSeq > toSeq) {
      throw new Error(`anchorNow: fromSeq (${fromSeq}) > toSeq (${toSeq})`);
    }

    logger.info(`[MerkleAnchor] anchoring entries ${fromSeq}–${toSeq}`);

    // Fetch entry_hashes in order.
    const { rows } = await query(
      `SELECT entry_hash FROM audit_log
       WHERE seq >= $1 AND seq <= $2
       ORDER BY seq ASC`,
      [fromSeq, toSeq]
    );

    if (rows.length === 0) {
      throw new Error(`No audit entries found in range [${fromSeq}, ${toSeq}]`);
    }

    const hashes = rows.map((r) => r.entry_hash);
    const merkleRoot = computeMerkleRoot(hashes);
    const entryCount = BigInt(toSeq); // total entries ever up to toSeq

    // Insert a 'pending' record before attempting the on-chain call.
    const { rows: insertRows } = await query(
      `INSERT INTO merkle_anchors (from_seq, to_seq, entry_count, merkle_root, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, from_seq, to_seq, entry_count, merkle_root, status, anchored_at`,
      [fromSeq, toSeq, hashes.length, merkleRoot]
    );
    const anchorRow = insertRows[0];

    // Attempt on-chain submission.
    let txHash = null;
    let anchorIndex = null;
    let onChainStatus = "submitted";
    let errorMessage = null;
    const contractId = process.env.AUDIT_ANCHOR_CONTRACT_ID;

    if (contractId) {
      try {
        const { invokeContract } = require("../services/stellarService");
        const { Keypair, xdr } = require("@stellar/stellar-sdk");

        const serverKeypair = Keypair.fromSecret(process.env.SERVER_SECRET_KEY);
        const rootBytes = Buffer.from(merkleRoot, "hex");
        const rootScVal = xdr.ScVal.scvBytes(rootBytes);
        const entryCountScVal = xdr.ScVal.scvU64(
          xdr.Uint64.fromString(entryCount.toString())
        );
        const adminScVal = require("@stellar/stellar-sdk").Address.fromString(
const { logger } = require("../utils/logger");
          serverKeypair.publicKey()
        ).toScVal();

        const result = await invokeContract(
          contractId,
          "anchor_root",
          [adminScVal, rootScVal, entryCountScVal],
          serverKeypair
        );

        // result is the AnchorRecord struct; extract index from it.
        if (result && result.index !== undefined) {
          anchorIndex = Number(result.index);
        }
        txHash = result?._txHash || null; // stellarService may surface this
        onChainStatus = "confirmed";

        logger.info(`[MerkleAnchor] anchored on-chain: root=${merkleRoot} index=${anchorIndex}`);
      } catch (err) {
        logger.error("[MerkleAnchor] on-chain submission failed:", err.message);
        errorMessage = err.message;
        onChainStatus = "failed";
      }
    } else {
      // No contract configured — record anchor as pending for later submission.
      logger.warn("[MerkleAnchor] AUDIT_ANCHOR_CONTRACT_ID not set; anchor stored locally only");
    }

    // Update the merkle_anchors record with the on-chain result.
    const { rows: updatedRows } = await query(
      `UPDATE merkle_anchors
       SET status = $2, on_chain_tx = $3, anchor_index = $4,
           error_message = $5, anchor_contract = $6
       WHERE id = $1
       RETURNING *`,
      [anchorRow.id, onChainStatus, txHash, anchorIndex, errorMessage, contractId || null]
    );

    this._lastAnchorTime = Date.now();

    // Write an audit log entry for the anchor event itself.
    const writer = AuditLogWriter.getInstance();
    await writer.append({
      eventType: onChainStatus === "confirmed"
        ? EVENT_TYPES.MERKLE_ANCHOR_CONFIRMED
        : EVENT_TYPES.MERKLE_ANCHOR_SUBMITTED,
      actor: "system",
      payload: {
        fromSeq,
        toSeq,
        merkleRoot,
        entryCount: hashes.length,
        anchorIndex,
        txHash,
        status: onChainStatus,
      },
    });

    return updatedRows[0];
  }

  /**
   * Fetch the latest entry from merkle_anchors.
   * @private
   */
  async _getLastAnchor() {
    const { rows } = await query(
      `SELECT * FROM merkle_anchors
       WHERE status IN ('submitted', 'confirmed')
       ORDER BY to_seq DESC
       LIMIT 1`
    );
    return rows[0] || null;
  }

  /**
   * Return all anchor records, newest first.
   *
   * @param {{ page?: number, limit?: number }} pagination
   * @returns {Promise<{ data: object[], meta: object }>}
   */
  async listAnchors({ page = 1, limit = 20 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, limit));
    const offset = (Math.max(1, page) - 1) * safeLimit;

    const countResult = await query(
      "SELECT count(*)::bigint AS total FROM merkle_anchors"
    );
    const total = Number(countResult.rows[0].total);

    const { rows } = await query(
      `SELECT id, from_seq, to_seq, entry_count, merkle_root,
              anchor_contract, on_chain_tx, anchor_index,
              status, error_message, anchored_at
       FROM merkle_anchors
       ORDER BY to_seq DESC
       LIMIT $1 OFFSET $2`,
      [safeLimit, offset]
    );

    return {
      data: rows.map(mapAnchor),
      meta: {
        total,
        page: Math.max(1, page),
        limit: safeLimit,
        pages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * Generate a Merkle inclusion proof for a specific audit log entry.
   *
   * @param {number} seq  - The audit log seq to prove inclusion for.
   * @returns {Promise<{ proof: object[], merkleRoot: string, anchorId: number } | null>}
   *   null if no anchor covers the given seq.
   */
  async proveInclusion(seq) {
    // Find the anchor that covers this seq.
    const { rows } = await query(
      `SELECT id, from_seq, to_seq, merkle_root
       FROM merkle_anchors
       WHERE from_seq <= $1 AND to_seq >= $1
         AND status = 'confirmed'
       ORDER BY to_seq ASC
       LIMIT 1`,
      [seq]
    );

    if (rows.length === 0) return null;

    const anchor = rows[0];
    const { from_seq, to_seq, merkle_root } = anchor;

    // Fetch all entry_hashes in the anchor's range.
    const { rows: hashRows } = await query(
      `SELECT entry_hash FROM audit_log
       WHERE seq >= $1 AND seq <= $2
       ORDER BY seq ASC`,
      [from_seq, to_seq]
    );

    const hashes = hashRows.map((r) => r.entry_hash);
    const leafIndex = seq - Number(from_seq);

    const proof = generateMerkleProof(hashes, leafIndex);

    return {
      anchorId: anchor.id,
      merkleRoot: merkle_root,
      fromSeq: Number(from_seq),
      toSeq: Number(to_seq),
      leafIndex,
      proof,
    };
  }
}

MerkleAnchor._instance = null;

function mapAnchor(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromSeq: Number(row.from_seq),
    toSeq: Number(row.to_seq),
    entryCount: Number(row.entry_count),
    merkleRoot: row.merkle_root,
    anchorContract: row.anchor_contract,
    onChainTx: row.on_chain_tx,
    anchorIndex: row.anchor_index !== null ? Number(row.anchor_index) : null,
    status: row.status,
    errorMessage: row.error_message,
    anchoredAt: row.anchored_at instanceof Date
      ? row.anchored_at.getTime()
      : Number(row.anchored_at),
  };
}

module.exports = {
  MerkleAnchor,
  computeMerkleRoot,
  generateMerkleProof,
  verifyMerkleProof,
};
