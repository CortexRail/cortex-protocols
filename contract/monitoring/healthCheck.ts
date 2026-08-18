// =============================================================================
// Cortex Protocol — Contract Health Check Monitor
// Polls each contract's view function every 60s, writes status to status.json
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  Contract,
  Keypair,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import type {
  ContractHealth,
  ContractHealthStatus,
  SystemHealthStatus,
} from "../deploy/src/types.js";

// Load env
const envPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "..", ".stellar", "deployer.env"),
];
for (const p of envPaths) {
  if (fs.existsSync(p)) dotenv.config({ path: p });
}

// ── Configuration ──────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000; // 60 seconds
const STATUS_FILE = path.resolve(process.cwd(), "status.json");
const ADDRESSES_FILE = path.resolve(process.cwd(), "..", "deployed_addresses.json");
const ALERT_THRESHOLD = 3; // consecutive failures before alert

const NETWORK = process.env["STELLAR_NETWORK"] ?? "testnet";
const RPC_URL =
  process.env["STELLAR_RPC_URL"] ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env["STELLAR_PASSPHRASE"] ?? "Test SDF Network ; September 2015";
const SECRET_KEY = process.env["STELLAR_SECRET_KEY"] ?? "";

// ── State ──────────────────────────────────────────────────────────────────────

interface ContractSpec {
  name: string;
  address: string;
  checkFn: string;
  checkArgs: unknown[];
}

let contractSpecs: ContractSpec[] = [];
const healthState: Record<string, ContractHealth> = {};
let alertingModule: { handleFailure: (health: ContractHealth) => Promise<void> } | null = null;

// ── Load Addresses ─────────────────────────────────────────────────────────────

function loadContractSpecs(): ContractSpec[] {
  if (!fs.existsSync(ADDRESSES_FILE)) {
    console.error(`[ERROR] deployed_addresses.json not found at ${ADDRESSES_FILE}`);
    process.exit(1);
  }

  const addresses = JSON.parse(fs.readFileSync(ADDRESSES_FILE, "utf-8"));
  const contracts = addresses.contracts;

  return [
    {
      name: "marketplace",
      address: contracts.marketplace.address,
      checkFn: "asset_count",
      checkArgs: [],
    },
    {
      name: "micropayments",
      address: contracts.micropayments.address,
      checkFn: "stream_count",
      checkArgs: [],
    },
    {
      name: "agent_registry",
      address: contracts.agent_registry.address,
      checkFn: "agent_count",
      checkArgs: [],
    },
  ];
}

// ── Health Check ───────────────────────────────────────────────────────────────

async function checkContractHealth(spec: ContractSpec): Promise<ContractHealth> {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const prev = healthState[spec.name];
  const previousFailures = prev?.consecutiveFailures ?? 0;

  try {
    const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

    if (!SECRET_KEY) {
      throw new Error("STELLAR_SECRET_KEY not set — cannot simulate tx");
    }

    const keypair = Keypair.fromSecret(SECRET_KEY);
    const sourceAccount = await server.getAccount(keypair.publicKey());
    const contract = new Contract(spec.address);

    // Build a read-only simulation (no submit needed)
    const operation = contract.call(spec.checkFn, ...spec.checkArgs.map((a) =>
      nativeToScVal(a)
    ));

    const tx = new TransactionBuilder(sourceAccount, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simulation = await server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation error: ${simulation.error}`);
    }

    const responseTimeMs = Date.now() - startTime;
    const status: ContractHealthStatus =
      responseTimeMs > 10_000 ? "degraded" : "healthy";

    return {
      name: spec.name,
      address: spec.address,
      status,
      lastChecked: now,
      responseTimeMs,
      consecutiveFailures: 0,
    };
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err);
    const consecutiveFailures = previousFailures + 1;

    console.error(
      `[${now}] ✗ ${spec.name} check failed (attempt ${consecutiveFailures}): ${lastError}`
    );

    return {
      name: spec.name,
      address: spec.address,
      status: consecutiveFailures >= ALERT_THRESHOLD ? "unreachable" : "degraded",
      lastChecked: now,
      responseTimeMs: null,
      consecutiveFailures,
      lastError,
    };
  }
}

// ── Write Status File ──────────────────────────────────────────────────────────

function writeStatus(statuses: Record<string, ContractHealth>): void {
  const overall = computeOverallStatus(statuses);

  const systemStatus: SystemHealthStatus = {
    network: NETWORK,
    timestamp: new Date().toISOString(),
    overall,
    contracts: statuses,
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(systemStatus, null, 2));
}

function computeOverallStatus(
  statuses: Record<string, ContractHealth>
): ContractHealthStatus {
  const values = Object.values(statuses).map((h) => h.status);
  if (values.every((s) => s === "healthy")) return "healthy";
  if (values.some((s) => s === "unreachable")) return "unreachable";
  if (values.some((s) => s === "degraded")) return "degraded";
  return "unknown";
}

// ── Load Alerting Module ───────────────────────────────────────────────────────

async function loadAlerting(): Promise<void> {
  try {
    const mod = await import("./alerting.js");
    alertingModule = mod;
    console.log("[INFO] Alerting module loaded");
  } catch {
    console.warn("[WARN] Alerting module not available");
  }
}

// ── Poll Loop ──────────────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] Running health checks...`);

  const results = await Promise.all(
    contractSpecs.map((spec) => checkContractHealth(spec))
  );

  for (const health of results) {
    const prev = healthState[health.name];
    healthState[health.name] = health;

    const icon = health.status === "healthy" ? "✓" : health.status === "degraded" ? "⚠" : "✗";
    console.log(
      `  ${icon} ${health.name.padEnd(20)} ${health.status.padEnd(12)} ` +
      `${health.responseTimeMs != null ? health.responseTimeMs + "ms" : "N/A"}`
    );

    // Trigger alert if threshold reached
    if (
      health.consecutiveFailures >= ALERT_THRESHOLD &&
      alertingModule
    ) {
      try {
        await alertingModule.handleFailure(health);
      } catch (alertErr) {
        console.error("[WARN] Alert dispatch failed:", alertErr);
      }
    }
  }

  writeStatus(healthState);
  console.log(`[${new Date().toISOString()}] Status written to ${STATUS_FILE}`);
}

// ── Start Monitor ──────────────────────────────────────────────────────────────

async function startMonitor(): Promise<void> {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   Cortex Protocol — Health Monitor           ║");
  console.log(`║   Network: ${NETWORK.padEnd(34)}║`);
  console.log(`║   Poll interval: ${String(POLL_INTERVAL_MS / 1000).padEnd(26)}s ║`);
  console.log(`║   Alert threshold: ${String(ALERT_THRESHOLD).padEnd(25)}║`);
  console.log("╚══════════════════════════════════════════════╝");

  contractSpecs = loadContractSpecs();
  await loadAlerting();

  // Initial poll immediately
  await pollOnce();

  // Then poll on interval
  setInterval(async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[ERROR] Poll iteration failed:", err);
    }
  }, POLL_INTERVAL_MS);

  console.log(`\n[INFO] Monitor running. Polling every ${POLL_INTERVAL_MS / 1000}s...`);
  console.log(`[INFO] Status file: ${STATUS_FILE}`);
  console.log("[INFO] Press Ctrl+C to stop.\n");
}

// ── Entry ──────────────────────────────────────────────────────────────────────

startMonitor().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});

export { pollOnce, checkContractHealth, writeStatus };
