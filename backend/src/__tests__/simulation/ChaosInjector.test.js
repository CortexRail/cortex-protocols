/**
 * Unit tests for the chaos schedule and the fault sequence.
 *
 * The executor is injected, so nothing here restarts or stops anything real.
 */

const { ChaosInjector, FaultType } = require("../../simulation/ChaosInjector");

function buildInjector(overrides = {}) {
  const commands = [];
  const injector = new ChaosInjector({
    executor: async (command, args) => {
      commands.push([command, ...args].join(" "));
    },
    sleep: () => Promise.resolve(),
    seed: 4,
    ...overrides,
  });
  return { injector, commands };
}

describe("ChaosInjector", () => {
  it("restarts the backend service for a backend-restart fault", async () => {
    const { injector, commands } = buildInjector({ backendService: "cortex-backend" });
    const entry = await injector.inject(FaultType.BACKEND_RESTART);

    expect(entry).toMatchObject({ type: FaultType.BACKEND_RESTART, ok: true });
    expect(commands).toEqual(["docker compose restart cortex-backend"]);
  });

  it("stops then starts the RPC container, in that order", async () => {
    const { injector, commands } = buildInjector({ rpcContainer: "rpc-node" });
    await injector.inject(FaultType.RPC_CONTAINER_STOP);

    expect(commands).toEqual(["docker stop rpc-node", "docker start rpc-node"]);
  });

  it("records an unknown fault as a failure instead of throwing", async () => {
    const { injector } = buildInjector();
    const entry = await injector.inject("meteor-strike");

    expect(entry.ok).toBe(false);
    expect(entry.error).toMatch(/Unknown fault type/);
  });

  it("records an executor failure without throwing", async () => {
    const { injector } = buildInjector({
      executor: async () => {
        throw new Error("docker daemon is not running");
      },
    });

    const entry = await injector.inject(FaultType.BACKEND_RESTART);
    expect(entry).toMatchObject({ ok: false, error: "docker daemon is not running" });
    expect(injector.injected).toBe(1);
  });

  it("cycles through the configured fault types in order", async () => {
    const { injector, commands } = buildInjector({
      faults: [FaultType.BACKEND_RESTART, FaultType.RPC_CONTAINER_STOP],
    });

    await injector.inject(injector.faults[0]);
    await injector.inject(injector.faults[1]);

    expect(commands[0]).toContain("compose restart");
    expect(commands[1]).toContain("docker stop");
  });

  it("keeps a history the report can render", async () => {
    const { injector } = buildInjector();
    await injector.inject(FaultType.BACKEND_RESTART);
    await injector.inject(FaultType.BACKEND_RESTART);

    const json = injector.toJSON();
    expect(json.injected).toBe(2);
    expect(json.history).toHaveLength(2);
    expect(json.enabled).toBe(true);
  });

  it("injects faults on a jittered schedule until stopped", async () => {
    // The sleep has to yield to the macrotask queue: a synchronously-resolved
    // promise would starve the timer that stops the loop.
    const { injector } = buildInjector({
      intervalMs: 4,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    });

    injector.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await injector.stop();

    expect(injector.injected).toBeGreaterThan(0);
    expect(injector.running).toBe(false);
  });

  it("is idempotent on start and safe to stop when never started", async () => {
    const { injector } = buildInjector({
      intervalMs: 4,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 4))),
    });

    const first = injector.start();
    expect(injector.start()).toBe(first);
    await injector.stop();
    await expect(injector.stop()).resolves.toBeUndefined();
  });
});
