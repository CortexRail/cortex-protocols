/**
 * Runs a swarm of synthetic agents against the protocol concurrently.
 *
 * Spawns N agents from a strategy mix, lets them run the full buyer journey in
 * parallel for a bounded window, then shuts them down gracefully and checks
 * that what the agents believe happened matches what the protocol recorded.
 *
 * The SDK client is supplied by an injected factory. Against a real deployment
 * that factory returns a `CortexAgentSDK`; in tests it returns an in-memory
 * fake, which is how a 5-agent smoke run executes in milliseconds on every PR.
 */

const { SimulationMetrics } = require("./SimulationMetrics");
const { SyntheticAgent, AgentState } = require("./SyntheticAgent");
const { expandMix } = require("./strategies");

/** Defaults for a quick local run. The nightly job overrides all of these. */
const DEFAULT_CONFIG = {
  agentCount: 10,
  durationMs: 60_000,
  seed: 1,
  mix: { GreedyBuyer: 4, LoyalBuyer: 3, FlakySeller: 2, HighVolumeCaller: 1 },
  shutdownGraceMs: 10_000,
};

class SwarmOrchestrator {
  /**
   * @param {object} options
   * @param {(agentIndex: number) => object} options.clientFactory - Builds one agent's SDK client.
   * @param {Partial<typeof DEFAULT_CONFIG>} [options.config]
   * @param {(msg: string) => void} [options.log]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {() => number} [options.clock]
   */
  constructor({ clientFactory, config = {}, log = () => {}, sleep, clock = Date.now }) {
    if (typeof clientFactory !== "function") {
      throw new Error("SwarmOrchestrator requires a clientFactory function");
    }

    this.clientFactory = clientFactory;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = log;
    this.clock = clock;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.metrics = new SimulationMetrics();
    /** @type {SyntheticAgent[]} */
    this.agents = [];
    this.stopped = false;
  }

  /** Builds the agent roster without starting it. */
  spawn() {
    const strategies = expandMix(this.config.mix, this.config.agentCount);

    this.agents = strategies.map(
      (strategy, index) =>
        new SyntheticAgent({
          id: `agent-${String(index).padStart(3, "0")}`,
          strategy,
          client: this.clientFactory(index),
          metrics: this.metrics,
          seed: this.config.seed,
          index,
          sleep: this.sleep,
          clock: this.clock,
        })
    );

    this.log(
      `spawned ${this.agents.length} agents: ${summarizeMix(this.agents)}`
    );
    return this.agents;
  }

  /** Asks every agent to wind down at its next checkpoint. */
  stopAll() {
    this.stopped = true;
    for (const agent of this.agents) agent.stop();
  }

  /**
   * Runs the swarm to completion or until the duration budget expires.
   *
   * @returns {Promise<object>} The full run result, ready for the reporter.
   */
  async run() {
    if (this.agents.length === 0) this.spawn();

    this.metrics.start(this.clock());

    // The deadline is a hard stop: agents are asked to wind down, and the
    // grace window lets in-flight calls settle rather than being abandoned.
    const deadline = this.deadlineTimer();
    const results = await Promise.all(this.agents.map((agent) => agent.run()));
    deadline.cancel();

    this.metrics.finish(this.clock());

    const totals = aggregate(results, this.agents);
    const reconciliation = this.reconcile(totals);

    this.log(
      `swarm finished: ${totals.streamsOpened} streams opened, ` +
        `${totals.streamsSettled} settled, ${totals.callsSucceeded} calls succeeded`
    );

    return {
      config: this.config,
      metrics: this.metrics.toJSON(),
      totals,
      reconciliation,
      agents: this.agents.map((agent, index) => ({
        id: agent.id,
        strategy: agent.strategy.name,
        state: agent.state,
        ledger: results[index],
      })),
    };
  }

  /**
   * Schedules the wind-down that enforces `config.durationMs`.
   *
   * @returns {{ cancel: () => void }}
   */
  deadlineTimer() {
    if (!Number.isFinite(this.config.durationMs) || this.config.durationMs <= 0) {
      return { cancel: () => {} };
    }

    const timer = setTimeout(() => {
      this.log(`duration budget of ${this.config.durationMs}ms reached, winding down`);
      this.stopAll();
    }, this.config.durationMs);

    // A pending deadline must never be the reason the process stays alive.
    if (typeof timer.unref === "function") timer.unref();

    return { cancel: () => clearTimeout(timer) };
  }

  /**
   * Checks the swarm's own books for internal consistency.
   *
   * Every stream an agent opened has to end settled, and every call has to be
   * accounted for as either a success, a drop, or an error. A run that fails
   * this left value stranded on-chain, which is exactly what the nightly job
   * exists to catch.
   *
   * @param {object} totals
   * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail: string }> }}
   */
  reconcile(totals) {
    const checks = [
      {
        name: "every opened stream was settled",
        ok: totals.streamsSettled === totals.streamsOpened,
        detail: `${totals.streamsSettled} settled of ${totals.streamsOpened} opened`,
      },
      {
        name: "every attempted call is accounted for",
        ok:
          totals.callsSucceeded + totals.callsDropped + totals.callsFailed ===
          totals.callsAttempted,
        detail:
          `${totals.callsSucceeded} succeeded + ${totals.callsDropped} dropped + ` +
          `${totals.callsFailed} failed vs ${totals.callsAttempted} attempted`,
      },
      {
        name: "no agent ended in a failed state",
        ok: totals.agentsFailed === 0,
        detail: `${totals.agentsFailed} agents failed`,
      },
      {
        name: "settled value does not exceed deposits",
        ok: totals.settledStroops <= totals.depositedStroops,
        detail: `${totals.settledStroops} settled of ${totals.depositedStroops} deposited`,
      },
    ];

    return { ok: checks.every((c) => c.ok), checks };
  }
}

/**
 * Sums every agent's ledger into run-level totals.
 *
 * `agentsFailed` counts agents that ended in `FAILED` — one that could not
 * complete its journey at all. An agent that recorded recoverable errors but
 * still opened and settled its stream is not a failure.
 *
 * @param {object[]} ledgers
 * @param {Array<{ state: string }>} [agents] - Final agent states, in ledger order.
 * @returns {object}
 */
function aggregate(ledgers, agents = []) {
  const totals = {
    agents: ledgers.length,
    agentsFailed: 0,
    streamsOpened: 0,
    streamsSettled: 0,
    callsAttempted: 0,
    callsSucceeded: 0,
    callsDropped: 0,
    callsFailed: 0,
    depositedStroops: 0,
    settledStroops: 0,
  };

  for (const ledger of ledgers) {
    totals.streamsOpened += ledger.streamsOpened;
    totals.streamsSettled += ledger.streamsSettled;
    totals.callsAttempted += ledger.callsAttempted;
    totals.callsSucceeded += ledger.callsSucceeded;
    totals.callsDropped += ledger.callsDropped;
    totals.depositedStroops += ledger.depositedStroops;
    totals.settledStroops += ledger.settledStroops;
  }

  totals.agentsFailed = agents.filter((agent) => agent.state === AgentState.FAILED).length;

  totals.callsFailed =
    totals.callsAttempted - totals.callsSucceeded - totals.callsDropped;

  return totals;
}

/** Renders "GreedyBuyer×4, FlakySeller×2" for a log line. */
function summarizeMix(agents) {
  const counts = new Map();
  for (const agent of agents) {
    counts.set(agent.strategy.name, (counts.get(agent.strategy.name) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(", ");
}

module.exports = { SwarmOrchestrator, DEFAULT_CONFIG, aggregate, summarizeMix };
