/**
 * AttestationArchive — the off-chain half of the commitment.
 *
 * On-chain a batch is 32 bytes. That is enough to *detect* a lie but not enough
 * to *prove* one: to challenge a batch a buyer needs the actual attestations
 * that went into it, plus the sibling hashes linking the disputed one to the
 * committed root. This module stores those sets and serves them back.
 *
 * The archive is deliberately untrusted. Every leaf it returns carries the
 * seller's signature over its own contents, and `audit()` re-derives the root
 * from scratch rather than believing the stored `merkle_root`. A backend that
 * tampered with an archived row would produce a set whose recomputed root no
 * longer matches what is on-chain — which is exactly the failure the buyer is
 * checking for, and it is indistinguishable from a lying seller. Either way the
 * buyer learns not to trust the batch, which is the property we wanted.
 */

const attestationRepository = require("../repositories/attestationRepository");
const AttestationVerifier = require("./AttestationVerifier");
const MerkleBatchBuilder = require("./MerkleBatchBuilder");
const { batchCommitmentMessage, leafHash } = require("./canonical");
const { logger } = require("../utils/logger");

/** Default ceiling on batch size — keeps a proof at 7 hashes or fewer. */
const DEFAULT_MAX_BATCH = 128;

/**
 * Strip an archived leaf down to exactly the signed fields plus signature.
 * Passing the repository's extra bookkeeping keys into the hasher would be
 * harmless (the encoder reads named fields) but returning them to a buyer as
 * "the attestation" invites them to think those fields are covered too.
 */
function toWireAttestation(leaf) {
  return {
    stream_id: leaf.stream_id,
    call_index: leaf.call_index,
    request_hash: leaf.request_hash,
    response_hash: leaf.response_hash,
    timestamp: leaf.timestamp,
    nonce: leaf.nonce,
    signature: leaf.signature,
    signer: leaf.signer,
  };
}

class AttestationArchive {
  /**
   * @param {object} [deps]
   * @param {object} [deps.repository] - injectable for tests
   * @param {AttestationVerifier} [deps.verifier]
   */
  constructor(deps = {}) {
    this.repository = deps.repository || attestationRepository;
    this.verifier = deps.verifier || new AttestationVerifier();
  }

  /**
   * Archive one attestation. Idempotent on (stream_id, call_index).
   *
   * @param {object} attestation - as produced by AttestationBuilder
   * @param {object} [options]
   * @param {string} [options.verifyReason] - the verifier's verdict at metering
   * @param {*} [options.client] - pg client to join the metering transaction
   * @returns {object|null} the stored leaf, or null if it already existed
   */
  async archive(attestation, { verifyReason = "OK", client } = {}) {
    return this.repository.recordLeaf(
      {
        ...attestation,
        leaf_hash: attestation.leaf_hash || leafHash(attestation).toString("hex"),
        verifyReason,
      },
      client
    );
  }

  /**
   * Compute the Merkle tree over the un-batched tail of a stream, unsigned.
   *
   * Only the *contiguous* prefix of the tail is taken. If leaf 7 is missing
   * because its call was rejected, a batch of 5..6 goes out now and 8.. waits;
   * committing across the gap would break the arithmetic the contract uses to
   * price a void (see MerkleBatchBuilder's header).
   *
   * Stops short of signing because the backend does not have — and must never
   * have — the seller's key. It hands back the exact bytes to sign; the seller
   * signs them wherever that key lives and posts the signature to
   * `commitBatch`.
   *
   * @param {number} streamId
   * @param {object} [options]
   * @param {number} [options.maxSize]
   * @param {number} [options.minSize] - return null below this, so a caller can
   *   poll without emitting one-call batches
   * @returns {object|null} { tree, message } or null if there is nothing to do
   */
  async prepareBatch(streamId, { maxSize = DEFAULT_MAX_BATCH, minSize = 1 } = {}) {
    const pending = await this.repository.findUnbatchedLeaves(streamId, maxSize);
    if (pending.length < minSize) return null;

    // Cut at the first gap.
    const contiguous = [pending[0]];
    for (let i = 1; i < pending.length; i++) {
      if (pending[i].call_index !== contiguous[contiguous.length - 1].call_index + 1) break;
      contiguous.push(pending[i]);
    }
    if (contiguous.length < minSize) return null;

    const tree = MerkleBatchBuilder.build(contiguous.map(toWireAttestation));
    return {
      tree,
      // The seller signs these bytes; record_usage_batch reconstructs them.
      message: batchCommitmentMessage({
        stream_id: streamId,
        merkle_root: tree.root,
        call_count: tree.callCount,
      }).toString("hex"),
    };
  }

