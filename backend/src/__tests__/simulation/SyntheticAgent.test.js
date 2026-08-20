/**
 * Unit tests for one agent's journey through the protocol loop.
 */

const { SyntheticAgent, AgentState, normalizeAssets } = require("../../simulation/SyntheticAgent");
const { SimulationMetrics } = require("../../simulation/SimulationMetrics");
const { FakeProtocolTransport } = require("../../simulation/FakeProtocolTransport");
const { GreedyBuyer, LoyalBuyer, HighVolumeCaller } = require("../../simulation/strategies");

const noSleep = () => Promise.resolve();

function buildAgent(overrides = {}) {
  const metrics = new SimulationMetrics();
  const client = overrides.client ?? new FakeProtocolTransport({ seed: 3 });
  const agent = new SyntheticAgent({
    id: "agent-test",
    strategy: GreedyBuyer,
    client,
    metrics,
    seed: 11,
    sleep: noSleep,
    ...overrides,
  });
  return { agent, metrics, client };
}

describe("normalizeAssets", () => {
  it("accepts a bare array", () => {
    expect(normalizeAssets([{ id: 1, price: 10, owner: "A" }])).toEqual([
      { id: 1, price: 10, owner: "A" },
    ]);
  });

  it("accepts the wrapped { data } shape the API returns", () => {
    expect(normalizeAssets({ data: [{ id: 2, pricePerCall: 5, owner: "B" }] })).toEqual([
      { id: 2, price: 5, owner: "B" },
    ]);
  });

  it("falls back to a zero price and an unknown owner", () => {
    expect(normalizeAssets([{ id: 3 }])).toEqual([{ id: 3, price: 0, owner: "unknown" }]);
  });

  it("drops entries with no id and non-array payloads", () => {
    expect(normalizeAssets([{ price: 1 }])).toEqual([]);
    expect(normalizeAssets(null)).toEqual([]);
    expect(normalizeAssets({ data: "nope" })).toEqual([]);
  });
});

describe("SyntheticAgent", () => {
  it("requires an id, a client and a metrics collector", () => {
    expect(() => new SyntheticAgent({})).toThrow(/id/);
    expect(() => new SyntheticAgent({ id: "a" })).toThrow(/client/);
    expect(() => new SyntheticAgent({ id: "a", client: {} })).toThrow(/metrics/);
  });

  it("resolves a strategy passed by name", () => {
    const { agent } = buildAgent({ strategy: "LoyalBuyer" });
    expect(agent.strategy).toBe(LoyalBuyer);
  });

  it("runs the full journey and ends done", async () => {
    const { agent } = buildAgent();
    const ledger = await agent.run();

    expect(agent.state).toBe(AgentState.DONE);
    expect(ledger.streamsOpened).toBe(1);
    expect(ledger.streamsSettled).toBe(1);
    expect(ledger.callsSucceeded).toBeGreaterThan(0);
  });

  it("remembers the sellers it has bought from", async () => {
    const { agent } = buildAgent();
    await agent.run();
    expect(agent.memory.sellersUsed.size).toBe(1);
  });

  it("stops calling once the stream is spent", async () => {
    // A large budget against a small deposit forces the 402 path.
    const { agent } = buildAgent({ strategy: { ...HighVolumeCaller, depositXlm: () => 0.00005 } });
    const ledger = await agent.run();

    expect(ledger.callsAttempted).toBeLessThan(HighVolumeCaller.maxCalls());
    expect(ledger.streamsSettled).toBe(1);
  });

  it("records a dropped call without counting it as a success", async () => {
    const alwaysDrops = { ...GreedyBuyer, shouldDropCall: () => true, maxCalls: () => 4 };
    const { agent, metrics } = buildAgent({ strategy: alwaysDrops });
    const ledger = await agent.run();

    expect(ledger.callsAttempted).toBe(4);
    expect(ledger.callsDropped).toBe(4);
    expect(ledger.callsSucceeded).toBe(0);
    expect(metrics.summarize("meteredCall").errors).toBe(4);
  });

  it("still settles its stream after dropping every call", async () => {
    const alwaysDrops = { ...GreedyBuyer, shouldDropCall: () => true, maxCalls: () => 3 };
    const { agent, client } = buildAgent({ strategy: alwaysDrops });
    await agent.run();

    expect(client.openStreams).toHaveLength(0);
  });

  it("ends in FAILED, not thrown, when the stream cannot be opened", async () => {
    const client = new FakeProtocolTransport();
    client.openStream = async () => {
      throw new Error("rpc unavailable");
    };

    const { agent } = buildAgent({ client });
    const ledger = await agent.run();

    expect(agent.state).toBe(AgentState.FAILED);
    expect(ledger.errors.join(" ")).toMatch(/rpc unavailable/);
  });

  it("finishes cleanly when discovery returns nothing to buy", async () => {
    const client = new FakeProtocolTransport({ assets: [] });
    const { agent } = buildAgent({ client });
    const ledger = await agent.run();

    expect(agent.state).toBe(AgentState.DONE);
    expect(ledger.streamsOpened).toBe(0);
  });

  it("stops mid-run when asked to", async () => {
    const { agent } = buildAgent({ strategy: { ...GreedyBuyer, maxCalls: () => 500 } });
    const originalCall = agent.client.call.bind(agent.client);
    let calls = 0;
    agent.client.call = async (...args) => {
      if (++calls === 3) agent.stop();
      return originalCall(...args);
    };

    const ledger = await agent.run();
    expect(ledger.callsAttempted).toBe(3);
    expect(ledger.streamsSettled).toBe(1);
  });
});
