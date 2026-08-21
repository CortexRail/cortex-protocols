/**
 * AttestationVerifier — decides whether a signed attestation may be credited.
 *
 * Three independent checks, in cost order (cheap and local first, so a
 * malformed or replayed attestation never reaches the curve arithmetic):
 *
 *   1. Shape + signer binding — fields present, sizes right, stream matches,
 *      and the signature is by the key we expect for this seller.
 *   2. Ed25519 signature over `0x00 || LEAF_PREIMAGE` (see canonical.js).
 *   3. Freshness — the nonce has not been seen before on this stream, and the
 *      call_index strictly increases.
 *
 * Checks 1 and 2 are pure: `check()` runs them and mutates nothing, which is
 * what a buyer calls when independently auditing an archived batch. Check 3
 * needs durable state, so it lives behind pluggable stores and only runs in
 * `accept()`, the metering hot path.
 *
 * ── Why nonces are keyed per stream ──────────────────────────────────────────
 * A global nonce set would be a single hot row on every metered call across
 * every seller. Per-stream is both cheaper and sufficient: an attestation
 * commits to its own stream_id, so a nonce lifted from stream A cannot be
 * presented on stream B without breaking the signature. The replay we actually
 * have to stop is the same nonce twice *within* a stream — including across two
 * different batches, which is why the store outlives any one batch.
 */

const crypto = require("crypto");
const { Keypair, StrKey } = require("@stellar/stellar-sdk");
const {
  HASH_BYTES,
  NONCE_BYTES,
  SIGNATURE_BYTES,
  signingMessage,
  leafHash,
  toFixedBuffer,
} = require("./canonical");

/** Machine-readable outcomes; the frontend renders these directly. */
const Reason = Object.freeze({
  OK: "OK",
  MALFORMED: "MALFORMED",
  STREAM_MISMATCH: "STREAM_MISMATCH",
  SIGNER_MISMATCH: "SIGNER_MISMATCH",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  NONCE_REUSED: "NONCE_REUSED",
  INDEX_NOT_MONOTONIC: "INDEX_NOT_MONOTONIC",
  CLOCK_SKEW: "CLOCK_SKEW",
});

/** A rejection that is provable on-chain, i.e. worth challenging a batch over. */
const PROVABLE_ON_CHAIN = Object.freeze([Reason.BAD_SIGNATURE, Reason.NONCE_REUSED]);

function fail(reason, message) {
  return { valid: false, reason, message, provableOnChain: PROVABLE_ON_CHAIN.includes(reason) };
}

const OK = Object.freeze({ valid: true, reason: Reason.OK, message: null, provableOnChain: false });

/**
 * In-memory nonce + index stores. Fine for a single process and for tests;
 * production passes the Postgres-backed pair from attestationRepository so the
 * replay window survives a restart and spans replicas.
 */
function createMemoryStores() {
  const nonces = new Map(); // streamId -> Set<nonceHex>
  const indices = new Map(); // streamId -> highest accepted call_index

  return {
    nonceStore: {
      async has(streamId, nonceHex) {
        return nonces.get(String(streamId))?.has(nonceHex) ?? false;
      },
      async add(streamId, nonceHex, _client, _callIndex) {
        const key = String(streamId);
        if (!nonces.has(key)) nonces.set(key, new Set());
        nonces.get(key).add(nonceHex);
      },
    },
    indexStore: {
      async highest(streamId) {
        const v = indices.get(String(streamId));
        return v === undefined ? null : v;
      },
      async set(streamId, callIndex) {
        indices.set(String(streamId), callIndex);
      },
    },
    _raw: { nonces, indices },
  };
}

/**
 * Ed25519 verify, with every failure mode collapsed to `false`.
 *
 * Keypair.verify throws on a malformed signature rather than returning false,
 * and a garbage public key throws inside StrKey. Neither is a crash: both mean
 * "this attestation does not verify".
 */
function verifySignatureRaw(message, signatureHex, publicKey) {
  try {
    const signature = toFixedBuffer(signatureHex, SIGNATURE_BYTES, "signature");
    const kp =
      typeof publicKey === "string"
        ? Keypair.fromPublicKey(publicKey)
        : Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)));
    return kp.verify(message, signature);
  } catch {
    return false;
  }
}

/** Every field an attestation must carry, with its expected byte width. */
const HEX_FIELDS = Object.freeze({
  request_hash: HASH_BYTES,
  response_hash: HASH_BYTES,
  nonce: NONCE_BYTES,
  signature: SIGNATURE_BYTES,
});