  /**
   * Persist a batch the seller has signed.
   *
   * The signature is re-verified here rather than taken on faith: a batch row
   * with a signature that does not check out would be rejected by
   * `record_usage_batch` anyway, and storing it would leave the archive
   * asserting a commitment nobody made.
   *
   * @param {number} streamId
   * @param {object} tree - from prepareBatch
   * @param {object} commitment
   * @param {string} commitment.seller - the seller's G... address
   * @param {string} commitment.batchSignature - hex, 64 bytes
   */
  async commitBatch(streamId, tree, { seller, batchSignature }) {
    const valid = MerkleBatchBuilder.verifyBatchSignature(
      {
        streamId: Number(streamId),
        merkleRoot: tree.root,
        callCount: tree.callCount,
        batchSignature,
      },
      seller
    );

    if (!valid) {
      const err = new Error("batch commitment signature does not verify under the seller key");
      err.status = 400;
      err.reason = "BAD_BATCH_SIGNATURE";
      throw err;
    }

    const batch = await this.repository.createBatch({
      streamId,
      seller,
      merkleRoot: tree.root,
      callCount: tree.callCount,
      firstCallIndex: tree.firstCallIndex,
      lastCallIndex: tree.lastCallIndex,
      batchSignature,
    });

    await this.repository.attachLeavesToBatch(
      batch.id,
      streamId,
      tree.firstCallIndex,
      tree.lastCallIndex
    );

    logger.info("attestation batch committed", {
      streamId,
      batchRef: batch.id,
      callCount: tree.callCount,
      merkleRoot: tree.root,
    });

    return batch;
  }

  /**
   * prepareBatch + sign + commitBatch, for callers that legitimately hold the
   * seller's key in-process: the simulation harness, the seller's own agent,
   * and the end-to-end tests.
   *
   * @param {number} streamId
   * @param {object} options
   * @param {object} options.signer - the seller's Stellar Keypair
   * @returns {object|null} { batch, commitment, tree }
   */
  async buildBatch(streamId, { signer, maxSize = DEFAULT_MAX_BATCH, minSize = 1 } = {}) {
    if (!signer) throw new Error("signer is required to commit a batch");

    const prepared = await this.prepareBatch(streamId, { maxSize, minSize });
    if (!prepared) return null;

    const commitment = MerkleBatchBuilder.signBatch(prepared.tree, signer);
    const batch = await this.commitBatch(streamId, prepared.tree, {
      seller: commitment.signer,
      batchSignature: commitment.batchSignature,
    });

    return { batch, commitment, tree: prepared.tree };
  }

  /** Rehydrate a batch and its archived leaves into a verifiable tree. */
  async loadBatch(streamId, batchId) {
    const batch =
      (await this.repository.findBatchByOnChainId(streamId, batchId)) ??
      (await this.repository.findBatchById(batchId));

    if (!batch || Number(batch.streamId) !== Number(streamId)) return null;

    const leaves = await this.repository.findLeavesByBatchRef(batch.id);
    return { batch, leaves };
  }

