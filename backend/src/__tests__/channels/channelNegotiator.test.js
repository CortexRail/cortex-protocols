/**
 * Unit tests for ChannelNegotiator — the propose/counter-sign/ack/complete
 * handshake. Two independent negotiator instances (and two independent
 * RevocationStores) stand in for two separate agent processes exchanging
 * plain-object messages, which is the only channel they'd have over a real
 * network too.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const ChannelNegotiator = require("../../channels/ChannelNegotiator");
const RevocationStore = require("../../channels/RevocationStore");
const ChannelState = require("../../channels/ChannelState");

const KEY_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const KEY_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const CHANNEL_ID = 7;

function makePair() {
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
  return { a, b, storeA, storeB };
}

/** Run one full round: A proposes, B countersigns, A acks, B completes, A finalizes. */
function runRound(a, b, { version, balanceA, balanceB }) {
  const proposal = a.propose({ version, balanceA, balanceB });
  const counterSignature = b.counterSign(proposal);
  const ack = a.ack(counterSignature);
  const completion = b.complete(ack);
  a.finalize(completion);
  return { proposal, counterSignature, ack, completion };
}

describe("full happy-path negotiation", () => {
  it("both sides converge on the same fully-signed state", () => {
    const { a, b } = makePair();
    runRound(a, b, { version: 1, balanceA: 900, balanceB: 100 });

    expect(a.currentState).toEqual(b.currentState);
    expect(
      ChannelState.verify(a.currentState, KEY_A.publicKey(), KEY_B.publicKey()).valid
    ).toBe(true);
  });

  it("the first negotiation on a channel reveals nothing — there is no previous version", () => {
    const { a, b } = makePair();
    const { ack, completion } = runRound(a, b, { version: 1, balanceA: 900, balanceB: 100 });

    expect(ack.revealedSecret).toBeNull();
    expect(completion.revealedSecret).toBeNull();
  });

  it("a second round reveals and mutually verifies the first version's secrets", () => {
    const { a, b, storeA, storeB } = makePair();
    runRound(a, b, { version: 1, balanceA: 900, balanceB: 100 });
    runRound(a, b, { version: 2, balanceA: 800, balanceB: 200 });

    // Both parties' local stores now agree version 1 is revoked — each
    // learned the *other* party's secret for it via the handshake, not by
    // generating it themselves.
    expect(storeA.isRevoked(CHANNEL_ID, 1)).toBe(true);
    expect(storeB.isRevoked(CHANNEL_ID, 1)).toBe(true);
  });

  it("many sequential rounds settle at the final balance with each prior version revoked", () => {
    const { a, b, storeA } = makePair();
    let balanceA = 1_000_000;
    let balanceB = 0;

    for (let version = 1; version <= 25; version++) {
      balanceA -= 100;
      balanceB += 100;
      runRound(a, b, { version, balanceA, balanceB });
    }

    expect(a.currentState.balance_a).toBe(1_000_000 - 2500);
    expect(a.currentState.balance_b).toBe(2500);
    expect(a.currentState.version).toBe(25);
    // Every version before the last is revoked; the current one is not.
    for (let v = 1; v < 25; v++) {
      expect(storeA.isRevoked(CHANNEL_ID, v)).toBe(true);
    }
    expect(storeA.isRevoked(CHANNEL_ID, 25)).toBe(false);
  });
});

