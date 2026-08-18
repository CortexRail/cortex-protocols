/**
 * AuditChainVerifier — walks the full audit_log chain and verifies that every
 * entry_hash is consistent with its payload and the preceding entry.
 *
 * Any row that has been modified after the fact will produce a hash mismatch.
 * The verifier reports exactly which seq is the first broken link, so the
 * scope of potential tampering is immediately localizable.
 *
 * Usage:
 *
 *   const verifier = new AuditChainVerifier();
 *   const result   = await verifier.verify();
 *   // result.valid === true  → chain is intact
 *   // result.valid === false → result.brokenAt is the first broken seq
 *
 * The verify() method streams rows in batches to avoid loading the entire
 * table into memory on large deployments.
 */

const { query } = require("../db/connection");
const { computeEntryHash, deterministicJson } = require("./AuditLogWriter");

const DEFAULT_BATCH_SIZE = 500;

class AuditChainVerifier {
  constructor({ batchSize = DEFAULT_BATCH_SIZE } = {}) {
    this.batchSize = batchSize;
  }

  /**
   * Verify the entire chain from seq=1 to the current maximum seq.
   *
   * @returns {Promise<VerifyResult>}
   */
  async verify() {
    const start = Date.now();
    let checkedCount = 0;
    let prevHash = "";
    let expectedSeq = 1;
    let offset = 0;

    while (true) {
      const { rows } = await query(
        `SELECT seq, event_type, actor, subject_id, payload, entry_hash, prev_hash
         FROM audit_log
         ORDER BY seq ASC
         LIMIT $1 OFFSET $2`,
        [this.batchSize, offset]
      );

      if (rows.length === 0) break;

      for (const row of rows) {
        const seq = Number(row.seq);

        // 1. Sequence continuity check — no gaps allowed.
        if (seq !== expectedSeq) {
          return {
            valid: false,
            brokenAt: seq,
            expectedSeq,
            reason: `sequence gap: expected seq ${expectedSeq}, found ${seq}`,
            checkedCount,
            durationMs: Date.now() - start,
          };
        }

        // 2. prev_hash linkage check.
        const storedPrevHash = row.prev_hash || "";
        if (storedPrevHash !== prevHash) {
          return {
            valid: false,
            brokenAt: seq,
            reason: `prev_hash mismatch at seq ${seq}: stored '${storedPrevHash}' expected '${prevHash}'`,
            checkedCount,
            durationMs: Date.now() - start,
          };
        }

        // 3. Recompute the entry hash and compare.
        const payloadJson = deterministicJson(row.payload);
        const recomputed = computeEntryHash({
          prevHash,
          seq,
          eventType: row.event_type,
          actor: row.actor,
          subjectId: row.subject_id || "",
          payloadJson,
        });

        if (recomputed !== row.entry_hash) {
          return {
            valid: false,
            brokenAt: seq,
            reason: `entry_hash mismatch at seq ${seq}: stored '${row.entry_hash}' recomputed '${recomputed}'`,
            checkedCount,
            durationMs: Date.now() - start,
          };
        }

        prevHash = row.entry_hash;
        expectedSeq = seq + 1;
        checkedCount++;
      }

      offset += rows.length;

      // If we got fewer rows than the batch size, we've reached the end.
      if (rows.length < this.batchSize) break;
    }

    return {
      valid: true,
      checkedCount,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Verify a specific range of the chain [fromSeq, toSeq].
   * Useful for spot-checks after a known good checkpoint (e.g. a Merkle anchor).
   *
   * @param {number} fromSeq - Inclusive lower bound.
   * @param {number} toSeq   - Inclusive upper bound.
   * @returns {Promise<VerifyResult>}
   */
  async verifyRange(fromSeq, toSeq) {
    const start = Date.now();

    // Fetch the entry just before the range to get the correct starting prevHash.
    let prevHash = "";
    if (fromSeq > 1) {
      const { rows } = await query(
        "SELECT entry_hash FROM audit_log WHERE seq = $1",
        [fromSeq - 1]
      );
      if (rows.length === 0) {
        return {
          valid: false,
          brokenAt: fromSeq - 1,
          reason: `entry preceding range (seq ${fromSeq - 1}) not found`,
          checkedCount: 0,
          durationMs: Date.now() - start,
        };
      }
      prevHash = rows[0].entry_hash;
    }

    const { rows } = await query(
      `SELECT seq, event_type, actor, subject_id, payload, entry_hash, prev_hash
       FROM audit_log
       WHERE seq >= $1 AND seq <= $2
       ORDER BY seq ASC`,
      [fromSeq, toSeq]
    );

    let checkedCount = 0;
    let expectedSeq = fromSeq;

    for (const row of rows) {
      const seq = Number(row.seq);

      if (seq !== expectedSeq) {
        return {
          valid: false,
          brokenAt: seq,
          expectedSeq,
          reason: `sequence gap in range: expected seq ${expectedSeq}, found ${seq}`,
          checkedCount,
          durationMs: Date.now() - start,
        };
      }

      const storedPrevHash = row.prev_hash || "";
      if (storedPrevHash !== prevHash) {
        return {
          valid: false,
          brokenAt: seq,
          reason: `prev_hash mismatch at seq ${seq}`,
          checkedCount,
          durationMs: Date.now() - start,
        };
      }

      const payloadJson = deterministicJson(row.payload);
      const recomputed = computeEntryHash({
        prevHash,
        seq,
        eventType: row.event_type,
        actor: row.actor,
        subjectId: row.subject_id || "",
        payloadJson,
      });

      if (recomputed !== row.entry_hash) {
        return {
          valid: false,
          brokenAt: seq,
          reason: `entry_hash mismatch at seq ${seq}`,
          checkedCount,
          durationMs: Date.now() - start,
        };
      }

      prevHash = row.entry_hash;
      expectedSeq = seq + 1;
      checkedCount++;
    }

    return {
      valid: true,
      checkedCount,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Verify that the audit log entries covered by an on-chain anchor's Merkle
   * root actually hash to the stored root.
   *
   * This is the independent integrity check — it proves that the backend
   * database hasn't diverged from what was committed on-chain.
   *
   * @param {{ fromSeq: number, toSeq: number, merkleRoot: string }} anchor
   * @returns {Promise<{ valid: boolean, computedRoot: string, storedRoot: string }>}
   */
  async verifyAnchor({ fromSeq, toSeq, merkleRoot }) {
    const { computeMerkleRoot } = require("./MerkleAnchor");

    const { rows } = await query(
      `SELECT entry_hash FROM audit_log
       WHERE seq >= $1 AND seq <= $2
       ORDER BY seq ASC`,
      [fromSeq, toSeq]
    );

    const hashes = rows.map((r) => r.entry_hash);
    const computedRoot = computeMerkleRoot(hashes);

    return {
      valid: computedRoot === merkleRoot,
      computedRoot,
      storedRoot: merkleRoot,
    };
  }
}

/**
 * @typedef {object} VerifyResult
 * @property {boolean} valid
 * @property {number} [brokenAt]     - First seq with an invalid hash (when !valid)
 * @property {number} [expectedSeq] - Expected seq when a gap was found
 * @property {string} [reason]       - Human-readable explanation (when !valid)
 * @property {number} checkedCount   - Number of entries verified before stopping
 * @property {number} durationMs     - Wall-clock time for the verification run
 */

module.exports = { AuditChainVerifier };
