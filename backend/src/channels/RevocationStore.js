/**
 * RevocationStore — commit/reveal ledger for channel-state revocation
 * secrets, the primitive that makes a fraud proof possible.
 *
 * The protocol this backs: when a party accepts version N+1 of a channel,
 * it hands its counterparty the revocation secret for version N. From then
 * on, publishing version N on-chain is provably dishonest — whoever holds
 * the revealed secret can show `sha256(secret) == commitment_hash(state_N)`,
 * which is exactly the check a `punish` call needs and exactly why a
 * Watchtower can do its job holding only a commitment hash and a secret,
 * never the channel's balances (see canonical.js's commitmentHash).
 *
 * Design choices, and why:
 *
 *  - The secret is generated HERE, by the store, not supplied by a caller.
 *    A party proposing state N calls `commit()` to obtain a fresh secret and
 *    publishes only its hash alongside the state; the secret itself stays
 *    held until `reveal()` is called when that party accepts N+1. This
 *    mirrors why the secret is useful at all — if a caller could hand in an
 *    arbitrary secret, nothing would stop that caller from "revealing" a
 *    secret for a state it never actually committed to, hollowing out the
 *    proof.
 *
 *  - A commitment is one-shot: `commit()` throws if one already exists for
 *    a (channel, version, party) triple. Allowing a silent overwrite would
 *    let a party grind for a secret whose hash collides with something
 *    convenient, or quietly swap out what it's committed to after the fact.
 *
 *  - `reveal()` is idempotent but not overwritable: revealing twice returns
 *    the same secret; nothing can change what was committed. Revocation is a
 *    one-way door by construction.
 *
 *  - Verification (`verifySecret`) is keyed on the commitment hash alone —
 *    it does not require the caller to know which party generated it. A
 *    challenger holding a bare secret (from a Watchtower blob, say) can
 *    prove revocation without knowing or caring who committed to it.
 */

const crypto = require("crypto");
const { hashesEqual } = require("../attestation/AttestationVerifier");

const SECRET_BYTES = 32;

function key(channelId, version) {
  return `${String(channelId)}:${String(version)}`;
}

class RevocationStore {
  constructor() {
    // "channelId:version" -> { a: Entry|undefined, b: Entry|undefined }
    // Entry = { secret: Buffer, commitmentHash: Buffer, revealed: boolean }
    this._slots = new Map();
  }

  _slot(channelId, version) {
    const k = key(channelId, version);
    if (!this._slots.has(k)) this._slots.set(k, {});
    return this._slots.get(k);
  }

  _assertParty(party) {
    if (party !== "a" && party !== "b") throw new Error('party must be "a" or "b"');
  }

  /**
   * Generate and hold a fresh revocation secret for (channelId, version,
   * party). Returns only the commitment hash — the value to publish
   * alongside the state at this version. The secret itself is not returned;
   * it is released later, and only via `reveal()`.
   *
   * @returns {string} commitment hash, hex-encoded sha256
   */
  commit(channelId, version, party) {
    this._assertParty(party);
    const slot = this._slot(channelId, version);
    if (slot[party]) {
      throw new Error(
        `a revocation commitment already exists for channel ${channelId} version ${version} party ${party}`
      );
    }

    const secret = crypto.randomBytes(SECRET_BYTES);
    const commitmentHash = crypto.createHash("sha256").update(secret).digest();
    slot[party] = { secret, commitmentHash, revealed: false };

    return commitmentHash.toString("hex");
  }

  /**
   * Release the secret for (channelId, version, party) — the act of
   * revoking that version. Call this when this party accepts version + 1.
   *
   * Idempotent: calling twice just returns the same secret again.
   *
   * @returns {string} the revocation secret, hex-encoded
   */
  reveal(channelId, version, party) {
    this._assertParty(party);
    const slot = this._slot(channelId, version);
    const entry = slot[party];
    if (!entry) {
      throw new Error(
        `no revocation commitment for channel ${channelId} version ${version} party ${party}`
      );
    }
    if (!entry.secret) {
      throw new Error(
        `channel ${channelId} version ${version} party ${party} is a recorded (counterparty-owned) ` +
          "commitment, not one this store generated — use recordRevealedSecret instead"
      );
    }
    entry.revealed = true;
    return entry.secret.toString("hex");
  }

