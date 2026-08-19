/**
 * The PR-time smoke variant: a short 5-agent swarm run end to end.
 *
 * It drives the real orchestrator, agents, strategies and metrics against the
 * in-memory transport, so an obvious regression in the discover → quote →
 * stream → meter → settle loop is caught cheaply on every pull request. The
 * nightly job runs the same code against a real local network.
 */

const { SwarmOrchestrator, aggregate, summarizeMix } = require("../../simulation/SwarmOrchestrator");
const { FakeProtocolTransport } = require("../../simulation/FakeProtocolTransport");

/** No real waiting: agent delays resolve immediately. */
const noSleep = () => Promise.resolve();

function buildSwarm(config = {}, transportOptions = {}) {
  const transport = new FakeProtocolTransport({ seed: 7, ...transportOptions });
  const orchestrator = new SwarmOrchestrator({
    clientFactory: () => transport,
    config: { agentCount: 5, durationMs: 0, seed: 99, ...config },
    sleep: noSleep,
  });
  return { orchestrator, transport };
}

describe("SwarmOrchestrator", () => {
  it("rejects a missing client factory", () => {
    expect(() => new SwarmOrchestrator({})).toThrow(/clientFactory/);
  });

  it("spawns exactly the configured number of agents", () => {
    const { orchestrator } = buildSwarm({ agentCount: 12 });
    expect(orchestrator.spawn()).toHaveLength(12);
  });

  it("spawns agents across the configured strategy mix", () => {
    const { orchestrator } = buildSwarm({
      agentCount: 20,
      mix: { GreedyBuyer: 1, HighVolumeCaller: 1 },
    });
    const names = new Set(orchestrator.spawn().map((a) => a.strategy.name));
    expect(names).toEqual(new Set(["GreedyBuyer", "HighVolumeCaller"]));
  });

  it("runs a 5-agent swarm through the full protocol loop", async () => {
    const { orchestrator, transport } = buildSwarm();
    const result = await orchestrator.run();

    expect(result.totals.agents).toBe(5);
    expect(result.totals.streamsOpened).toBe(5);
    expect(result.totals.callsSucceeded).toBeGreaterThan(0);
    expect(transport.callCount).toBe(result.totals.callsSucceeded);
  });

  it("settles every stream it opened", async () => {
    const { orchestrator, transport } = buildSwarm();
    const result = await orchestrator.run();

    expect(result.totals.streamsSettled).toBe(result.totals.streamsOpened);
    expect(transport.openStreams).toHaveLength(0);
  });

  it("reconciles the final state", async () => {
    const { orchestrator } = buildSwarm();
    const result = await orchestrator.run();

    expect(result.reconciliation.ok).toBe(true);
    for (const check of result.reconciliation.checks) {
      expect(check).toMatchObject({ ok: true });
    }
  });

  it("records latency for every protocol operation", async () => {
    const { orchestrator } = buildSwarm();
    const result = await orchestrator.run();

    for (const op of ["handshake", "quote", "streamOpen", "meteredCall", "settlement"]) {
      expect(result.metrics.operations[op].count).toBeGreaterThan(0);
    }
  });

  it("is deterministic for a given seed", async () => {
    const first = await buildSwarm({ seed: 1234 }).orchestrator.run();
    const second = await buildSwarm({ seed: 1234 }).orchestrator.run();

    expect(second.totals).toEqual(first.totals);
    expect(second.agents.map((a) => a.strategy)).toEqual(first.agents.map((a) => a.strategy));
  });

  it("still reaches a consistent final state when the transport is failing", async () => {
    const { orchestrator, transport } = buildSwarm({}, { failureRate: 0.4 });
    const result = await orchestrator.run();

    // Errors are expected and recorded, but no stream may be left open.
    expect(result.metrics.totalErrors).toBeGreaterThan(0);
    expect(transport.openStreams).toHaveLength(0);
    expect(result.totals.streamsSettled).toBe(result.totals.streamsOpened);
    expect(result.reconciliation.ok).toBe(true);
  });

  it("survives an agent whose client throws on every call", async () => {
    const orchestrator = new SwarmOrchestrator({
      clientFactory: () => ({
        discover: async () => {
          throw new Error("backend down");
        },
      }),
      config: { agentCount: 3, durationMs: 0, seed: 5 },
      sleep: noSleep,
    });

    const result = await orchestrator.run();
    expect(result.totals.agents).toBe(3);
    expect(result.totals.agentsFailed).toBe(3);
    expect(result.metrics.totalErrors).toBeGreaterThan(0);
    // A swarm where every agent failed must not reconcile clean.
    expect(result.reconciliation.ok).toBe(false);
  });

  it("winds every agent down when the duration budget expires", async () => {
    const { orchestrator } = buildSwarm({ agentCount: 3, durationMs: 1 });
    // Real timers here: the deadline has to actually fire.
    const result = await new SwarmOrchestrator({
      clientFactory: orchestrator.clientFactory,
      config: { agentCount: 3, durationMs: 1, seed: 3 },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    }).run();

    expect(result.totals.streamsSettled).toBe(result.totals.streamsOpened);
  });

  it("stops early when asked to", async () => {
    const { orchestrator } = buildSwarm({ agentCount: 2 });
    orchestrator.spawn();
    orchestrator.stopAll();

    const result = await orchestrator.run();
    expect(result.totals.callsSucceeded).toBe(0);
    expect(result.totals.streamsSettled).toBe(result.totals.streamsOpened);
  });
});

describe("aggregate", () => {
  const ledger = {
    streamsOpened: 1, streamsSettled: 1, callsAttempted: 10, callsSucceeded: 6,
    callsDropped: 2, depositedStroops: 100, settledStroops: 60, errors: [],
  };

  it("derives failed calls from what is left over", () => {
    expect(aggregate([ledger]).callsFailed).toBe(2);
  });

  it("counts only agents that ended in a failed state", () => {
    const totals = aggregate([ledger, ledger, ledger], [
      { state: "done" },
      { state: "failed" },
      { state: "done" },
    ]);
    expect(totals.agentsFailed).toBe(1);
  });

  it("does not count recoverable errors as a failed agent", () => {
    const noisy = { ...ledger, errors: ["call: timeout", "call: timeout"] };
    expect(aggregate([noisy], [{ state: "done" }]).agentsFailed).toBe(0);
  });

  it("handles an empty swarm", () => {
    expect(aggregate([])).toMatchObject({ agents: 0, streamsOpened: 0, callsFailed: 0, agentsFailed: 0 });
  });
});

describe("summarizeMix", () => {
  it("renders the strategy histogram", () => {
    const summary = summarizeMix([
      { strategy: { name: "GreedyBuyer" } },
      { strategy: { name: "GreedyBuyer" } },
      { strategy: { name: "FlakySeller" } },
    ]);
    expect(summary).toBe("GreedyBuyer×2, FlakySeller×1");
  });
});
