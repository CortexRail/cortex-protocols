/**
 * MerkleBatchBuilder — collapses N attestations into one 32-byte commitment.
 *
 * The point of the tree is cost. Putting 50 attestations on-chain costs 50
 * writes; putting their root on-chain costs one, and the buyer keeps the same
 * guarantee, because any single attestation the seller later denies (or
 * invents) can be proven in or out of that root with log2(N) sibling hashes.
 *
 * ── Batch invariants ─────────────────────────────────────────────────────────
 * A batch must cover a *contiguous* run of call indices:
 *
 *     call_index[i] === first_call_index + i
 *
 * This is not incidental tidiness. It is what makes the on-chain void
 * arithmetic decidable: given only `first_call_index` and `call_count` (both
 * committed on-chain) the contract can turn a disputed leaf's `call_index`
 * into its position in the batch, and therefore into a refund amount, without
 * ever seeing the other leaves. A gap in the run would make that arithmetic a
 * lie, so `build()` refuses to produce a root for one.
 *
 * ── Odd levels ───────────────────────────────────────────────────────────────
 * When a level has an odd node count the last node is paired with itself. That
 * is the common convention and it is safe here because domain-separated leaf
 * and internal hashes cannot collide (see canonical.js).
 */

const {
  HASH_BYTES,
  leafHash,
  hashInternal,
  toFixedBuffer,
  batchCommitmentMessage,
} = require("./canonical");

/** Build every level of the tree, leaves first, root last. */
function buildLevels(leafHashes) {
  const levels = [leafHashes];
  let current = leafHashes;

  while (current.length > 1) {
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      // Odd tail pairs with itself.
      const right = i + 1 < current.length ? current[i + 1] : current[i];
      next.push(hashInternal(left, right));
    }
    levels.push(next);
    current = next;
  }

  return levels;
}

class MerkleBatchBuilder {
  /**
   * Build a batch commitment over an ordered set of attestations.
   *
   * @param {Array<object>} attestations - in call_index order, contiguous
   * @returns {{
   *   root: string, callCount: number, firstCallIndex: number,
   *   lastCallIndex: number, leaves: string[], levels: string[][],
   *   attestations: Array<object>
   * }}
   */
  static build(attestations) {
    if (!Array.isArray(attestations) || attestations.length === 0) {
      throw new Error("a batch needs at least one attestation");
    }

    const streamId = Number(attestations[0].stream_id);
    const firstCallIndex = Number(attestations[0].call_index);

    attestations.forEach((att, i) => {
      if (Number(att.stream_id) !== streamId) {
        throw new Error(
          `batch mixes streams: position ${i} is stream ${att.stream_id}, expected ${streamId}`
        );
      }
      const expected = firstCallIndex + i;
      if (Number(att.call_index) !== expected) {
        throw new Error(
          `batch must cover a contiguous index range: position ${i} has call_index ` +
            `${att.call_index}, expected ${expected}`
        );
      }
    });

    const leafBuffers = attestations.map((att) => leafHash(att));
    const levels = buildLevels(leafBuffers);

    return {
      streamId,
      root: levels[levels.length - 1][0].toString("hex"),
      callCount: attestations.length,
      firstCallIndex,
      lastCallIndex: firstCallIndex + attestations.length - 1,
      leaves: leafBuffers.map((b) => b.toString("hex")),
      levels: levels.map((level) => level.map((b) => b.toString("hex"))),
      attestations,
    };
  }

  /**
   * Sibling hashes proving `position`'s leaf is in the root, bottom level up.
   *
   * @param {object} batch - the value returned by build()
   * @param {number} position - 0-based index within the batch
   * @returns {string[]} hex sibling hashes
   */
  static proofForPosition(batch, position) {
    if (!Number.isInteger(position) || position < 0 || position >= batch.callCount) {
      throw new Error(`position ${position} is outside a batch of ${batch.callCount}`);
    }

    const proof = [];
    let index = position;

    // Stop before the root level: the root has no sibling.
    for (let level = 0; level < batch.levels.length - 1; level++) {
      const nodes = batch.levels[level];
      const isRightChild = index % 2 === 1;
      const siblingIndex = isRightChild ? index - 1 : index + 1;
      // An odd tail was paired with itself, so its sibling is itself.
      proof.push(siblingIndex < nodes.length ? nodes[siblingIndex] : nodes[index]);
      index = Math.floor(index / 2);
    }

    return proof;
  }

  /** Proof for a leaf addressed by its call_index rather than its position. */
  static proofForCallIndex(batch, callIndex) {
    const position = Number(callIndex) - batch.firstCallIndex;
    if (position < 0 || position >= batch.callCount) {
      throw new Error(
        `call_index ${callIndex} is outside batch range ` +
          `[${batch.firstCallIndex}, ${batch.lastCallIndex}]`
      );
    }
    return MerkleBatchBuilder.proofForPosition(batch, position);
  }

  /**
   * Recompute a root from a leaf and its siblings — the same walk the contract
   * does, kept here so a buyer can pre-check a challenge before paying for it.
   *
   * @param {Buffer|string} leaf - 32-byte leaf hash
   * @param {string[]} proof - sibling hashes, bottom up
   * @returns {string} hex root
   */
  static rootFromProof(leaf, proof) {
    let node = toFixedBuffer(leaf, HASH_BYTES, "leaf");
    for (const sibling of proof) {
      node = hashInternal(node, toFixedBuffer(sibling, HASH_BYTES, "proof element"));
    }
    return node.toString("hex");
  }

  /** True when `attestation` is committed under `root` by `proof`. */
  static verifyProof(attestation, proof, root) {
    try {
      const computed = MerkleBatchBuilder.rootFromProof(leafHash(attestation), proof);
      return computed === String(root).toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Sign the batch commitment with the seller's key.
   *
   * Covers `0x02 || stream_id || merkle_root || call_count`, the same bytes
   * `record_usage_batch` reconstructs and checks against the seller's
   * registered attestation key.
   *
   * @param {object} batch - from build()
   * @param {object} signer - Stellar Keypair (or anything with .sign/.publicKey)
   */
  static signBatch(batch, signer) {
    const message = batchCommitmentMessage({
      stream_id: batch.streamId,
      merkle_root: batch.root,
      call_count: batch.callCount,
    });

    return {
      merkleRoot: batch.root,
      callCount: batch.callCount,
      firstCallIndex: batch.firstCallIndex,
      streamId: batch.streamId,
      batchSignature: Buffer.from(signer.sign(message)).toString("hex"),
      signer: signer.publicKey(),
    };
  }

  /**
   * Verify a batch commitment signature without trusting whoever relayed it.
   */
  static verifyBatchSignature({ streamId, merkleRoot, callCount, batchSignature }, publicKey) {
    const { verifySignatureRaw } = require("./AttestationVerifier");
    return verifySignatureRaw(
      batchCommitmentMessage({
        stream_id: streamId,
        merkle_root: merkleRoot,
        call_count: callCount,
      }),
      batchSignature,
      publicKey
    );
  }
}

module.exports = MerkleBatchBuilder;