  /**
   * The buyer's independent verification of a whole batch.
   *
   * Four things have to hold, and the result says which one failed:
   *   1. the archive actually has every call the batch claims;
   *   2. every attestation carries a good signature by the seller's key, with
   *      no repeated nonce and no non-increasing index;
   *   3. the root recomputed from those leaves equals the committed root;
   *   4. the batch commitment signature covers that root and call count.
   *
   * Nothing here trusts the backend beyond it handing over bytes.
   *
   * @param {number} streamId
   * @param {number} batchId - the on-chain batch id
   * @param {object} [options]
   * @param {string} [options.sellerPublicKey] - defaults to the batch's seller
   */
  async audit(streamId, batchId, { sellerPublicKey } = {}) {
    const loaded = await this.loadBatch(streamId, batchId);
    if (!loaded) return { found: false, valid: false, reason: "BATCH_NOT_FOUND" };

    const { batch, leaves } = loaded;
    const signer = sellerPublicKey || batch.seller;

    if (leaves.length !== batch.callCount) {
      return {
        found: true,
        valid: false,
        reason: "ARCHIVE_INCOMPLETE",
        message: `batch commits to ${batch.callCount} calls but the archive holds ${leaves.length}`,
        batch,
      };
    }

    const attestations = leaves.map(toWireAttestation);
    const setResult = this.verifier.checkSet(attestations, {
      signer,
      streamId: Number(streamId),
      // The first leaf legitimately continues an earlier batch, so seed the
      // monotonic check one below it rather than at zero.
      startingIndex: batch.firstCallIndex - 1,
    });

    // A recomputed root is only meaningful once the leaves themselves stand up,
    // but compute it either way: a buyer wants to see both facts at once.
    let recomputedRoot = null;
    let rootMatches = false;
    try {
      recomputedRoot = MerkleBatchBuilder.build(attestations).root;
      rootMatches = recomputedRoot === batch.merkleRoot;
    } catch (err) {
      logger.warn("attestation batch failed to rebuild", {
        streamId,
        batchId,
        error: err.message,
      });
    }

    const commitmentValid = MerkleBatchBuilder.verifyBatchSignature(
      {
        streamId: Number(streamId),
        merkleRoot: batch.merkleRoot,
        callCount: batch.callCount,
        batchSignature: batch.batchSignature,
      },
      signer
    );

    const reason = !rootMatches
      ? "ROOT_MISMATCH"
      : !commitmentValid
        ? "BAD_BATCH_SIGNATURE"
        : !setResult.valid
          ? setResult.results[setResult.firstInvalidIndex].reason
          : null;

    return {
      found: true,
      valid: rootMatches && commitmentValid && setResult.valid,
      reason,
      batch,
      committedRoot: batch.merkleRoot,
      recomputedRoot,
      rootMatches,
      commitmentValid,
      leafResults: setResult.results,
      firstInvalidIndex: setResult.firstInvalidIndex,
      // The call a challenge should name, translated out of batch-local space.
      disputableCallIndex:
        setResult.firstInvalidIndex === null
          ? null
          : batch.firstCallIndex + setResult.firstInvalidIndex,
    };
  }

  /**
   * Everything needed to submit `challenge_usage_batch` for one call.
   *
   * @returns {object|null} { attestation, proof, root, batch, position, verdict }
   */
  async getProof(streamId, batchId, callIndex) {
    const loaded = await this.loadBatch(streamId, batchId);
    if (!loaded) return null;

    const { batch, leaves } = loaded;
    const position = Number(callIndex) - batch.firstCallIndex;
    if (position < 0 || position >= batch.callCount) return null;

    const attestations = leaves.map(toWireAttestation);
    const tree = MerkleBatchBuilder.build(attestations);
    const proof = MerkleBatchBuilder.proofForPosition(tree, position);
    const attestation = attestations[position];

    return {
      attestation,
      proof,
      root: tree.root,
      committedRoot: batch.merkleRoot,
      rootMatches: tree.root === batch.merkleRoot,
      batch,
      position,
      // How many calls a successful challenge reverses — the suffix from here
      // to the end of the batch. Mirrors the contract's arithmetic exactly so
      // the UI can show the refund before the buyer pays for the transaction.
      voidableCalls: batch.callCount - position,
      verdict: this.verifier.check(attestation, { signer: batch.seller, streamId: Number(streamId) }),
    };
  }

  /** Mirror a recorded batch back into the archive. */
  markRecorded(batchRef, outcome, client) {
    return this.repository.markRecorded(batchRef, outcome, client);
  }

  /** Mirror a successful challenge back into the archive. */
  markVoided(batchRef, outcome, client) {
    return this.repository.markVoided(batchRef, outcome, client);
  }

  listBatches(streamId, pagination) {
    return this.repository.findBatchesByStream(streamId, pagination);
  }
}

module.exports = AttestationArchive;
module.exports.toWireAttestation = toWireAttestation;
module.exports.DEFAULT_MAX_BATCH = DEFAULT_MAX_BATCH;
