/**
 * Canonical attestation encoding — the single source of truth for the bytes
 * that get hashed and signed.
 *
 * Everything in this file has a byte-for-byte twin in
 * `contract/contracts/micropayments/src/attestation.rs`. If you change an
 * offset, a domain tag, or a field order here, you MUST change it there too or
 * every on-chain Merkle proof silently stops verifying.
 *
 * ── Wire format ──────────────────────────────────────────────────────────────
 *
 * LEAF_PREIMAGE is a fixed 120-byte big-endian record. Fixed-width beats JSON
 * here: there is no canonicalisation question, no field-separator ambiguity,
 * and no `alloc`-hungry string building inside the contract.
 *
 *   offset  size  field
 *   ------  ----  -----------------------------------------------------------
 *        0     8  stream_id      u64 BE
 *        8     8  call_index     u64 BE
 *       16    32  request_hash   sha256 of the canonicalised request
 *       48    32  response_hash  sha256 of the canonicalised response
 *       80     8  timestamp      u64 BE, epoch seconds
 *       88    32  nonce          32 random bytes, unique per (stream, call)
 *
 * Domain tags prefix every hash input so a value from one position can never be
 * reinterpreted as a value from another — without them, a 120-byte leaf could
 * be presented as an internal node pair (64 bytes) or vice versa and a
 * second-preimage attack on the tree becomes possible.
 *
 *   0x00  leaf         sha256(0x00 || LEAF_PREIMAGE)
 *   0x01  internal     sha256(0x01 || min(a,b) || max(a,b))
 *   0x02  batch commit sha256 is not used; the tag prefixes the signed message
 *
 * Internal nodes hash their children in lexicographic order rather than
 * tree order. That makes a Merkle proof a bare list of sibling hashes with no
 * direction bits, which is what lets `challenge_usage_batch` take
 * `Vec<BytesN<32>>` and nothing more. The usual objection to sorted pairs —
 * that a proof no longer pins the leaf's position — does not bite here: the
 * contract recomputes the leaf hash from a fully-specified AttestationLeaf, and
 * the leaf's own `call_index` (not its position in the proof) is what the
 * void arithmetic keys off. Domain separation does the rest: an internal node
 * is a hash over 64 bytes tagged 0x01 and a leaf is a hash over 120 bytes
 * tagged 0x00, so an internal node can never be resubmitted as a leaf.
 *
 * The per-call Ed25519 signature covers `0x00 || LEAF_PREIMAGE` — the exact
 * same bytes as the leaf-hash preimage. That is deliberate: the contract
 * recomputes one buffer and uses it for both the signature check and the Merkle
 * path, so a leaf that verifies as signed is necessarily the leaf that was
 * committed.
 *
 * The batch signature covers `0x02 || stream_id || merkle_root || call_count`.
 * The issue specifies a commitment over (merkle_root, call_count); stream_id is
 * folded in as well so a batch signature captured on one stream cannot be
 * replayed to charge a different stream that happens to share a root.
 */

const crypto = require("crypto");

const LEAF_PREIMAGE_BYTES = 120;
const HASH_BYTES = 32;
const NONCE_BYTES = 32;
const SIGNATURE_BYTES = 64;

const DOMAIN_LEAF = 0x00;
const DOMAIN_INTERNAL = 0x01;
const DOMAIN_BATCH = 0x02;

/** Field offsets within LEAF_PREIMAGE, exported so tests can assert them. */
const OFFSETS = Object.freeze({
  streamId: 0,
  callIndex: 8,
  requestHash: 16,
  responseHash: 48,
  timestamp: 80,
  nonce: 88,
});

/**
 * Recursively sort object keys so structurally identical payloads serialize
 * identically. Mirrors MeteringEngine.canonicalize — a seller's request hash
 * and the backend's replay hash have to agree on what "the same payload" means.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * SHA-256 of an arbitrary payload, as a 32-byte Buffer.
 *
 * Unlike MeteringEngine.hashPayload this never returns null: an attestation
 * field is fixed-width, so "no payload" has to hash to something. An absent
 * payload hashes as the empty string, which is distinct from `{}`.
 */
function hashPayload(payload) {
  const json =
    payload === null || payload === undefined ? "" : JSON.stringify(canonicalize(payload)) ?? "";
  return crypto.createHash("sha256").update(json, "utf8").digest();
}

/** Coerce hex string | Buffer | Uint8Array to a Buffer of exactly `size`. */
function toFixedBuffer(value, size, label) {
  let buf;
  if (Buffer.isBuffer(value)) buf = value;
  else if (value instanceof Uint8Array) buf = Buffer.from(value);
  else if (typeof value === "string") {
    if (!/^[0-9a-fA-F]*$/.test(value) || value.length !== size * 2) {
      throw new Error(`${label} must be ${size * 2} hex characters`);
    }
    buf = Buffer.from(value, "hex");
  } else {
    throw new Error(`${label} must be a Buffer or hex string`);
  }

  if (buf.length !== size) {
    throw new Error(`${label} must be exactly ${size} bytes, got ${buf.length}`);
  }
  return buf;
}