describe("safety against a counterparty who abandons the exchange", () => {
  it("abandonment after propose() leaves the proposer's old state untouched", () => {
    const { a, b, storeA } = makePair();
    runRound(a, b, { version: 1, balanceA: 900, balanceB: 100 });
    const before = a.currentState;

    a.propose({ version: 2, balanceA: 800, balanceB: 200 });
    // B never responds.

    expect(a.currentState).toEqual(before);
    expect(storeA.isRevoked(CHANNEL_ID, 1)).toBe(false);
    expect(ChannelState.verify(a.currentState, KEY_A.publicKey(), KEY_B.publicKey()).valid).toBe(
      true
    );
  });

  it("abandonment after counterSign() leaves both sides' old states untouched", () => {
    const { a, b, storeA, storeB } = makePair();
    runRound(a, b, { version: 1, balanceA: 900, balanceB: 100 });
    const beforeA = a.currentState;
    const beforeB = b.currentState;

    const proposal = a.propose({ version: 2, balanceA: 800, balanceB: 200 });
    b.counterSign(proposal);
    // The counter-signature never reaches A.

    expect(a.currentState).toEqual(beforeA);
    expect(b.currentState).toEqual(beforeB);
    expect(storeA.isRevoked(CHANNEL_ID, 1)).toBe(false);
    expect(storeB.isRevoked(CHANNEL_ID, 1)).toBe(false);
  });

  it("abandonment after ack() still leaves the proposer holding a valid new state, and the counterparty's old state safe", () => {
    // The one case where a secret does get revealed before the handshake
    // fully closes out: A has already verified the complete dual-signed
    // state by the time it reveals anything, so A is never left worse off
    // even if B vanishes right here.
    const { a, b, storeA, storeB } = makePair();
    runRound(a, b, { version: 1, balanceA: 900, balanceB: 100 });
    const bBefore = b.currentState;

    const proposal = a.propose({ version: 2, balanceA: 800, balanceB: 200 });
    const counterSignature = b.counterSign(proposal);
    const ack = a.ack(counterSignature);
    // The ack never reaches B.

    // A already has a fully valid, fully signed version-2 state to close
    // with — abandonment cost it nothing.
    expect(a.currentState.version).toBe(2);
    expect(ChannelState.verify(a.currentState, KEY_A.publicKey(), KEY_B.publicKey()).valid).toBe(
      true
    );
    // A safely revoked its own superseded state, having already verified the successor.
    expect(storeA.isRevoked(CHANNEL_ID, 1)).toBe(true);

    // B never called complete(), so B's view of version 1 is untouched and
    // still fully valid — B lost nothing either.
    expect(b.currentState).toEqual(bBefore);
    expect(storeB.isRevoked(CHANNEL_ID, 1)).toBe(false);
    expect(ChannelState.verify(b.currentState, KEY_A.publicKey(), KEY_B.publicKey()).valid).toBe(
      true
    );

    void ack; // the message that would have completed the handshake, unused here
  });
});

describe("validation", () => {
  it("rejects countersigning your own proposal", () => {
    const { a } = makePair();
    const proposal = a.propose({ version: 1, balanceA: 900, balanceB: 100 });
    expect(() => a.counterSign(proposal)).toThrow(/own proposal/);
  });

  it("rejects a proposal that does not advance the version", () => {
    const { a, b } = makePair();
    runRound(a, b, { version: 5, balanceA: 900, balanceB: 100 });
    expect(() => a.propose({ version: 5, balanceA: 800, balanceB: 200 })).toThrow(
      /does not exceed/
    );
    expect(() => a.propose({ version: 4, balanceA: 800, balanceB: 200 })).toThrow(
      /does not exceed/
    );
  });

  it("counterSign rejects a proposal that does not advance the version", () => {
    const { a, b } = makePair();
    runRound(a, b, { version: 5, balanceA: 900, balanceB: 100 });

    const staleProposal = {
      channelId: CHANNEL_ID,
      version: 5,
      balanceA: 850,
      balanceB: 150,
      proposerParty: "a",
      proposerCommitmentHash: "00".repeat(32),
    };
    expect(() => b.counterSign(staleProposal)).toThrow(/does not exceed/);
  });

  it("ack rejects a forged counter-signature", () => {
    const { a, b } = makePair();
    const proposal = a.propose({ version: 1, balanceA: 900, balanceB: 100 });
    const counterSignature = b.counterSign(proposal);
    counterSignature.signature = ChannelState.sign(
      ChannelState.createState({
        channelId: CHANNEL_ID,
        version: 1,
        balanceA: 1,
        balanceB: 1,
        revocationCommitA: "00".repeat(32),
        revocationCommitB: "00".repeat(32),
      }),
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9)) // impostor key
    );

    expect(() => a.ack(counterSignature)).toThrow(/does not verify/);
  });

  it("rejects starting a new proposal while one is already in flight", () => {
    const { a } = makePair();
    a.propose({ version: 1, balanceA: 900, balanceB: 100 });
    expect(() => a.propose({ version: 2, balanceA: 800, balanceB: 200 })).toThrow(
      /already in flight/
    );
  });
});
