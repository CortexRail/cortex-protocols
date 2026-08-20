#!/usr/bin/env node

/**
 * Simulation entry point — the single command behind `npm run simulate`.
 *
 * Boots a local Soroban network, deploys every contract, runs a swarm of
 * synthetic agents against the real backend and SDK, and writes an HTML report.
 * Each stage can be skipped so the same script covers the nightly full run, a
 * quick local check, and the short smoke variant CI runs on every PR.
 *
 * Usage:
 *   npm run simulate                                  # full local run
 *   npm run simulate -- --agents 50 --duration 600    # nightly shape
 *   npm run simulate -- --smoke                       # 5 agents, 2 minutes
 *   npm run simulate -- --mock                        # no network, no deploy
 *   npm run simulate -- --chaos                       # restart the backend mid-run
 *
 * Exit code is non-zero when the error rate exceeds --max-error-rate or the
 * final-state reconciliation fails, which is what makes it usable as a CI gate.
 */

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { SwarmOrchestrator } = require("./SwarmOrchestrator");
const { ChaosInjector, FaultType } = require("./ChaosInjector");
const { FakeProtocolTransport } = require("./FakeProtocolTransport");
const { generateReport } = require("./report-generator");

const CONTRACT_SCRIPTS = path.resolve(__dirname, "../../../contract/scripts");
const DEFAULT_OUTPUT = path.resolve(__dirname, "../../../simulation-report.html");
const ADDRESSES_FILE = path.resolve(
  __dirname,
  "../../../contract/deployed-addresses.local.json"
);

/**
 * Parses argv into options.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const options = {
    agents: 10,
    durationSecs: 60,
    seed: Number(process.env.SIMULATION_SEED) || 1,
    smoke: false,
    mock: false,
    chaos: false,
    skipNetwork: false,
    skipDeploy: false,
    maxErrorRate: 0.05,
    output: DEFAULT_OUTPUT,
    backendUrl: process.env.SIMULATION_BACKEND_URL || "http://localhost:4000",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];

    switch (arg) {
      case "--agents": options.agents = Number(next()); break;
      case "--duration": options.durationSecs = Number(next()); break;
      case "--seed": options.seed = Number(next()); break;
      case "--max-error-rate": options.maxErrorRate = Number(next()); break;
      case "--output": options.output = path.resolve(next()); break;
      case "--backend-url": options.backendUrl = next(); break;
      case "--smoke": options.smoke = true; break;
      case "--mock": options.mock = true; break;
      case "--chaos": options.chaos = true; break;
      case "--skip-network": options.skipNetwork = true; break;
      case "--skip-deploy": options.skipDeploy = true; break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown flag ${arg}`);
    }
  }

  if (options.smoke) {
    // The PR-time variant: small enough to be cheap, long enough to catch an
    // obvious regression in the loop.
    options.agents = Math.min(options.agents, 5);
    options.durationSecs = Math.min(options.durationSecs, 120);
  }

  return options;
}

/** Runs a shell script, streaming its output, and resolves on exit code 0. */
function runScript(script, args = [], log = console.info) {
  return new Promise((resolve, reject) => {
    log(`[simulate] running ${script} ${args.join(" ")}`);
    const child = spawn("bash", [path.join(CONTRACT_SCRIPTS, script), ...args], {
      stdio: "inherit",
      cwd: CONTRACT_SCRIPTS,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))
    );
  });
}

/**
 * Builds the factory that gives each agent its SDK client.
 *
 * In `--mock` mode every agent shares one in-memory transport, so the whole
 * loop runs with no network at all. Otherwise each agent gets a real
 * `CortexAgentSDK` bound to its own funded keypair.
 *
 * @param {object} options
 * @returns {(index: number) => object}
 */
function buildClientFactory(options) {
  if (options.mock) {
    const transport = new FakeProtocolTransport({ seed: options.seed });
    return () => transport;
  }

  // Required lazily: pulling in the Stellar SDK is slow and pointless in mock mode.
  const { Keypair } = require("@stellar/stellar-sdk");
  const CortexAgentSDK = require("../sdk/CortexAgentSDK");

  const addresses = fs.existsSync(ADDRESSES_FILE)
    ? JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf8"))
    : {};

  return (index) =>
    new CortexAgentSDK({
      backendUrl: options.backendUrl,
      rpcUrl: process.env.SOROBAN_RPC_URL || "http://localhost:8000/soroban/rpc",
      horizonUrl: process.env.HORIZON_URL || "http://localhost:8000",
      networkPassphrase:
        process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
      micropaymentsContractId: addresses?.contracts?.micropayments?.address,
      buyerKeypair: Keypair.fromRawEd25519Seed(seedBufferFor(options.seed, index)),
    });
}

/**
 * Derives a deterministic 32-byte ed25519 seed for agent `index`.
 *
 * Reproducible keypairs mean a failing nightly run can be replayed against the
 * same accounts.
 */
function seedBufferFor(seed, index) {
  const crypto = require("node:crypto");
  return crypto
    .createHash("sha256")
    .update(`cortex-simulation:${seed}:${index}`)
    .digest();
}

/**
 * Runs the whole simulation.
 *
 * @param {object} options
 * @param {{ log?: (msg: string) => void, script?: typeof runScript }} [deps]
 * @returns {Promise<{ run: object, reportPath: string, passed: boolean, failures: string[] }>}
 */
async function simulate(options, deps = {}) {
  const log = deps.log ?? console.info;
  const script = deps.script ?? runScript;

  if (!options.mock && !options.skipNetwork) {
    await script("start-local-network.sh", [], log);
  }
  if (!options.mock && !options.skipDeploy) {
    await script("deploy-all.sh", [], log);
  }

  const orchestrator = new SwarmOrchestrator({
    clientFactory: buildClientFactory(options),
    config: {
      agentCount: options.agents,
      durationMs: options.durationSecs * 1000,
      seed: options.seed,
    },
    log: (msg) => log(`[swarm] ${msg}`),
  });

  let chaos = null;
  if (options.chaos) {
    chaos = new ChaosInjector({
      faults: [FaultType.BACKEND_RESTART, FaultType.RPC_CONTAINER_STOP],
      intervalMs: Math.max(10_000, (options.durationSecs * 1000) / 3),
      seed: options.seed,
      log: (msg) => log(`[chaos] ${msg}`),
    });
    chaos.start();
  }

  const run = await orchestrator.run();
  if (chaos) await chaos.stop();

  const html = generateReport(run, { chaos: chaos?.toJSON() });
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, html, "utf8");
  log(`[simulate] report written to ${options.output}`);

  const failures = [];
  if (run.metrics.errorRate > options.maxErrorRate) {
    failures.push(
      `error rate ${(run.metrics.errorRate * 100).toFixed(2)}% exceeds the ` +
        `${(options.maxErrorRate * 100).toFixed(2)}% threshold`
    );
  }
  if (!run.reconciliation.ok) {
    const failed = run.reconciliation.checks.filter((c) => !c.ok);
    failures.push(
      `reconciliation failed: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`
    );
  }

  return { run, reportPath: options.output, passed: failures.length === 0, failures };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.info(
    `[simulate] ${options.agents} agents for ${options.durationSecs}s ` +
      `(seed ${options.seed}${options.mock ? ", mock transport" : ""})`
  );

  const { passed, failures } = await simulate(options);

  if (!passed) {
    console.error("[simulate] FAILED");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  console.info("[simulate] PASSED — error rate within budget and state reconciled");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[simulate] fatal:", err?.message ?? err);
    process.exitCode = 1;
  });
}

module.exports = { simulate, parseArgs, buildClientFactory, seedBufferFor };