/** Coerce to a u64-safe non-negative integer. */
function toU64(value, label) {
  const n = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value)));
  if (n < 0n) throw new Error(`${label} must be non-negative`);
  if (n > 0xffffffffffffffffn) throw new Error(`${label} exceeds u64`);
  return n;
}

function writeU64BE(buf, value, offset, label) {
  buf.writeBigUInt64BE(toU64(value, label), offset);
}

/**
 * Serialize an attestation into its canonical 120-byte preimage.
 *
 * @param {object} att
 * @param {number|bigint|string} att.stream_id
 * @param {number|bigint|string} att.call_index - monotonic, per stream, 0-based
 * @param {Buffer|string} att.request_hash - 32 bytes
 * @param {Buffer|string} att.response_hash - 32 bytes
 * @param {number|bigint|string} att.timestamp - epoch seconds
 * @param {Buffer|string} att.nonce - 32 bytes
 * @returns {Buffer} 120 bytes
 */
function encodeLeafPreimage(att) {
  if (!att || typeof att !== "object") throw new Error("attestation must be an object");

  const buf = Buffer.alloc(LEAF_PREIMAGE_BYTES);
  writeU64BE(buf, att.stream_id, OFFSETS.streamId, "stream_id");
  writeU64BE(buf, att.call_index, OFFSETS.callIndex, "call_index");
  toFixedBuffer(att.request_hash, HASH_BYTES, "request_hash").copy(buf, OFFSETS.requestHash);
  toFixedBuffer(att.response_hash, HASH_BYTES, "response_hash").copy(buf, OFFSETS.responseHash);
  writeU64BE(buf, att.timestamp, OFFSETS.timestamp, "timestamp");
  toFixedBuffer(att.nonce, NONCE_BYTES, "nonce").copy(buf, OFFSETS.nonce);
  return buf;
}

/** Parse a 120-byte preimage back into an attestation with hex fields. */
function decodeLeafPreimage(bytes) {
  const buf = toFixedBuffer(bytes, LEAF_PREIMAGE_BYTES, "leaf preimage");
  return {
    stream_id: Number(buf.readBigUInt64BE(OFFSETS.streamId)),
    call_index: Number(buf.readBigUInt64BE(OFFSETS.callIndex)),
    request_hash: buf.subarray(OFFSETS.requestHash, OFFSETS.requestHash + HASH_BYTES).toString("hex"),
    response_hash: buf
      .subarray(OFFSETS.responseHash, OFFSETS.responseHash + HASH_BYTES)
      .toString("hex"),
    timestamp: Number(buf.readBigUInt64BE(OFFSETS.timestamp)),
    nonce: buf.subarray(OFFSETS.nonce, OFFSETS.nonce + NONCE_BYTES).toString("hex"),
  };
}

/**
 * The exact bytes the seller's Ed25519 key signs: 0x00 || LEAF_PREIMAGE.
 * Also the leaf-hash preimage — see the header note on why they are the same.
 */
function signingMessage(att) {
  return Buffer.concat([Buffer.from([DOMAIN_LEAF]), encodeLeafPreimage(att)]);
}

/** leaf_hash = sha256(0x00 || LEAF_PREIMAGE) */
function leafHash(att) {
  return crypto.createHash("sha256").update(signingMessage(att)).digest();
}

/**
 * internal node = sha256(0x01 || min(a,b) || max(a,b))
 *
 * Children are ordered by their byte value, not by their side of the tree —
 * see the header note on why the proof format needs no direction bits.
 */
function hashInternal(a, b) {
  const left = toFixedBuffer(a, HASH_BYTES, "node a");
  const right = toFixedBuffer(b, HASH_BYTES, "node b");
  const [lo, hi] = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];

  return crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from([DOMAIN_INTERNAL]), lo, hi]))
    .digest();
}

/**
 * The bytes a seller signs to commit a whole batch on-chain:
 * 0x02 || stream_id(8) || merkle_root(32) || call_count(8)
 */
function batchCommitmentMessage({ stream_id, merkle_root, call_count }) {
  const buf = Buffer.alloc(1 + 8 + HASH_BYTES + 8);
  buf.writeUInt8(DOMAIN_BATCH, 0);
  writeU64BE(buf, stream_id, 1, "stream_id");
  toFixedBuffer(merkle_root, HASH_BYTES, "merkle_root").copy(buf, 9);
  writeU64BE(buf, call_count, 9 + HASH_BYTES, "call_count");
  return buf;
}

module.exports = {
  LEAF_PREIMAGE_BYTES,
  HASH_BYTES,
  NONCE_BYTES,
  SIGNATURE_BYTES,
  DOMAIN_LEAF,
  DOMAIN_INTERNAL,
  DOMAIN_BATCH,
  OFFSETS,
  canonicalize,
  hashPayload,
  toFixedBuffer,
  toU64,
  encodeLeafPreimage,
  decodeLeafPreimage,
  signingMessage,
  leafHash,
  hashInternal,
  batchCommitmentMessage,
};
