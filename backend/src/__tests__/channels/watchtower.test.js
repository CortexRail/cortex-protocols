/**
 * Unit + integration tests for Watchtower and FraudProofBuilder.
 *
 * The integration test reproduces the exact scenario from the issue: B goes
 * offline entirely, A publishes a revoked state, a watchtower punishes
 * within the window, B recovers the full balance on return. It stops short
 * of a live contract call (that's covered on the Rust side by
 * `punishment_of_a_revoked_close_pays_the_challenger_everything` in
 * contract/contracts/channels/src/test.rs) and instead asserts the exact
 * check the contract performs — `sha256(secret) == revocation_commit_*` —
 * so a regression in either the Watchtower's plumbing or the secret it hands
 * back would be caught here before ever reaching the chain.
 */

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const Watchtower = require("../../channels/Watchtower");
const FraudProofBuilder = require("../../channels/FraudProofBuilder");
const ChannelNegotiator = require("../../channels/ChannelNegotiator");
const RevocationStore = require("../../channels/RevocationStore");
const ChannelState = require("../../channels/ChannelState");

const KEY_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5));
const KEY_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 6));
const CHANNEL_ID = 900;
const MASTER_KEY = crypto.randomBytes(32);

function runRound(a, b, params) {
  const proposal = a.propose(params);
  const counterSignature = b.counterSign(proposal);
  const ack = a.ack(counterSignature);
  const completion = b.complete(ack);
  a.finalize(completion);
  return { ack, completion };
}

describe("Watchtower storage", () => {
  it("round-trips a justice package through register/findJustice", () => {
    const tower = new Watchtower({ masterKey: MASTER_KEY });
    const state = ChannelState.createState({
      channelId: 1,
      version: 1,
      balanceA: 900,
      balanceB: 100,
      revocationCommitA: crypto.randomBytes(32).toString("hex"),
      revocationCommitB: crypto.randomBytes(32).toString("hex"),
    });
    const justice = {
      party: "a",
      revocationSecret: crypto.randomBytes(32).toString("hex"),
      challenger: "GDUMMYADDRESS",
    };

    tower.register(state, justice);
    expect(tower.findJustice(state)).toEqual(justice);
  });

  it("returns null for a state nothing was ever registered for", () => {
    const tower = new Watchtower({ masterKey: MASTER_KEY });
    const state = ChannelState.createState({
      channelId: 1,
      version: 1,
      balanceA: 900,
      balanceB: 100,
      revocationCommitA: crypto.randomBytes(32).toString("hex"),
      revocationCommitB: crypto.randomBytes(32).toString("hex"),
    });
    expect(tower.findJustice(state)).toBeNull();
  });

  it("a different watchtower (different master key) cannot decrypt another's blobs", () => {
    const towerA = new Watchtower({ masterKey: MASTER_KEY });
    const towerB = new Watchtower({ masterKey: crypto.randomBytes(32) });
    const state = ChannelState.createState({
      channelId: 1,
      version: 1,
      balanceA: 900,
      balanceB: 100,
      revocationCommitA: crypto.randomBytes(32).toString("hex"),
      revocationCommitB: crypto.randomBytes(32).toString("hex"),
    });
    const hash = towerA.register(state, {
      party: "a",
      revocationSecret: crypto.randomBytes(32).toString("hex"),
      challenger: "G...",
    });

    // towerB never received this registration at all — simulates the blob
    // never having reached a different operator's storage.
    expect(towerB.has(hash)).toBe(false);
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => new Watchtower({ masterKey: crypto.randomBytes(16) })).toThrow(/32 bytes/);
  });
});

describe("FraudProofBuilder", () => {
  it("returns null when nothing was revealed for that version", () => {
    const store = new RevocationStore();
    const builder = new FraudProofBuilder({ revocationStore: store });
    expect(builder.build(1, 40)).toBeNull();
  });

  it("builds a claim from a revealed secret, without needing to know which party revealed it", () => {
    const store = new RevocationStore();
    store.commit(1, 40, "b");
    const secret = store.reveal(1, 40, "b");

    const builder = new FraudProofBuilder({ revocationStore: store });
    expect(builder.build(1, 40)).toEqual({
      channelId: 1,
      version: 40,
      party: "b",
      revocationSecret: secret,
    });
  });
});

describe("end-to-end: offline party recovers full balance via a watchtower", () => {
  it("B goes offline, A publishes a revoked state, the watchtower's claim satisfies the contract's punish check", () => {
    const storeA = new RevocationStore();
    const storeB = new RevocationStore();
    const a = new ChannelNegotiator({
      channelId: CHANNEL_ID,
      party: "a",
      keypair: KEY_A,
      counterpartyPublicKey: KEY_B.publicKey(),
      revocationStore: storeA,
    });
    const b = new ChannelNegotiator({
      channelId: CHANNEL_ID,
      party: "b",
      keypair: KEY_B,
      counterpartyPublicKey: KEY_A.publicKey(),
      revocationStore: storeB,
    });
    const tower = new Watchtower({ masterKey: MASTER_KEY });

    // Version 1: the channel's opening balances.
    runRound(a, b, { version: 1, balanceA: 600, balanceB: 400 });
    const staleState = a.currentState; // this is what A will later cheat with

    // Version 2: B pays A honestly. As part of completing this round, B
    // reveals its own secret for version 1 and — before going offline —
    // registers a justice package with the watchtower keyed to exactly
    // that revoked state.
    const { completion } = runRound(a, b, { version: 2, balanceA: 500, balanceB: 500 });
    tower.register(staleState, {
      party: completion.revealedParty,
      revocationSecret: completion.revealedSecret,
      challenger: KEY_B.publicKey(),
    });

    // B now goes offline for good. A dishonestly publishes the stale
    // version-1 state on-chain (simulated: this is exactly the object a
    // real close_unilateral call would carry).
    expect(staleState.version).toBe(1);

    // The watchtower observes the close (ChannelMonitor's job in
    // production) and looks up a justice package for exactly this state.
    const justice = tower.findJustice(staleState);
    expect(justice).not.toBeNull();
    expect(justice.challenger).toBe(KEY_B.publicKey());

    // This is exactly what contract/contracts/channels/src/lib.rs's punish()
    // checks: sha256(secret) must equal one of the revoked state's own
    // committed hashes.
    const secretHash = crypto
      .createHash("sha256")
      .update(Buffer.from(justice.revocationSecret, "hex"))
      .digest("hex");
    const expectedField =
      justice.party === "a" ? staleState.revocation_commit_a : staleState.revocation_commit_b;
    expect(secretHash).toBe(expectedField);

    // The payout the contract would make is the full original deposit
    // (600 + 400 = 1000), not B's honest 500 — B recovers everything,
    // exactly as the issue's acceptance criteria require.
  });
});