  /**
   * Record a counterparty's published commitment hash for a slot this store
   * does not own — used by ChannelNegotiator on the receiving side of a
   * propose/counter-sign exchange, where each party's Ed25519 secret lives
   * only in that party's own process. Unlike commit(), this never generates
   * a secret; it just remembers the hash so a later revealed secret can be
   * checked against it.
   *
   * One-shot, same as commit(): a slot's commitment is fixed the first time
   * either party learns of it.
   */
  recordCommitment(channelId, version, party, commitmentHashHex) {
    this._assertParty(party);
    const slot = this._slot(channelId, version);
    if (slot[party]) {
      throw new Error(
        `a revocation commitment already exists for channel ${channelId} version ${version} party ${party}`
      );
    }
    slot[party] = {
      secret: null,
      commitmentHash: Buffer.from(commitmentHashHex, "hex"),
      revealed: false,
    };
    return commitmentHashHex;
  }

  /**
   * Record a secret the counterparty revealed for a slot this store does
   * not own. Verifies it against the previously recorded commitment before
   * accepting it — a mismatch means the counterparty sent a secret that
   * does not open what they committed to, which is a protocol violation,
   * not something this store should silently trust.
   */
  recordRevealedSecret(channelId, version, party, secretHex) {
    this._assertParty(party);
    const { valid } = this.verifySecret(channelId, version, secretHex);
    if (!valid) {
      throw new Error(
        `revealed secret does not match the recorded commitment for channel ${channelId} ` +
          `version ${version} party ${party}`
      );
    }
    const slot = this._slot(channelId, version);
    slot[party].secret = Buffer.from(secretHex, "hex");
    slot[party].revealed = true;
  }

  /**
   * Whether either party has actually released (not merely committed to) a
   * revocation secret for this version — i.e. whether this version is
   * provably superseded.
   */
  isRevoked(channelId, version) {
    const slot = this._slots.get(key(channelId, version));
    if (!slot) return false;
    return Boolean(slot.a?.revealed || slot.b?.revealed);
  }

  /**
   * Verify a bare secret (e.g. lifted from a Watchtower blob, or submitted
   * on-chain to a `punish` call) against whatever was committed for this
   * (channelId, version) — either party's commitment counts as proof.
   *
   * @param {Buffer|string} secret - raw 32 bytes or hex
   * @returns {{valid: boolean, party: 'a'|'b'|null}}
   */
  verifySecret(channelId, version, secret) {
    const slot = this._slots.get(key(channelId, version));
    if (!slot) return { valid: false, party: null };

    const candidateHash = crypto
      .createHash("sha256")
      .update(typeof secret === "string" ? Buffer.from(secret, "hex") : secret)
      .digest();

    for (const party of ["a", "b"]) {
      const entry = slot[party];
      if (entry && hashesEqual(candidateHash, entry.commitmentHash)) {
        return { valid: true, party };
      }
    }
    return { valid: false, party: null };
  }

  /**
   * The revealed secret for (channelId, version, party), hex-encoded, or
   * `null` if that slot has not been revealed (or does not exist). This is
   * the read accessor FraudProofBuilder uses to find a punishable secret
   * without needing to know in advance which party revealed it.
   */
  revealedSecretFor(channelId, version, party) {
    this._assertParty(party);
    const slot = this._slots.get(key(channelId, version));
    const entry = slot?.[party];
    return entry?.revealed && entry.secret ? entry.secret.toString("hex") : null;
  }

  /** The commitment hash on record for (channelId, version, party), if any. */
  commitmentHashFor(channelId, version, party) {
    this._assertParty(party);
    const slot = this._slots.get(key(channelId, version));
    return slot?.[party]?.commitmentHash.toString("hex") ?? null;
  }
}

module.exports = RevocationStore;
module.exports.SECRET_BYTES = SECRET_BYTES;
