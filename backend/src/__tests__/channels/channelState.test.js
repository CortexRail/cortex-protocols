/**
 * Unit tests for the payment-channel state primitives.
 *
 * Pure crypto and pure data structures — no database, no container — same
 * rationale as attestation.test.js: a regression in the signed wire format
 * or the versioning rule has to show up immediately, not only once the
 * contract crate exists to integration-test against.
 */

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const canonical = require("../../channels/canonical");
const ChannelState = require("../../channels/ChannelState");

const { Reason } = ChannelState;

const A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const MALLORY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));

function commit(seed) {
  return crypto.createHash("sha256").update(Buffer.from([seed])).digest("hex");
}

function dualSign(state, kpA = A, kpB = B) {
  const withA = ChannelState.withSignature(state, "a", ChannelState.sign(state, kpA));
  return ChannelState.withSignature(withA, "b", ChannelState.sign(state, kpB));
}

function state(overrides = {}) {
  return ChannelState.createState({
    channelId: 1,
    version: 0,
    balanceA: 1000,
    balanceB: 0,
    revocationCommitA: commit(0xa0),
    revocationCommitB: commit(0xb0),
    ...overrides,
  });
}

describe("canonical encoding", () => {
  const raw = {
    channel_id: 42,
    version: 7,
    balance_a: 600,
    balance_b: 400,
    revocation_commit_a: commit(0x01),
    revocation_commit_b: commit(0x02),
  };

  it("encodes a state as exactly 96 fixed-width bytes", () => {
    const encoded = canonical.encodeStatePreimage(raw);
    expect(encoded).toHaveLength(canonical.STATE_PREIMAGE_BYTES);
    expect(encoded.readBigUInt64BE(canonical.OFFSETS.channelId)).toBe(42n);
    expect(encoded.readBigUInt64BE(canonical.OFFSETS.version)).toBe(7n);
    expect(encoded.readBigUInt64BE(canonical.OFFSETS.balanceA)).toBe(600n);
    expect(encoded.readBigUInt64BE(canonical.OFFSETS.balanceB)).toBe(400n);
    expect(
      encoded
        .subarray(canonical.OFFSETS.revocationCommitA, canonical.OFFSETS.revocationCommitA + 32)
        .toString("hex")
    ).toBe(raw.revocation_commit_a);
    expect(
      encoded
        .subarray(canonical.OFFSETS.revocationCommitB, canonical.OFFSETS.revocationCommitB + 32)
        .toString("hex")
    ).toBe(raw.revocation_commit_b);
  });

  it("round-trips a state through encode/decode", () => {
    expect(canonical.decodeStatePreimage(canonical.encodeStatePreimage(raw))).toEqual(raw);
  });

  it("rejects a negative balance", () => {
    expect(() => canonical.encodeStatePreimage({ ...raw, balance_a: -1 })).toThrow();
  });

  it("rejects a revocation commitment of the wrong width", () => {
    expect(() =>
      canonical.encodeStatePreimage({ ...raw, revocation_commit_a: "ab".repeat(16) })
    ).toThrow(/64 hex characters/);
  });

  it("keeps the signing-message domain tag clear of the attestation module's", () => {
    const message = canonical.signingMessage(raw);
    expect(message[0]).toBe(canonical.DOMAIN_CHANNEL_STATE);
    expect(message[0]).not.toBe(0x00);
    expect(message[0]).not.toBe(0x01);
    expect(message[0]).not.toBe(0x02);
  });

  it("commitment hash changes if any balance field changes", () => {
    const h1 = canonical.commitmentHash(raw).toString("hex");
    const h2 = canonical.commitmentHash({ ...raw, balance_a: 601, balance_b: 399 }).toString("hex");
    expect(h1).not.toBe(h2);
  });

  it("commitment hash changes if either revocation commitment changes", () => {
    const h1 = canonical.commitmentHash(raw).toString("hex");
    const h2 = canonical
      .commitmentHash({ ...raw, revocation_commit_a: commit(0x99) })
      .toString("hex");
    const h3 = canonical
      .commitmentHash({ ...raw, revocation_commit_b: commit(0x99) })
      .toString("hex");
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe("createState", () => {
  it("builds an unsigned state with both signature slots empty", () => {
    const s = state();
    expect(s.sig_a).toBeNull();
    expect(s.sig_b).toBeNull();
  });

  it("carries both revocation commitments unchanged", () => {
    const s = state({ revocationCommitA: commit(0x11), revocationCommitB: commit(0x22) });
    expect(s.revocation_commit_a).toBe(commit(0x11));
    expect(s.revocation_commit_b).toBe(commit(0x22));
  });

  it("rejects a non-integer balance at creation, not later at sign time", () => {
    expect(() => state({ balanceA: 1.5 })).toThrow();
  });

  it("rejects a malformed revocation commitment at creation", () => {
    expect(() => state({ revocationCommitA: "not-hex" })).toThrow();
  });
});

describe("sign / withSignature / verify", () => {
  it("verifies a state signed by both correct parties", () => {
    const s = dualSign(state());
    expect(ChannelState.verify(s, A.publicKey(), B.publicKey())).toEqual({
      valid: true,
      reason: Reason.OK,
      message: null,
    });
  });

  it("rejects a state missing sig_a", () => {
    const s0 = state();
    const s = ChannelState.withSignature(s0, "b", ChannelState.sign(s0, B));
    expect(ChannelState.verify(s, A.publicKey(), B.publicKey()).reason).toBe(
      Reason.MISSING_SIGNATURE_A
    );
  });

  it("rejects a state missing sig_b", () => {
    const s0 = state();
    const s = ChannelState.withSignature(s0, "a", ChannelState.sign(s0, A));
    expect(ChannelState.verify(s, A.publicKey(), B.publicKey()).reason).toBe(
      Reason.MISSING_SIGNATURE_B
    );
  });

  it("rejects a signature from the wrong key", () => {
    const s0 = state();
    const withA = ChannelState.withSignature(s0, "a", ChannelState.sign(s0, MALLORY));
    const s = ChannelState.withSignature(withA, "b", ChannelState.sign(s0, B));
    expect(ChannelState.verify(s, A.publicKey(), B.publicKey()).reason).toBe(Reason.BAD_SIGNATURE_A);
  });

  it("rejects a state whose balance was tampered with after signing", () => {
    const s = dualSign(state());
    const tampered = { ...s, balance_a: s.balance_a - 100, balance_b: s.balance_b + 100 };
    const result = ChannelState.verify(tampered, A.publicKey(), B.publicKey());
    expect(result.valid).toBe(false);
    expect([Reason.BAD_SIGNATURE_A, Reason.BAD_SIGNATURE_B]).toContain(result.reason);
  });

  it("rejects a state whose version was tampered with after signing", () => {
    const s = dualSign(state({ version: 5 }));
    const tampered = { ...s, version: 6 };
    expect(ChannelState.verify(tampered, A.publicKey(), B.publicKey()).valid).toBe(false);
  });

  it("rejects a state whose revocation commitment was swapped after signing", () => {
    // The whole point of signing the commitments is that nobody — including
    // one of the two channel parties — can rebind a version to a different
    // revocation secret after the fact.
    const s = dualSign(state());
    const tampered = { ...s, revocation_commit_a: commit(0xff) };
    expect(ChannelState.verify(tampered, A.publicKey(), B.publicKey()).valid).toBe(false);
  });

  it("a single signer cannot produce a state that verifies alone", () => {
    // Neither party can unilaterally move funds: signing with only one key
    // and attaching that same signature to both slots must not verify.
    const s0 = state();
    const sigA = ChannelState.sign(s0, A);
    const bothA = ChannelState.withSignature(
      ChannelState.withSignature(s0, "a", sigA),
      "b",
      sigA
    );
    expect(ChannelState.verify(bothA, A.publicKey(), B.publicKey()).valid).toBe(false);
  });
});

describe("compareVersions / supersedes", () => {
  it("orders states of the same channel by version", () => {
    expect(ChannelState.compareVersions(state({ version: 5 }), state({ version: 3 }))).toBe(1);
    expect(ChannelState.compareVersions(state({ version: 3 }), state({ version: 5 }))).toBe(-1);
    expect(ChannelState.compareVersions(state({ version: 3 }), state({ version: 3 }))).toBe(0);
  });

  it("throws when comparing states from different channels", () => {
    expect(() =>
      ChannelState.compareVersions(state({ channelId: 1 }), state({ channelId: 2 }))
    ).toThrow(/different channels/);
  });

  it("a correctly signed higher version supersedes a stale close", () => {
    // The scenario from the issue: party A closes with version 40 while B
    // holds version 87. B's later state must supersede.
    const stale = dualSign(state({ version: 40, balanceA: 600, balanceB: 400 }));
    const later = dualSign(
      state({
        version: 87,
        balanceA: 100,
        balanceB: 900,
        revocationCommitA: commit(0x87),
        revocationCommitB: commit(0x88),
      })
    );
    expect(ChannelState.supersedes(later, stale, A.publicKey(), B.publicKey())).toBe(true);
    expect(ChannelState.supersedes(stale, later, A.publicKey(), B.publicKey())).toBe(false);
  });

  it("a higher version that is not validly signed does not supersede", () => {
    const stale = dualSign(state({ version: 40 }));
    const higher = state({ version: 41 });
    const forged = ChannelState.withSignature(
      ChannelState.withSignature(higher, "a", ChannelState.sign(higher, MALLORY)),
      "b",
      ChannelState.sign(higher, B)
    );
    expect(ChannelState.supersedes(forged, stale, A.publicKey(), B.publicKey())).toBe(false);
  });
});
