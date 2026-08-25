/**
 * Canonical payment-channel state encoding — the bytes that get signed by
 * both parties and hashed into the commitment a watchtower is keyed on.
 *
 * Mirrors the layout style of `../attestation/canonical.js`: a fixed-width
 * big-endian record beats JSON for the same reasons it does there — no
 * canonicalisation question, and this preimage has to have a byte-for-byte
 * twin in the Soroban contract's `ChannelState` encoding once that crate
 * exists, so ambiguity here becomes a silent cross-language mismatch later.
 *
 * ── Wire format ──────────────────────────────────────────────────────────
 *
 * STATE_PREIMAGE is a fixed 32-byte big-endian record:
 *
 *   offset  size  field
 *   ------  ----  ---------------------------------------------------------
 *        0     8  channel_id   u64 BE
 *        8     8  version      u64 BE, monotonic per channel
 *       16     8  balance_a    u64 BE
 *       24     8  balance_b    u64 BE
 *
 * The signed message is `0x10 || STATE_PREIMAGE`. Domain tag 0x10 is chosen
 * clear of the attestation module's 0x00/0x01/0x02 so a channel-state
 * signature can never be replayed as, or confused with, an attestation leaf
 * even if the two byte layouts ever happened to collide in length.
 *
 * `commitmentHash = sha256(signingMessage)` is deliberately the same value a
 * Watchtower blob is keyed on (see RevocationStore / the issue's Watchtower
 * spec): a watchtower that only ever sees commitment hashes never learns a
 * channel's balances, only which exact state it is holding a justice
 * transaction for.
 */

const crypto = require("crypto");
const { toU64, HASH_BYTES } = require("../attestation/canonical");

const STATE_PREIMAGE_BYTES = 32;
const DOMAIN_CHANNEL_STATE = 0x10;

const OFFSETS = Object.freeze({
  channelId: 0,
  version: 8,
  balanceA: 16,
  balanceB: 24,
});

function writeU64BE(buf, value, offset, label) {
  buf.writeBigUInt64BE(toU64(value, label), offset);
}

/**
 * Serialize a channel state into its canonical 32-byte preimage.
 *
 * @param {object} state
 * @param {number|bigint|string} state.channel_id
 * @param {number|bigint|string} state.version
 * @param {number|bigint|string} state.balance_a
 * @param {number|bigint|string} state.balance_b
 * @returns {Buffer} 32 bytes
 */
function encodeStatePreimage(state) {
  if (!state || typeof state !== "object") throw new Error("state must be an object");

  const buf = Buffer.alloc(STATE_PREIMAGE_BYTES);
  writeU64BE(buf, state.channel_id, OFFSETS.channelId, "channel_id");
  writeU64BE(buf, state.version, OFFSETS.version, "version");
  writeU64BE(buf, state.balance_a, OFFSETS.balanceA, "balance_a");
  writeU64BE(buf, state.balance_b, OFFSETS.balanceB, "balance_b");
  return buf;
}

/** Parse a 32-byte preimage back into a state with numeric fields. */
function decodeStatePreimage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== STATE_PREIMAGE_BYTES) {
    throw new Error(`preimage must be exactly ${STATE_PREIMAGE_BYTES} bytes`);
  }
  return {
    channel_id: Number(bytes.readBigUInt64BE(OFFSETS.channelId)),
    version: Number(bytes.readBigUInt64BE(OFFSETS.version)),
    balance_a: Number(bytes.readBigUInt64BE(OFFSETS.balanceA)),
    balance_b: Number(bytes.readBigUInt64BE(OFFSETS.balanceB)),
  };
}

/** The exact bytes both parties sign: 0x10 || STATE_PREIMAGE. */
function signingMessage(state) {
  return Buffer.concat([Buffer.from([DOMAIN_CHANNEL_STATE]), encodeStatePreimage(state)]);
}

/**
 * commitment_hash = sha256(0x10 || STATE_PREIMAGE)
 *
 * The value a Watchtower blob is keyed on, and what a `punish` claim must
 * reproduce from a revealed revocation secret plus the revoked state's
 * fields — see RevocationStore.
 */
function commitmentHash(state) {
  return crypto.createHash("sha256").update(signingMessage(state)).digest();
}

module.exports = {
  STATE_PREIMAGE_BYTES,
  HASH_BYTES,
  DOMAIN_CHANNEL_STATE,
  OFFSETS,
  encodeStatePreimage,
  decodeStatePreimage,
  signingMessage,
  commitmentHash,
};
