/**
 * An in-memory stand-in for `CortexAgentSDK`.
 *
 * Implements the same six methods a synthetic agent calls, backed by plain
 * objects instead of HTTP and Soroban. It exists so the swarm can be exercised
 * end to end — including settlement and reconciliation — inside a unit test, on
 * every pull request, with no network, no database, and no contracts deployed.
 *
 * It is deliberately not a mock: it enforces the rules that matter (a stream
 * has a finite balance, a spent stream returns 402, a closed stream cannot be
 * called), so a swarm bug shows up here rather than only in the nightly run.
 */

const { createRng } = require("./rng");

/** A small marketplace the fake serves to every agent that discovers. */
const DEFAULT_ASSETS = [
  { id: 1, price: 100, owner: "GSELLER_A" },
  { id: 2, price: 250, owner: "GSELLER_B" },
  { id: 3, price: 90, owner: "GSELLER_C" },
  { id: 4, price: 400, owner: "GSELLER_A" },
];

class FakeProtocolTransport {
  /**
   * @param {object} [options]
   * @param {Array<{id: number, price: number, owner: string}>} [options.assets]
   * @param {number} [options.seed]
   * @param {number} [options.failureRate] - Fraction of metered calls that error.
   */
  constructor({ assets = DEFAULT_ASSETS, seed = 7, failureRate = 0 } = {}) {
    this.assets = assets.map((a) => ({ ...a }));
    this.rng = createRng(seed);
    this.failureRate = failureRate;
    /** @type {Map<number, object>} */
    this.streams = new Map();
    this.nextStreamId = 1;
    this.callCount = 0;
  }

  async discover() {
    return { data: this.assets.map((a) => ({ ...a })) };
  }

  async getQuote(assetId) {
    const asset = this.assets.find((a) => String(a.id) === String(assetId));
    if (!asset) throw new Error(`Unknown asset ${assetId}`);
    return { assetId: asset.id, price: asset.price, expiresAt: Date.now() + 60_000 };
  }

  async openStream(assetId, depositXlm) {
    const asset = this.assets.find((a) => String(a.id) === String(assetId));
    if (!asset) throw new Error(`Unknown asset ${assetId}`);

    const streamId = this.nextStreamId++;
    const deposit = Math.floor(depositXlm * 10_000_000);
    const stream = {
      streamId,
      assetId: asset.id,
      rate: asset.price,
      deposit,
      spent: 0,
      open: true,
    };
    this.streams.set(streamId, stream);

    return { streamId, streamToken: `token-${streamId}`, stream: { ...stream } };
  }

  async call(streamToken) {
    const streamId = Number(String(streamToken).replace("token-", ""));
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error("Unknown stream token");
    if (!stream.open) throw new Error("Stream is closed");

    if (stream.spent + stream.rate > stream.deposit) {
      const err = new Error("Payment Required: Stream balance exhausted or expired (402)");
      err.status = 402;
      throw err;
    }

    if (this.failureRate > 0 && this.rng() < this.failureRate) {
      throw new Error("upstream unavailable");
    }

    stream.spent += stream.rate;
    this.callCount += 1;
    return { ok: true, spent: stream.spent, remaining: stream.deposit - stream.spent };
  }

  async getBalance(streamId) {
    const stream = this.streams.get(Number(streamId));
    return stream ? stream.spent : 0;
  }

  async closeStream(streamId) {
    const stream = this.streams.get(Number(streamId));
    if (!stream) throw new Error(`Unknown stream ${streamId}`);
    stream.open = false;
    return { streamId: stream.streamId, settled: stream.spent, refunded: stream.deposit - stream.spent };
  }

  /** Streams that were opened but never closed — the leak the swarm must not have. */
  get openStreams() {
    return [...this.streams.values()].filter((s) => s.open);
  }
}

module.exports = { FakeProtocolTransport, DEFAULT_ASSETS };
