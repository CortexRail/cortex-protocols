/**
 * AttestationBuilder — the seller side of zero-trust metering.
 *
 * For every metered call the seller's own service signs a statement about what
 * it served: which stream, which call in that stream's sequence, hashes of the
 * request and the response, when, and a nonce. The backend never sees the
 * seller's key and cannot manufacture one of these; the buyer can check every
 * one of them against the seller's published public key.
 *
 * The counter that produces `call_index` lives here rather than in the backend
 * for the same reason: a backend that could choose call indices could quietly
 * insert calls that never happened. `seed()` restores the counter from
 * durable storage on restart so indices stay monotonic across process
 * lifetimes — see AttestationVerifier, which rejects any index that does not
 * strictly increase.
 */

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const {
  NONCE_BYTES,
  SIGNATURE_BYTES,
  hashPayload,
  signingMessage,
  leafHash,
  toFixedBuffer,
} = require("./canonical");

/**
 * Normalize whatever the caller handed us into `{ sign, publicKey }`.
 *
 * Accepts a Stellar Keypair (what a seller agent already has), an object with
 * the same shape, or a raw 32-byte Ed25519 seed.
 */
function normalizeSigner(signer) {
  if (!signer) throw new Error("signer is required");

  if (typeof signer.sign === "function" && typeof signer.publicKey === "function") {
    return signer;
  }

  if (typeof signer === "string" && signer.startsWith("S")) {
    return Keypair.fromSecret(signer);
  }

  if (Buffer.isBuffer(signer) || signer instanceof Uint8Array) {
    return Keypair.fromRawEd25519Seed(Buffer.from(signer));
  }

  throw new Error("signer must be a Stellar Keypair, an S... secret, or a 32-byte seed");
}

class AttestationBuilder {
  /**
   * @param {object} config
   * @param {object|string} config.signer - Stellar Keypair, S... secret, or raw seed
   * @param {number} [config.now] - injectable clock (epoch seconds) for tests
   */
  constructor(config = {}) {
    this.keypair = normalizeSigner(config.signer);
    this.publicKey = this.keypair.publicKey();
    this._now = config.now || (() => Math.floor(Date.now() / 1000));

    // streamId (string) -> next call_index to hand out.
    this._nextIndex = new Map();
  }

  /**
   * Restore the counter for a stream after a restart.
   *
   * @param {number|string} streamId
   * @param {number} lastIssuedIndex - highest index already attested, or -1 for
   *   a stream that has never been metered
   */
  seed(streamId, lastIssuedIndex) {
    const next = Number(lastIssuedIndex) + 1;
    if (!Number.isInteger(next) || next < 0) {
      throw new Error("lastIssuedIndex must be an integer >= -1");
    }
    this._nextIndex.set(String(streamId), next);
    return next;
  }

  /** The index that would be assigned to the next attestation for a stream. */
  peek(streamId) {
    return this._nextIndex.get(String(streamId)) ?? 0;
  }

  /**
   * Sign one metered call.
   *
   * @param {object} params
   * @param {number|string} params.streamId
   * @param {*} [params.request] - the request payload, hashed canonically
   * @param {*} [params.response] - the response payload, hashed canonically
   * @param {Buffer|string} [params.requestHash] - supply instead of `request`
   *   when the payload must not be held in memory here
   * @param {Buffer|string} [params.responseHash]
   * @param {number} [params.callIndex] - override the counter (replay tests)
   * @param {Buffer|string} [params.nonce] - override the random nonce (tests)
   * @param {number} [params.timestamp] - override the clock (tests)
   * @returns {object} attestation with hex-encoded fields plus `signature`,
   *   `signer` (the seller's G... address) and `leaf_hash`
   */
  attest({
    streamId,
    request,
    response,
    requestHash,
    responseHash,
    callIndex,
    nonce,
    timestamp,
  } = {}) {
    if (streamId === undefined || streamId === null) {
      throw new Error("streamId is required");
    }

    const key = String(streamId);
    const index = callIndex === undefined ? this.peek(key) : Number(callIndex);
    if (!Number.isInteger(index) || index < 0) {
      throw new Error("callIndex must be a non-negative integer");
    }

    const attestation = {
      stream_id: Number(streamId),
      call_index: index,
      request_hash: (requestHash
        ? toFixedBuffer(requestHash, 32, "requestHash")
        : hashPayload(request)
      ).toString("hex"),
      response_hash: (responseHash
        ? toFixedBuffer(responseHash, 32, "responseHash")
        : hashPayload(response)
      ).toString("hex"),
      timestamp: timestamp === undefined ? this._now() : Number(timestamp),
      nonce: (nonce
        ? toFixedBuffer(nonce, NONCE_BYTES, "nonce")
        : crypto.randomBytes(NONCE_BYTES)
      ).toString("hex"),
    };

    const signature = this.keypair.sign(signingMessage(attestation));
    if (signature.length !== SIGNATURE_BYTES) {
      throw new Error(`signer produced a ${signature.length}-byte signature, expected 64`);
    }

    // Only advance the counter once signing succeeded, and only when we were
    // the one choosing the index. An explicit callIndex is a test/replay path
    // and must not perturb the live sequence.
    if (callIndex === undefined) {
      this._nextIndex.set(key, index + 1);
    }

    return {
      ...attestation,
      signature: Buffer.from(signature).toString("hex"),
      signer: this.publicKey,
      leaf_hash: leafHash(attestation).toString("hex"),
    };
  }

  /**
   * Drop-in wrapper for an existing response handler.
   *
   * The acceptance criterion is that a seller integrates attestation without
   * restructuring their service, so this takes the handler they already have
   * and returns one that attaches `attestation` to whatever it returned:
   *
   *   const handler = builder.wrap(async (req) => ({ answer: 42 }));
   *   const { answer, attestation } = await handler(req, { streamId });
   *
   * A handler returning a non-object (a string, a Buffer) gets its value moved
   * under `data` so there is somewhere to hang the attestation.
   *
   * @param {Function} handler - (request, ctx) => response
   * @param {object} [options]
   * @param {(req: any, ctx: any) => number|string} [options.streamId] - derive
   *   the stream id from the request when the caller does not pass one
   */
  wrap(handler, options = {}) {
    if (typeof handler !== "function") throw new Error("handler must be a function");
    const self = this;

    return async function attestedHandler(request, ctx = {}) {
      const streamId =
        ctx.streamId ?? (options.streamId ? options.streamId(request, ctx) : undefined);
      if (streamId === undefined || streamId === null) {
        throw new Error("streamId must come from ctx.streamId or options.streamId");
      }

      const response = await handler(request, ctx);
      const attestation = self.attest({ streamId, request, response });

      return response && typeof response === "object" && !Buffer.isBuffer(response)
        ? { ...response, attestation }
        : { data: response, attestation };
    };
  }
}

module.exports = AttestationBuilder;
module.exports.normalizeSigner = normalizeSigner;
