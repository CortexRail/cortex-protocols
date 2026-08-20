/**
 * Injects failures into a running simulation.
 *
 * A swarm that only ever sees a healthy backend proves very little. This kills
 * and restarts the backend process mid-run, or stops and starts the local
 * network's RPC container, so the run also answers "do all agents still reach a
 * consistent final state after the thing they were talking to went away?".
 *
 * Everything that touches the outside world goes through the injected
 * `executor`, so the schedule and the fault sequence are unit-testable without
 * killing anything.
 */

const { deriveRng, intBetween } = require("./rng");

/** The faults this injector knows how to cause. */
const FaultType = {
  BACKEND_RESTART: "backend-restart",
  RPC_CONTAINER_STOP: "rpc-container-stop",
};

/** Default executor: shells out for real. Replaced wholesale in tests. */
function defaultExecutor(command, args) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))
    );
  });
}

class ChaosInjector {
  /**
   * @param {object} options
   * @param {string[]} [options.faults] - Fault types to cycle through.
   * @param {number} [options.intervalMs] - Mean gap between faults.
   * @param {number} [options.downtimeMs] - How long a killed dependency stays down.
   * @param {number} [options.seed]
   * @param {string} [options.rpcContainer] - Docker container name for the RPC node.
   * @param {string} [options.backendService] - Compose service name for the backend.
   * @param {(command: string, args: string[]) => Promise<void>} [options.executor]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {(msg: string) => void} [options.log]
   */
  constructor({
    faults = [FaultType.BACKEND_RESTART],
    intervalMs = 30_000,
    downtimeMs = 5_000,
    seed = 1,
    rpcContainer = "cortex-soroban-rpc",
    backendService = "cortex-backend",
    executor = defaultExecutor,
    sleep,
    log = () => {},
  } = {}) {
    this.faults = faults;
    this.intervalMs = intervalMs;
    this.downtimeMs = downtimeMs;
    this.rng = deriveRng(seed, 9973);
    this.rpcContainer = rpcContainer;
    this.backendService = backendService;
    this.executor = executor;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = log;

    this.running = false;
    /** @type {Array<{ type: string, at: number, ok: boolean, error?: string }>} */
    this.history = [];
    this.loopPromise = null;
  }

  /** Faults injected so far, in order. */
  get injected() {
    return this.history.length;
  }

  /** Starts the injection loop. Returns immediately. */
  start(now = Date.now()) {
    if (this.running) return this.loopPromise;
    this.running = true;
    this.startedAt = now;
    this.loopPromise = this.loop();
    return this.loopPromise;
  }

  /** Stops the loop and waits for any in-flight fault to finish. */
  async stop() {
    this.running = false;
    if (this.loopPromise) await this.loopPromise;
    this.loopPromise = null;
  }

  /** The injection loop: wait a jittered interval, cause one fault, repeat. */
  async loop() {
    while (this.running) {
      // Jitter by ±50% so faults never land on the same phase of the swarm.
      const wait = intBetween(this.rng, this.intervalMs / 2, this.intervalMs * 1.5);
      await this.sleep(Math.round(wait));
      if (!this.running) break;

      const fault = this.faults[this.history.length % this.faults.length];
      await this.inject(fault);
    }
  }

  /**
   * Causes one fault and records the outcome.
   *
   * Never throws: chaos that cannot be caused is a note in the report, not a
   * reason to fail the run the injector was supposed to be stressing.
   *
   * @param {string} type
   * @returns {Promise<{ type: string, ok: boolean, error?: string }>}
   */
  async inject(type) {
    const entry = { type, at: Date.now(), ok: true };
    this.log(`injecting ${type}`);

    try {
      switch (type) {
        case FaultType.BACKEND_RESTART:
          await this.executor("docker", ["compose", "restart", this.backendService]);
          break;
        case FaultType.RPC_CONTAINER_STOP:
          await this.executor("docker", ["stop", this.rpcContainer]);
          await this.sleep(this.downtimeMs);
          await this.executor("docker", ["start", this.rpcContainer]);
          break;
        default:
          throw new Error(`Unknown fault type "${type}"`);
      }
    } catch (err) {
      entry.ok = false;
      entry.error = err?.message ?? String(err);
      this.log(`fault ${type} failed: ${entry.error}`);
    }

    this.history.push(entry);
    return entry;
  }

  /** The fault log, for the report's chaos section. */
  toJSON() {
    return {
      enabled: this.faults.length > 0,
      faults: this.faults,
      intervalMs: this.intervalMs,
      injected: this.injected,
      history: this.history,
    };
  }
}

module.exports = { ChaosInjector, FaultType, defaultExecutor };