class AttestationVerifier {
  /**
   * @param {object} [config]
   * @param {object} [config.nonceStore] - { has(streamId, nonce, client),
   *   add(streamId, nonce, client, callIndex) }
   * @param {object} [config.indexStore] - { highest(streamId), set(streamId, index) }
   * @param {number} [config.maxClockSkewSeconds] - reject attestations dated
   *   further than this into the future; 0 disables the check
   * @param {Function} [config.now] - injectable clock, epoch seconds
   */
  constructor(config = {}) {
    const memory = createMemoryStores();
    this.nonceStore = config.nonceStore || memory.nonceStore;
    this.indexStore = config.indexStore || memory.indexStore;
    this.maxClockSkewSeconds = config.maxClockSkewSeconds ?? 300;
    this._now = config.now || (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Stateless validation: shape, stream binding, signer binding, signature.
   *
   * This is the whole of what a buyer needs to verify an archived attestation
   * offline — it touches no store and no network.
   *
   * @param {object} attestation
   * @param {object} [expect]
   * @param {string} [expect.signer] - the seller's G... address
   * @param {number|string} [expect.streamId]
   */
  check(attestation, expect = {}) {
    if (!attestation || typeof attestation !== "object") {
      return fail(Reason.MALFORMED, "attestation must be an object");
    }

    for (const field of ["stream_id", "call_index", "timestamp"]) {
      const value = Number(attestation[field]);
      if (!Number.isInteger(value) || value < 0) {
        return fail(Reason.MALFORMED, `${field} must be a non-negative integer`);
      }
    }

    for (const [field, size] of Object.entries(HEX_FIELDS)) {
      try {
        toFixedBuffer(attestation[field], size, field);
      } catch (err) {
        return fail(Reason.MALFORMED, err.message);
      }
    }

    if (expect.streamId !== undefined && Number(attestation.stream_id) !== Number(expect.streamId)) {
      return fail(
        Reason.STREAM_MISMATCH,
        `attestation is for stream ${attestation.stream_id}, expected ${expect.streamId}`
      );
    }

    const signer = expect.signer || attestation.signer;
    if (!signer) {
      return fail(Reason.MALFORMED, "no signer: pass expect.signer or set attestation.signer");
    }
    if (expect.signer && attestation.signer && attestation.signer !== expect.signer) {
      return fail(
        Reason.SIGNER_MISMATCH,
        `attestation claims signer ${attestation.signer}, expected ${expect.signer}`
      );
    }

    if (!verifySignatureRaw(signingMessage(attestation), attestation.signature, signer)) {
      return fail(Reason.BAD_SIGNATURE, `signature does not verify under ${signer}`);
    }

    if (this.maxClockSkewSeconds > 0) {
      const drift = Number(attestation.timestamp) - this._now();
      if (drift > this.maxClockSkewSeconds) {
        return fail(
          Reason.CLOCK_SKEW,
          `attestation is dated ${drift}s in the future (limit ${this.maxClockSkewSeconds}s)`
        );
      }
    }

    return OK;
  }

  /**
   * Full validation, including the stateful freshness checks, recording the
   * nonce and advancing the index when — and only when — everything passes.
   *
   * Call this once per metered call. Calling it twice with the same
   * attestation returns NONCE_REUSED the second time, by construction.
   *
   * @param {object} attestation
   * @param {object} [expect] - as `check()`, plus:
   * @param {*} [expect.client] - pg client, threaded to the stores so the
   *   nonce insert lands in the same transaction as the usage decrement
   */
  async accept(attestation, expect = {}) {
    const stateless = this.check(attestation, expect);
    if (!stateless.valid) return stateless;

    const streamId = Number(attestation.stream_id);
    const nonce = toFixedBuffer(attestation.nonce, NONCE_BYTES, "nonce").toString("hex");

    if (await this.nonceStore.has(streamId, nonce, expect.client)) {
      return fail(Reason.NONCE_REUSED, `nonce ${nonce.slice(0, 16)}… already used on this stream`);
    }

    const highest = await this.indexStore.highest(streamId, expect.client);
    const callIndex = Number(attestation.call_index);
    if (highest !== null && highest !== undefined && callIndex <= Number(highest)) {
      return fail(
        Reason.INDEX_NOT_MONOTONIC,
        `call_index ${callIndex} does not exceed the highest accepted index ${highest}`
      );
    }

    await this.nonceStore.add(streamId, nonce, expect.client, callIndex);
    await this.indexStore.set(streamId, callIndex, expect.client);

    return { ...OK, leafHash: leafHash(attestation).toString("hex") };
  }

  /**
   * Verify a whole archived set at once, the buyer's audit path.
   *
   * Stateless per-attestation checks run against a local nonce set so a replay
   * *inside* the set is caught without touching any store — this is exactly the
   * evidence a buyer needs before calling `challengeBatch`.
   *
   * @returns {{valid: boolean, results: Array, firstInvalidIndex: number|null}}
   */
  checkSet(attestations, expect = {}) {
    const seenNonces = new Set();
    let highest = expect.startingIndex ?? null;
    let firstInvalidIndex = null;

    const results = attestations.map((attestation, position) => {
      let outcome = this.check(attestation, expect);

      if (outcome.valid) {
        const nonce = String(attestation.nonce).toLowerCase();
        if (seenNonces.has(nonce)) {
          outcome = fail(Reason.NONCE_REUSED, `nonce repeated at position ${position}`);
        } else {
          seenNonces.add(nonce);
          const callIndex = Number(attestation.call_index);
          if (highest !== null && callIndex <= highest) {
            outcome = fail(
              Reason.INDEX_NOT_MONOTONIC,
              `call_index ${callIndex} does not exceed ${highest}`
            );
          } else {
            highest = callIndex;
          }
        }
      }

      if (!outcome.valid && firstInvalidIndex === null) firstInvalidIndex = position;
      return { position, callIndex: Number(attestation?.call_index), ...outcome };
    });

    return { valid: firstInvalidIndex === null, results, firstInvalidIndex };
  }
}

/**
 * Constant-time hex comparison, for callers checking a root or a leaf hash
 * against an expected value.
 */
function hashesEqual(a, b) {
  try {
    const left = toFixedBuffer(a, HASH_BYTES, "hash a");
    const right = toFixedBuffer(b, HASH_BYTES, "hash b");
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

module.exports = AttestationVerifier;
module.exports.Reason = Reason;
module.exports.createMemoryStores = createMemoryStores;
module.exports.verifySignatureRaw = verifySignatureRaw;
module.exports.hashesEqual = hashesEqual;
