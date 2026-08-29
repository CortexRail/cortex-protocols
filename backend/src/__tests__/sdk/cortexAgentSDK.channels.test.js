/**
 * Unit tests for CortexAgentSDK's payment-channel negotiation wiring.
 *
 * Covers only the network-free half: two SDK instances (standing in for two
 * separate agents) driving ChannelNegotiator through the SDK's
 * payInChannel / receiveChannel... / getChannelState methods. The on-chain calls
 * (registerChannelKey, openChannel, closeChannel) need a live RPC endpoint
 * and are exercised on the Rust side instead — see
 * contract/contracts/channels/src/test.rs, which covers the exact same
 * ChannelState wire format these methods build.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const CortexAgentSDK = require("../../sdk/CortexAgentSDK");
const ChannelState = require("../../channels/ChannelState");

const KEY_A = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));
const KEY_B = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22));
const CHANNEL_ID = 55;

function makeAgents() {
  const a = new CortexAgentSDK({ backendUrl: "http://localhost:4000", buyerKeypair: KEY_A });
  const b = new CortexAgentSDK({ backendUrl: "http://localhost:4000", buyerKeypair: KEY_B });
  a.joinChannel(CHANNEL_ID, { party: "a", counterpartyPublicKey: KEY_B.publicKey() });
  b.joinChannel(CHANNEL_ID, { party: "b", counterpartyPublicKey: KEY_A.publicKey() });
  return { a, b };
}

/** Drive one full round through both agents' SDKs. */
function runRound(a, b, { balanceA, balanceB }) {
  const proposal = a.payInChannel(CHANNEL_ID, balanceA, balanceB);
  const counterSignature = b.receiveChannelProposal(CHANNEL_ID, proposal);
  const ack = a.receiveChannelCounterSignature(CHANNEL_ID, counterSignature);
  const completion = b.receiveChannelAck(CHANNEL_ID, ack);
  a.receiveChannelCompletion(CHANNEL_ID, completion);
  return { ack, completion };
}

describe("CortexAgentSDK channel negotiation", () => {
  it("both agents converge on the same fully-signed state after one round", () => {
    const { a, b } = makeAgents();
    runRound(a, b, { balanceA: 900, balanceB: 100 });

    expect(a.getChannelState(CHANNEL_ID)).toEqual(b.getChannelState(CHANNEL_ID));
    expect(
      ChannelState.verify(a.getChannelState(CHANNEL_ID), KEY_A.publicKey(), KEY_B.publicKey()).valid
    ).toBe(true);
  });

  it("payInChannel advances the version automatically", () => {
    const { a, b } = makeAgents();
    runRound(a, b, { balanceA: 900, balanceB: 100 });
    runRound(a, b, { balanceA: 800, balanceB: 200 });

    expect(a.getChannelState(CHANNEL_ID).version).toBe(2);
    expect(a.getChannelState(CHANNEL_ID).balance_a).toBe(800);
  });

  it("a completed round hands back everything registerWatchtower needs", () => {
    const { a, b } = makeAgents();
    runRound(a, b, { balanceA: 900, balanceB: 100 }); // version 1, nothing revoked yet
    const { completion } = runRound(a, b, { balanceA: 800, balanceB: 200 }); // revokes version 1

    expect(completion.revokedState.version).toBe(1);
    expect(completion.revealedSecret).toEqual(expect.any(String));
    expect(["a", "b"]).toContain(completion.revealedParty);
  });

  it("methods that touch a channel this agent never joined throw a clear error", () => {
    const a = new CortexAgentSDK({ backendUrl: "http://localhost:4000", buyerKeypair: KEY_A });
    expect(() => a.payInChannel(999, 1, 1)).toThrow(/no local channel negotiator/);
  });

  it("payForCallViaChannel reports no channel available before joinChannel", () => {
    const a = new CortexAgentSDK({ backendUrl: "http://localhost:4000", buyerKeypair: KEY_A });
    expect(a.payForCallViaChannel(KEY_B.publicKey(), 10)).toEqual({ viaChannel: false });
  });

  it("payForCallViaChannel reports no channel available before any balance is negotiated", () => {
    const { a } = makeAgents();
    // joinChannel happened, but no round has run yet — currentState is null.
    expect(a.payForCallViaChannel(KEY_B.publicKey(), 10)).toEqual({ viaChannel: false });
  });

  it("payForCallViaChannel deducts from the caller's own balance and proposes the next version", () => {
    const { a, b } = makeAgents();
    runRound(a, b, { balanceA: 1000, balanceB: 0 });

    const result = a.payForCallViaChannel(KEY_B.publicKey(), 25);
    expect(result.viaChannel).toBe(true);
    expect(result.channelId).toBe(CHANNEL_ID);
    expect(result.proposal.balanceA).toBe(975);
    expect(result.proposal.balanceB).toBe(25);
    expect(result.proposal.version).toBe(2);
  });

  it("payForCallViaChannel falls back to false when the caller's balance can't cover the price", () => {
    const { a, b } = makeAgents();
    runRound(a, b, { balanceA: 10, balanceB: 990 });

    expect(a.payForCallViaChannel(KEY_B.publicKey(), 25)).toEqual({ viaChannel: false });
  });

  it("works symmetrically for the counterparty (party b) side of the channel", () => {
    const { a, b } = makeAgents();
    runRound(a, b, { balanceA: 400, balanceB: 600 });

    const result = b.payForCallViaChannel(KEY_A.publicKey(), 50);
    expect(result.viaChannel).toBe(true);
    expect(result.proposal.balanceB).toBe(550);
    expect(result.proposal.balanceA).toBe(450);
  });

  it("registerWatchtower rejects a call missing the revoked-state context", async () => {
    const { a } = makeAgents();
    await expect(a.registerWatchtower(CHANNEL_ID, "http://tower.example")).rejects.toThrow(
      /needs the state that was just superseded/
    );
  });
});
