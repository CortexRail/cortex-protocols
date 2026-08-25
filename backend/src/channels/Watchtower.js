/**
 * Watchtower — holds encrypted justice packages and finds the right one
 * when it observes a revoked close.
 *
 * ── What "without learning the channel balances" actually means here ───────
 *
 * A justice package is nothing but a bare 32-byte revocation secret plus
 * who it belongs to — never a channel's balances, never even the state it
 * revokes. A random 32 bytes carries no information about what a channel
 * was worth, so a watchtower holding one learns nothing by design, not by
 * promise. (The balances themselves are separately, unavoidably public: they
 * get posted on-chain in the clear the moment a unilateral close happens —
 * see `PendingClose` in the contract. No amount of client-side encryption
 * changes that; it was never this module's job to hide it.)
 *
 * What this module *does* encrypt is the secret at rest, under a key derived
 * from this watchtower's own master key. That is ordinary encryption-at-rest
 * hygiene — it protects a client's secret from a storage-layer breach that
 * doesn't also compromise the watchtower process itself — not a
 * zero-knowledge scheme. A watchtower that *submits* `punish` transactions
 * necessarily has to recover the plaintext secret to do that; nothing short
 * of the watchtower never seeing the secret at all (defeating the point of
 * registering with it) could change that.
 *
 * ── Lookup ───────────────────────────────────────────────────────────────
 *
 * Blobs are keyed by `commitmentHash(state)` (canonical.js) — the same value
 * `close_unilateral` implicitly commits a party to the moment it posts a
 * state on-chain. A client registers a package for a state as soon as it has
 * one to register (see FraudProofBuilder's header for when that is);
 * ChannelMonitor recomputes the same hash from whatever it observes on-chain
 * and calls `findJustice` to see if this watchtower is holding anything for
 * it.
 */

const crypto = require("crypto");
const { commitmentHash } = require("./canonical");

const MASTER_KEY_BYTES = 32;

class Watchtower {
  /**
   * @param {Buffer|string} masterKey - 32 bytes (or 64 hex chars), this
   *   watchtower operator's own key. Never derived from anything a client
   *   supplies — a client-supplied key would let whoever controls the
   *   client also read every other client's blobs stored under the same
   *   watchtower process.
   */
  constructor({ masterKey }) {
    const key = Buffer.isBuffer(masterKey) ? masterKey : Buffer.from(masterKey, "hex");
    if (key.length !== MASTER_KEY_BYTES) {
      throw new Error(`masterKey must be ${MASTER_KEY_BYTES} bytes`);
    }
    this.masterKey = key;
    this._blobs = new Map(); // commitmentHashHex -> { iv, authTag, ciphertext }
  }

  _blobKeyFor(commitmentHashHex) {
    return crypto.createHmac("sha256", this.masterKey).update(commitmentHashHex, "hex").digest();
  }

  /**
   * Register a justice package for `state`. Typically called right after a
   * ChannelNegotiator round reveals the secret for the state it just
   * superseded (`ack()`/`complete()`'s `revokedState` + `revealedSecret`).
   *
   * @param {object} state - the ChannelState being protected against
   * @param {object} justice
   * @param {'a'|'b'} justice.party - whose revocation secret this is
   * @param {string} justice.revocationSecret - hex
   * @param {string} justice.challenger - the G... address `punish` should
   *   pay — this party's own address, so a watchtower can submit on their
   *   behalf without needing a fresh signature from them
   * @returns {string} the commitment hash this package is stored under
   */
  register(state, justice) {
    const hash = commitmentHash(state).toString("hex");
    const key = this._blobKeyFor(hash);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(justice), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    this._blobs.set(hash, { iv, authTag, ciphertext });
    return hash;
  }

  has(commitmentHashHex) {
    return this._blobs.has(commitmentHashHex);
  }

  /**
   * Given a state actually observed on-chain (public: channel_id, version,
   * balances, revocation commitments — from `get_pending_close` after a
   * `UNILATERAL_CLOSE` event), check whether this watchtower holds a
   * justice package for it, and if so, decrypt and return it.
   *
   * @returns {{party, revocationSecret, challenger}|null}
   */
  findJustice(state) {
    const hash = commitmentHash(state).toString("hex");
    return this.findJusticeByHash(hash);
  }

  /** Same as findJustice, keyed directly by a commitment hash already in hand. */
  findJusticeByHash(commitmentHashHex) {
    const blob = this._blobs.get(commitmentHashHex);
    if (!blob) return null;

    const key = this._blobKeyFor(commitmentHashHex);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, blob.iv);
    decipher.setAuthTag(blob.authTag);
    const plaintext = Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  }
}

module.exports = Watchtower;
