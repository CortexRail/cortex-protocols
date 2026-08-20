/**
 * A scriptable autonomous agent that drives the real protocol loop.
 *
 * One agent runs the whole buyer journey — discover → quote → open stream →
 * metered calls → settle — against a `CortexAgentSDK` client, deciding what to
 * do at each step through its injected behaviour strategy.
 *
 * The SDK client arrives through a factory rather than being constructed here,
 * which is what lets the smoke test run a full swarm in-process against a fake
 * transport with no network, no contracts, and no wall-clock waiting.
 */

const { deriveRng } = require("./rng");
const { getStrategy } = require("./strategies");

/** Agent lifecycle states, in the order they are entered. */
const AgentState = {
  IDLE: "idle",
  DISCOVERING: "discovering",
  STREAMING: "streaming",
  SETTLING: "settling",
  DONE: "done",
  FAILED: "failed",
};

class SyntheticAgent {
  /**
   * @param {object} options
   * @param {string} options.id - Stable identifier used in logs and the report.
   * @param {object|string} options.strategy - A strategy object or its name.
   * @param {object} options.client - A `CortexAgentSDK`-shaped client.
   * @param {import("./SimulationMetrics").SimulationMetrics} options.metrics
   * @param {number} [options.seed] - Seed for this agent's decision stream.
   * @param {number} [options.index] - Position in the swarm, mixed into the seed.
   * @param {(ms: number) => Promise<void>} [options.sleep] - Injectable delay.
   * @param {() => number} [options.clock] - Injectable clock, for latency timing.
   */
  constructor({ id, strategy, client, metrics, seed = 1, index = 0, sleep, clock = Date.now }) {
    if (!id) throw new Error("SyntheticAgent requires an id");
    if (!client) throw new Error("SyntheticAgent requires a client");
    if (!metrics) throw new Error("SyntheticAgent requires a metrics collector");

    this.id = id;
    this.strategy = typeof strategy === "string" ? getStrategy(strategy) : strategy;
    if (!this.strategy) throw new Error(`Agent ${id} has no strategy`);

    this.client = client;
    this.metrics = metrics;
    this.rng = deriveRng(seed, index);
    this.clock = clock;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    this.state = AgentState.IDLE;
    /** @type {import("./strategies").AgentMemory} */
    this.memory = { sellersUsed: new Set(), callsMade: 0 };
    this.stopRequested = false;

    /** Everything the reconciliation check and the report need afterwards. */
    this.ledger = {
      streamsOpened: 0,
      streamsSettled: 0,
      callsAttempted: 0,
      callsSucceeded: 0,
      callsDropped: 0,
      depositedStroops: 0,
      settledStroops: 0,
      errors: [],
    };
  }

  /** Asks the agent to wind down at its next safe checkpoint. */
  stop() {
    this.stopRequested = true;
  }

  /** True once the agent has been asked to stop. */
  get shouldStop() {
    return this.stopRequested;
  }

  /**
   * Runs the full buyer journey once.
   *
   * Never throws: a failure is recorded on the agent's ledger and moves it to
   * `FAILED`, because one bad agent must not take the swarm down with it.
   *
   * @returns {Promise<object>} This agent's ledger.
   */
  async run() {
    try {
      const asset = await this.discover();
      if (!asset) {
        this.state = AgentState.DONE;
        return this.ledger;
      }

      const session = await this.openStream(asset);
      if (!session) {
        this.state = AgentState.FAILED;
        return this.ledger;
      }

      await this.makeCalls(session);
      await this.settle(session);

      this.state = AgentState.DONE;
    } catch (err) {
      this.state = AgentState.FAILED;
      this.ledger.errors.push(err?.message ?? String(err));
    }

    return this.ledger;
  }

