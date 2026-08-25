/**
 * Unit tests for ChannelMonitor's per-event handler.
 *
 * `processUnilateralClose` takes its RPC calls and Watchtower as injected
 * dependencies, so this suite never touches the network or a real
 * Watchtower's encryption — it only has to prove the dispatch logic is
 * right: skip when there's nothing to do, submit `punish` with the right
 * arguments when the Watchtower actually holds a matching justice package.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const { processUnilateralClose } = require("../protocol/ChannelMonitor");

function fakeKeypair(publicKey) {
  return { publicKey: () => publicKey };
}

describe("processUnilateralClose", () => {
  // Address.fromString inside processUnilateralClose needs a real,
  // checksum-valid Stellar address — an arbitrary fake string would throw
  // before invokeContract is ever reached.
  const CHALLENGER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();

  it("skips when the channels contract is not configured", async () => {
    const result = await processUnilateralClose(
      { watchtower: { findJustice: jest.fn() }, signerKeypair: fakeKeypair("G..."), contractId: "" },
      1
    );
    expect(result).toEqual({ action: "skipped", reason: "channels contract not configured" });
  });

  it("skips when the channel has no pending close", async () => {
    const viewContract = jest.fn().mockResolvedValue(null);
    const result = await processUnilateralClose(
      {
        contractId: "C_CHANNELS",
        viewContract,
        watchtower: { findJustice: jest.fn() },
        signerKeypair: fakeKeypair("GSIGNER"),
      },
      1
    );
    expect(result).toEqual({ action: "skipped", reason: "channel is not currently closing" });
  });

  it("skips when the watchtower holds no justice package for this state", async () => {
    const pending = {
      version: 40,
      balance_a: 600,
      balance_b: 400,
      revocation_commit_a: Buffer.alloc(32, 1),
      revocation_commit_b: Buffer.alloc(32, 2),
    };
    const viewContract = jest.fn().mockResolvedValue(pending);
    const findJustice = jest.fn().mockReturnValue(null);

    const result = await processUnilateralClose(
      {
        contractId: "C_CHANNELS",
        viewContract,
        watchtower: { findJustice },
        signerKeypair: fakeKeypair("GSIGNER"),
      },
      1
    );

    expect(result).toEqual({ action: "skipped", reason: "no justice package for this state" });
    expect(findJustice).toHaveBeenCalledWith({
      channel_id: 1,
      version: 40,
      balance_a: 600,
      balance_b: 400,
      revocation_commit_a: "01".repeat(32),
      revocation_commit_b: "02".repeat(32),
    });
  });

  it("submits punish with the challenger and secret from the watchtower's claim", async () => {
    const pending = {
      version: 40,
      balance_a: 600,
      balance_b: 400,
      revocation_commit_a: Buffer.alloc(32, 1),
      revocation_commit_b: Buffer.alloc(32, 2),
    };
    const justice = {
      party: "a",
      revocationSecret: "aa".repeat(32),
      challenger: CHALLENGER,
    };
    const viewContract = jest.fn().mockResolvedValue(pending);
    const findJustice = jest.fn().mockReturnValue(justice);
    const invokeContract = jest.fn().mockResolvedValue(1000);

    const result = await processUnilateralClose(
      {
        contractId: "C_CHANNELS",
        viewContract,
        invokeContract,
        watchtower: { findJustice },
        signerKeypair: fakeKeypair("GSIGNER"),
      },
      42
    );

    expect(result).toEqual({ action: "punished", payout: 1000 });
    expect(invokeContract).toHaveBeenCalledTimes(1);
    const [contractId, method] = invokeContract.mock.calls[0];
    expect(contractId).toBe("C_CHANNELS");
    expect(method).toBe("punish");
  });
});
