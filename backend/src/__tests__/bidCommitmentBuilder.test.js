const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  BidCommitmentBuilder,
  hashBid,
  generateSalt,
  encryptReveal,
  decryptReveal,
} = require("../protocol/BidCommitmentBuilder");

const AGENT_SECRET = "S-test-secret-seed-for-agent-encryption";

describe("BidCommitmentBuilder", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bids-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("hashBid", () => {
    it("matches the contract's canonical preimage: sha256(amount_be || salt)", () => {
      // Manually computed sha256 of (amount=5000 as 16-byte BE) || (salt).
      const amount = 5000;
      const salt = Buffer.alloc(32, 0x01);
      const amountBytes = Buffer.alloc(16);
      const big = BigInt(amount);
      amountBytes.writeBigInt64BE(big >> 64n, 0);
      amountBytes.writeBigInt64BE(big & 0xffffffffffffffffn, 8);
      const expected = crypto
        .createHash("sha256")
        .update(Buffer.concat([amountBytes, salt]))
        .digest("hex");

      expect(hashBid(amount, salt)).toBe(expected);
    });

    it("matches the hash produced by the Rust contract for the same inputs", () => {
      // Cross-checked against the contract test suite (test_full_lifecycle...):
      // sha256(5000_be || 0x01 x32) — identical bytes layout on both sides.
      expect(hashBid(5000, Buffer.alloc(32, 0x01))).toBe(
        "bc2b2a263dbfdbf84234d8a245989454cfacabfdc307c8f736571968fa1608dc"
      );
    });

    it("is deterministic for the same amount and salt", () => {
      const salt = generateSalt();
      expect(hashBid(123456, salt)).toBe(hashBid(123456, salt));
    });

    it("supports bigint amounts and rejects wrong-size salts", () => {
      const salt = generateSalt();
      expect(hashBid(9007199254740993n, salt)).toBe(hashBid("9007199254740993", salt));
      expect(() => hashBid(5, Buffer.alloc(16))).toThrow(/32 bytes/);
    });

    it("hides the amount: hashes of close amounts differ", () => {
      const salt = generateSalt();
      expect(hashBid(5000, salt)).not.toBe(hashBid(5001, salt));
    });
  });

  describe("createCommitment", () => {
    it("returns a hash plus secret reveal material", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir });
      const commitment = builder.createCommitment(7, 5000);

      expect(commitment.auctionId).toBe(7);
      expect(commitment.amount).toBe("5000");
      expect(commitment.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(commitment.bidHash).toMatch(/^[0-9a-f]{64}$/);
      // The hash must be reproducible from the reveal material.
      expect(hashBid(commitment.amount, commitment.salt)).toBe(commitment.bidHash);
      // The hash must NOT reveal the amount.
      expect(commitment.bidHash).not.toContain(commitment.amount);
    });
  });

  describe("encrypted persistence", () => {
    it("round-trips reveal material through storeReveal/loadReveal", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir, agentSecret: AGENT_SECRET });
      const commitment = builder.createCommitment(3, 12_500);

      builder.storeReveal(commitment);
      const loaded = builder.loadReveal(3);

      expect(loaded).toEqual({
        bidHash: commitment.bidHash,
        salt: commitment.salt,
        amount: "12500",
        auctionId: 3,
      });
    });

    it("encrypts at rest: plaintext is not readable from the file", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir, agentSecret: AGENT_SECRET });
      const commitment = builder.createCommitment(9, 42_000);
      builder.storeReveal(commitment);

      const raw = fs.readFileSync(path.join(tmpDir, "auction-9-reveal.enc"), "utf8");
      expect(raw).not.toContain("42000");
      expect(raw).not.toContain(commitment.salt);
      expect(raw).not.toContain(commitment.bidHash);
    });

    it("cannot be decrypted with a different agent key", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir, agentSecret: AGENT_SECRET });
      const commitment = builder.createCommitment(11, 800);
      builder.storeReveal(commitment);

      expect(() => builder.loadReveal(11, "S-other-secret")).toThrow();
    });

    it("returns null when no commitment was stored", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir, agentSecret: AGENT_SECRET });
      expect(builder.loadReveal(404)).toBeNull();
    });

    it("clearReveal removes the stored payload", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir, agentSecret: AGENT_SECRET });
      builder.storeReveal(builder.createCommitment(5, 300));
      builder.clearReveal(5);
      expect(builder.loadReveal(5)).toBeNull();
    });

    it("requires an agent secret for persistence", () => {
      const builder = new BidCommitmentBuilder({ storageDir: tmpDir });
      const commitment = builder.createCommitment(2, 900);
      expect(() => builder.storeReveal(commitment)).toThrow(/agentSecret/);
    });
  });

  describe("encryptReveal/decryptReveal", () => {
    it("round-trips arbitrary reveal payloads", () => {
      const payload = { auctionId: 1, amount: "12345", salt: generateSalt().toString("hex") };
      const encrypted = encryptReveal(payload, "secret");
      expect(encrypted).not.toContain("12345");
      expect(decryptReveal(encrypted, "secret")).toEqual(payload);
    });

    it("rejects tampered ciphertext", () => {
      const encrypted = encryptReveal({ amount: "1" }, "secret");
      const tampered = Buffer.from(encrypted, "base64");
      tampered[28] ^= 0xff; // flip a ciphertext byte
      expect(() => decryptReveal(tampered.toString("base64"), "secret")).toThrow();
    });
  });
});