  /** Discovers assets and picks one according to the strategy. */
  async discover() {
    this.state = AgentState.DISCOVERING;

    const result = await this.metrics.time(
      "handshake",
      () => this.client.discover({ limit: 25 }),
      this.clock
    );

    const assets = normalizeAssets(result);
    if (assets.length === 0) return null;

    const chosen = this.strategy.chooseAsset(assets, this.memory);
    if (!chosen) return null;

    // A quote is a separate priced operation and gets its own latency bucket.
    await this.metrics.time("quote", () => this.client.getQuote(chosen.id), this.clock);

    return chosen;
  }

  /** Opens a payment stream for `asset`. Returns null when it could not open. */
  async openStream(asset) {
    this.state = AgentState.STREAMING;

    const depositXlm = this.strategy.depositXlm(asset);
    try {
      const session = await this.metrics.time(
        "streamOpen",
        () => this.client.openStream(asset.id, depositXlm, 1),
        this.clock
      );

      this.ledger.streamsOpened += 1;
      this.ledger.depositedStroops += Math.floor(depositXlm * 10_000_000);
      this.memory.sellersUsed.add(asset.owner);

      return { ...session, asset, depositXlm };
    } catch (err) {
      this.ledger.errors.push(`openStream: ${err?.message ?? String(err)}`);
      return null;
    }
  }

  /** Makes metered calls until the budget runs out or a stop is requested. */
  async makeCalls(session) {
    const budget = this.strategy.maxCalls();

    for (let i = 0; i < budget; i++) {
      if (this.stopRequested) break;

      const extraDelay = this.strategy.responseDelayMs(this.rng);
      if (extraDelay > 0) await this.sleep(extraDelay);

      this.ledger.callsAttempted += 1;

      // A flaky agent abandons some of its own calls; the swarm must still
      // settle its stream cleanly afterwards.
      if (this.strategy.shouldDropCall(this.rng)) {
        this.ledger.callsDropped += 1;
        this.metrics.record("meteredCall", extraDelay, { ok: false, error: "dropped by agent" });
        continue;
      }

      try {
        await this.metrics.time(
          "meteredCall",
          () => this.client.call(session.streamToken, { agentId: this.id, seq: i }),
          this.clock
        );
        this.ledger.callsSucceeded += 1;
        this.memory.callsMade += 1;
      } catch (err) {
        const message = err?.message ?? String(err);
        this.ledger.errors.push(`call: ${message}`);
        // A 402 means the stream is spent; there is nothing left to buy.
        if (message.includes("402") || /Payment Required/i.test(message)) break;
      }

      const delay = this.strategy.callDelayMs(this.rng);
      if (delay > 0) await this.sleep(delay);
    }
  }

  /** Closes the stream and records what was actually settled. */
  async settle(session) {
    this.state = AgentState.SETTLING;

    try {
      const balance = await this.client.getBalance(session.streamId).catch(() => 0);
      await this.metrics.time(
        "settlement",
        () => this.client.closeStream(session.streamId),
        this.clock
      );
      this.ledger.streamsSettled += 1;
      this.ledger.settledStroops += Number(balance) || 0;
    } catch (err) {
      this.ledger.errors.push(`settle: ${err?.message ?? String(err)}`);
    }
  }
}

/**
 * Normalizes the several shapes `discover()` can return into candidates.
 *
 * The backend returns `{ data: [...] }` on some routes and a bare array on
 * others, and assets carry their price under `price` or `pricePerCall`.
 *
 * @param {unknown} result
 * @returns {import("./strategies").Candidate[]}
 */
function normalizeAssets(result) {
  const list = Array.isArray(result) ? result : (result?.data ?? result?.assets ?? []);
  if (!Array.isArray(list)) return [];

  return list
    .filter((asset) => asset && asset.id !== undefined)
    .map((asset) => ({
      id: asset.id,
      price: Number(asset.price ?? asset.pricePerCall ?? asset.price_per_call ?? 0),
      owner: asset.owner ?? asset.owner_public_key ?? "unknown",
    }));
}

module.exports = { SyntheticAgent, AgentState, normalizeAssets };
