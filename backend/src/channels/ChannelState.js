/**
 * ChannelState — the dual-signed, monotonically versioned balance pair a
 * bidirectional payment channel is built on.
 *
 * `{ channel_id, version, balance_a, balance_b, sig_a, sig_b }`. A state is
 * only meaningful with both signatures present and valid: neither party can
 * move funds unilaterally, and the on-chain contract (`dispute`) trusts a
 * state exactly because it cannot exist without both parties having signed
 * off on it. Comparing versions is what lets a later, correctly signed state
 * supersede an earlier one — the mechanism that makes publishing a stale
 * close strictly worse than closing honestly.
 *
 * This module is deliberately narrow: it knows how to build, sign and verify
 * one state, and how to order two states of the same channel. It does not
 * know about the propose/counter-sign/ack handshake (ChannelNegotiator) or
 * about revocation (RevocationStore) — those are separate concerns with
 * separate failure modes and belong in their own modules.
 */

const { Keypair, StrKey } = require("@stellar/stellar-sdk");
const { SIGNATURE_BYTES, toFixedBuffer } = require("../attestation/canonical");
const { signingMessage, commitmentHash } = require("./canonical");

/** Machine-readable verification outcomes. */
const Reason = Object.freeze({
  OK: "OK",
  MALFORMED: "MALFORMED",
  MISSING_SIGNATURE_A: "MISSING_SIGNATURE_A",
  MISSING_SIGNATURE_B: "MISSING_SIGNATURE_B",
  BAD_SIGNATURE_A: "BAD_SIGNATURE_A",
  BAD_SIGNATURE_B: "BAD_SIGNATURE_B",
});

function fail(reason, message) {
  return { valid: false, reason, message };
}

const OK = Object.freeze({ valid: true, reason: Reason.OK, message: null });

/**
 * Build a fresh, unsigned state. `version` starts at 0 for a channel's
 * opening state (the deposits themselves) and increases by exactly 1 per
 * accepted off-chain update — negotiation of that increment is
 * ChannelNegotiator's job, not this module's.
 */
/**
 * The shared `toU64` coercion (attestation/canonical.js) truncates a
 * fractional input via `Math.trunc` rather than rejecting it — reasonable
 * for byte offsets, not for money. A balance of 1000.7 silently becoming
 * 1000 is exactly the kind of loss a channel's own accounting must never
 * produce, so integrality is enforced here, explicitly, before the value
 * ever reaches the shared encoder.
 */
function assertU64Integer(value, label) {
  const n = typeof value === "bigint" ? value : Number(value);
  if (typeof n === "bigint") return; // BigInt is exact by construction
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${label} must be a non-negative integer, got ${value}`);
  }
}

function createState({ channelId, version, balanceA, balanceB }) {
  assertU64Integer(channelId, "channelId");
  assertU64Integer(version, "version");
  assertU64Integer(balanceA, "balanceA");
  assertU64Integer(balanceB, "balanceB");

  // encodeStatePreimage (via signingMessage) additionally enforces u64
  // upper bounds; calling it here makes any remaining malformed input fail
  // at creation time rather than silently propagating into a signature.
  const state = {
    channel_id: channelId,
    version,
    balance_a: balanceA,
    balance_b: balanceB,
    sig_a: null,
    sig_b: null,
  };
  signingMessage(state); // throws on bad shape/bounds
  return state;
}

/** Sign a state's canonical bytes with one party's key. Does not attach it. */
function sign(state, keypair) {
  const signature = keypair.sign(signingMessage(state));
  if (signature.length !== SIGNATURE_BYTES) {
    throw new Error(`signer produced a ${signature.length}-byte signature, expected ${SIGNATURE_BYTES}`);
  }
  return Buffer.from(signature).toString("hex");
}

/**
 * Return a new state with `sig_a` or `sig_b` attached. Pure — never mutates
 * the input, so a proposer can hold the unsigned state while a counter-sign
 * is pending without aliasing bugs.
 */
function withSignature(state, party, signatureHex) {
  if (party !== "a" && party !== "b") throw new Error('party must be "a" or "b"');
  toFixedBuffer(signatureHex, SIGNATURE_BYTES, "signature"); // shape check
  return { ...state, [`sig_${party}`]: signatureHex };
}

/**
 * Ed25519 verify, every failure mode collapsed to `false` — mirrors
 * AttestationVerifier.verifySignatureRaw: a malformed signature or a garbage
 * public key throws inside stellar-sdk, and both mean "does not verify".
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

/**
 * Full validation: both signatures present, both valid under the given
 * public keys. This is the check a dispute handler runs before letting a
 * state supersede whatever is currently pending on-chain.
 *
 * @param {object} state
 * @param {string} pubKeyA - party A's G... address
 * @param {string} pubKeyB - party B's G... address
 */
function verify(state, pubKeyA, pubKeyB) {
  if (!state || typeof state !== "object") return fail(Reason.MALFORMED, "state must be an object");

  let message;
  try {
    message = signingMessage(state);
  } catch (err) {
    return fail(Reason.MALFORMED, err.message);
  }

  if (!state.sig_a) return fail(Reason.MISSING_SIGNATURE_A, "state carries no sig_a");
  if (!state.sig_b) return fail(Reason.MISSING_SIGNATURE_B, "state carries no sig_b");

  if (!verifySignatureRaw(message, state.sig_a, pubKeyA)) {
    return fail(Reason.BAD_SIGNATURE_A, `sig_a does not verify under ${pubKeyA}`);
  }
  if (!verifySignatureRaw(message, state.sig_b, pubKeyB)) {
    return fail(Reason.BAD_SIGNATURE_B, `sig_b does not verify under ${pubKeyB}`);
  }

  return OK;
}

/**
 * Order two states of the same channel. Returns 1 if `a` is strictly newer
 * than `b`, -1 if older, 0 if equal version. Throws on a channel_id
 * mismatch — comparing versions across two different channels is always a
 * caller bug, never a legitimate dispute.
 */
function compareVersions(a, b) {
  if (Number(a.channel_id) !== Number(b.channel_id)) {
    throw new Error(
      `cannot compare states from different channels (${a.channel_id} vs ${b.channel_id})`
    );
  }
  const va = Number(a.version);
  const vb = Number(b.version);
  return va === vb ? 0 : va > vb ? 1 : -1;
}

/** True when `candidate` is a strictly newer, validly signed supersession of `current`. */
function supersedes(candidate, current, pubKeyA, pubKeyB) {
  if (compareVersions(candidate, current) <= 0) return false;
  return verify(candidate, pubKeyA, pubKeyB).valid;
}

module.exports = {
  Reason,
  createState,
  sign,
  withSignature,
  verify,
  verifySignatureRaw,
  compareVersions,
  supersedes,
  commitmentHash,
};
