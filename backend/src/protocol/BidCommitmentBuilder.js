const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Canonical commitment preimage used by the marketplace contract:
//   sha256(amount_be_bytes_16 || salt_32_bytes)
// See `commitment_preimage` in contract/contracts/marketplace/src/lib.rs.
function hashBid(amount, salt) {
  const amountBytes = Buffer.alloc(16);
  const big = BigInt(amount);
  amountBytes.writeBigInt64BE(big >> 64n, 0);
  amountBytes.writeBigInt64BE(big & 0xffffffffffffffffn, 8);

  const saltBytes = Buffer.isBuffer(salt)
    ? salt
    : Buffer.from(String(salt), "hex");

  if (saltBytes.length !== 32) {
    throw new Error(`salt must be 32 bytes, got ${saltBytes.length}`);
  }

  return crypto.createHash("sha256").update(amountBytes).update(saltBytes).digest("hex");
}

function generateSalt() {
  return crypto.randomBytes(32);
}

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

/**
 * Encrypts a payload with AES-256-GCM keyed by sha256(agentSecret).
 * Returns base64(iv:tag:ciphertext).
 */
function encryptReveal(reveal, agentSecret) {
  const key = deriveKey(agentSecret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(reveal), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/**
 * Decrypts a payload produced by `encryptReveal`.
 */
function decryptReveal(payload, agentSecret) {
  const key = deriveKey(agentSecret);
  const raw = Buffer.from(String(payload), "base64");
  if (raw.length < 12 + 16) {
    throw new Error("Encrypted reveal payload is malformed");
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function defaultStorageDir() {
  return process.env.CORTEX_SDK_DIR || path.join(os.homedir(), ".cortex-sdk");
}

/**
 * Client-side sealed-bid helper.
 *
 * Generates the bid commitment hash for an auction and persists the
 * (salt, amount) reveal material locally, encrypted with the agent's key,
 * until the reveal window opens. Never exposes the amount before reveal.
 */
class BidCommitmentBuilder {
  /**
   * @param {object} [options]
   * @param {string} [options.storageDir] - Directory for encrypted reveal
   *   files. Defaults to $CORTEX_SDK_DIR or ~/.cortex-sdk.
   * @param {string} [options.agentSecret] - Agent secret used to derive the
   *   encryption key (typically the agent's Stellar seed).
   */
  constructor(options = {}) {
    this.storageDir = options.storageDir || defaultStorageDir();
    this.agentSecret = options.agentSecret || null;
    fs.mkdirSync(this.storageDir, { recursive: true });
  }

  _revealPath(auctionId) {
    return path.join(this.storageDir, `auction-${auctionId}-reveal.enc`);
  }

  /**
   * Create a commitment for a hidden bid.
   *
   * @param {number|bigint} auctionId
   * @param {bigint|number|string} amount - Bid amount in stroops (i128).
   * @returns {{ bidHash: string, salt: string, amount: string }}
   *   `bidHash` (hex) is safe to submit on-chain; `salt`/`amount` must be
   *   kept secret until the reveal phase.
   */
  createCommitment(auctionId, amount) {
    if (typeof amount !== "bigint" && !Number.isInteger(Number(amount))) {
      throw new Error("amount must be an integer number of stroops");
    }
    const salt = generateSalt();
    const bidHash = hashBid(amount, salt);
    return {
      bidHash,
      salt: salt.toString("hex"),
      amount: BigInt(amount).toString(),
      auctionId: Number(auctionId),
    };
  }

  /**
   * Persist the reveal material for an auction, encrypted with the agent's
   * key. Overwrites any previous commitment for the same auction.
   */
  storeReveal(reveal, agentSecret = this.agentSecret) {
    if (!agentSecret) {
      throw new Error("agentSecret is required to persist reveal material");
    }
    const payload = encryptReveal(reveal, agentSecret);
    fs.writeFileSync(this._revealPath(reveal.auctionId), payload, { mode: 0o600 });
  }

  /**
   * Load and decrypt the reveal material for an auction.
   * Returns null when no commitment was stored.
   */
  loadReveal(auctionId, agentSecret = this.agentSecret) {
    if (!agentSecret) {
      throw new Error("agentSecret is required to decrypt reveal material");
    }
    const file = this._revealPath(auctionId);
    if (!fs.existsSync(file)) {
      return null;
    }
    return decryptReveal(fs.readFileSync(file, "utf8"), agentSecret);
  }

  /**
   * Remove stored reveal material for an auction (e.g. after revealing).
   */
  clearReveal(auctionId) {
    const file = this._revealPath(auctionId);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

module.exports = {
  BidCommitmentBuilder,
  hashBid,
  generateSalt,
  encryptReveal,
  decryptReveal,
};