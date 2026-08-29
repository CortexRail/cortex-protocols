/**
 * Unit tests for RevocationStore — the commit/reveal ledger fraud proofs are
 * built on. No database: this store is deliberately in-process state, and a
 * production deployment would back it the same way attestation's index/nonce
 * stores are backed (see AttestationVerifier's pluggable stores) — out of
 * scope for this primitive.
 */

const crypto = require("crypto");
const RevocationStore = require("../../channels/RevocationStore");

describe("commit / reveal", () => {
  it("reveal returns a secret whose hash matches the committed hash", () => {
    const store = new RevocationStore();
    const commitmentHash = store.commit(1, 40, "a");
    const secret = store.reveal(1, 40, "a");

    const actualHash = crypto.createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
    expect(actualHash).toBe(commitmentHash);
  });

  it("is not revoked until the secret is actually revealed", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    expect(store.isRevoked(1, 40)).toBe(false);

    store.reveal(1, 40, "a");
    expect(store.isRevoked(1, 40)).toBe(true);
  });

  it("either party revealing is sufficient to mark a version revoked", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    store.commit(1, 40, "b");
    store.reveal(1, 40, "b");
    expect(store.isRevoked(1, 40)).toBe(true);
  });

  it("reveal is idempotent — calling twice returns the same secret", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    const first = store.reveal(1, 40, "a");
    const second = store.reveal(1, 40, "a");
    expect(second).toBe(first);
  });

  it("commit is one-shot: committing twice for the same slot throws", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    expect(() => store.commit(1, 40, "a")).toThrow(/already exists/);
  });

  it("revealing without a prior commitment throws", () => {
    const store = new RevocationStore();
    expect(() => store.reveal(1, 40, "a")).toThrow(/no revocation commitment/);
  });

  it("keeps commitments isolated per channel and per version", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    expect(() => store.reveal(1, 41, "a")).toThrow();
    expect(() => store.reveal(2, 40, "a")).toThrow();
    expect(store.isRevoked(1, 41)).toBe(false);
    expect(store.isRevoked(2, 40)).toBe(false);
  });

  it("rejects an unknown party", () => {
    const store = new RevocationStore();
    expect(() => store.commit(1, 40, "c")).toThrow(/party must be/);
  });
});

describe("verifySecret — the fraud-proof / punish() check", () => {
  it("validates a revealed secret against its commitment", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    const secret = store.reveal(1, 40, "a");

    expect(store.verifySecret(1, 40, secret)).toEqual({ valid: true, party: "a" });
  });

  it("does not require the caller to know which party committed", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "b");
    const secret = store.reveal(1, 40, "b");

    const result = store.verifySecret(1, 40, secret);
    expect(result.valid).toBe(true);
    expect(result.party).toBe("b");
  });

  it("rejects a secret that was never committed (forged punish attempt)", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    store.reveal(1, 40, "a");

    const forged = crypto.randomBytes(32).toString("hex");
    expect(store.verifySecret(1, 40, forged)).toEqual({ valid: false, party: null });
  });

  it("rejects a genuine secret presented against the wrong version — punishing a non-revoked state must fail", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    const secret = store.reveal(1, 40, "a");

    // Same secret, wrong (non-revoked) version: must not validate.
    expect(store.verifySecret(1, 41, secret)).toEqual({ valid: false, party: null });
  });

  it("accepts both hex-string and raw Buffer secrets", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    const secretHex = store.reveal(1, 40, "a");
    const secretBuf = Buffer.from(secretHex, "hex");

    expect(store.verifySecret(1, 40, secretHex).valid).toBe(true);
    expect(store.verifySecret(1, 40, secretBuf).valid).toBe(true);
  });

  it("verifySecret works even before reveal, since the hash was already committed", () => {
    // A watchtower only needs the secret to eventually be handed to it; the
    // commitment itself is what pins the value, not the local reveal flag.
    const store = new RevocationStore();
    store.commit(1, 40, "a");
    const commitmentHash = store.commitmentHashFor(1, 40, "a");

    // Simulate the secret arriving out-of-band (e.g. from a peer) without
    // this store's own reveal() ever having been called.
    const independentStore = new RevocationStore();
    independentStore.commit(1, 40, "a"); // different random secret, same slot shape
    expect(independentStore.commitmentHashFor(1, 40, "a")).not.toBe(commitmentHash);
  });
});

describe("recordCommitment / recordRevealedSecret — the two-process case", () => {
  // ChannelNegotiator runs one RevocationStore per party, in separate
  // processes. A's store generates and owns the 'a' secret; it never sees
  // B's raw secret until B's process reveals it over the wire, so it has to
  // be able to record B's *commitment* up front and B's *secret* later,
  // without ever generating either itself.

  it("lets a store record a counterparty's commitment without generating a secret", () => {
    const ownerStore = new RevocationStore();
    const commitmentHash = ownerStore.commit(1, 40, "a");

    const counterpartyStore = new RevocationStore();
    counterpartyStore.recordCommitment(1, 40, "a", commitmentHash);

    expect(counterpartyStore.commitmentHashFor(1, 40, "a")).toBe(commitmentHash);
  });

  it("recordCommitment is one-shot, same as commit()", () => {
    const store = new RevocationStore();
    store.recordCommitment(1, 40, "a", crypto.randomBytes(32).toString("hex"));
    expect(() =>
      store.recordCommitment(1, 40, "a", crypto.randomBytes(32).toString("hex"))
    ).toThrow(/already exists/);
  });

  it("accepts and verifies a secret revealed by the counterparty", () => {
    const ownerStore = new RevocationStore();
    const commitmentHash = ownerStore.commit(1, 40, "a");
    const secret = ownerStore.reveal(1, 40, "a");

    const counterpartyStore = new RevocationStore();
    counterpartyStore.recordCommitment(1, 40, "a", commitmentHash);
    counterpartyStore.recordRevealedSecret(1, 40, "a", secret);

    expect(counterpartyStore.isRevoked(1, 40)).toBe(true);
    expect(counterpartyStore.verifySecret(1, 40, secret)).toEqual({ valid: true, party: "a" });
  });

  it("rejects a revealed secret that does not match the recorded commitment", () => {
    const store = new RevocationStore();
    store.recordCommitment(1, 40, "a", crypto.randomBytes(32).toString("hex"));

    const wrongSecret = crypto.randomBytes(32).toString("hex");
    expect(() => store.recordRevealedSecret(1, 40, "a", wrongSecret)).toThrow(
      /does not match the recorded commitment/
    );
    expect(store.isRevoked(1, 40)).toBe(false);
  });

  it("reveal() refuses to act on a slot this store does not own", () => {
    const store = new RevocationStore();
    store.recordCommitment(1, 40, "a", crypto.randomBytes(32).toString("hex"));
    expect(() => store.reveal(1, 40, "a")).toThrow(/recordRevealedSecret instead/);
  });
});

describe("commitmentHashFor", () => {
  it("returns null when nothing has been committed", () => {
    const store = new RevocationStore();
    expect(store.commitmentHashFor(1, 40, "a")).toBeNull();
  });

  it("returns a 64-character hex sha256 digest", () => {
    const store = new RevocationStore();
    const hash = store.commit(1, 40, "a");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.commitmentHashFor(1, 40, "a")).toBe(hash);
  });
});
