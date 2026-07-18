#!/usr/bin/env node
// =============================================================================
// Cortex Protocol — CLI Entry Point
// Commands: deploy | init | verify | full
//
// Usage:
//   npm run deploy          # deploy only
//   npm run init            # init only (requires deployed_addresses.json)
//   npm run verify          # verify only (requires deployed_addresses.json)
//   npm run deploy:full     # deploy → init → verify (full pipeline)
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { DeploymentConfig, DeployedAddresses } from "./types.js";
import { Deployer } from "./deployer.js";
import { Initialiser } from "./initialiser.js";
import { Verifier } from "./verifier.js";

// Load environment variables from multiple possible locations
const envPaths = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "..", "..", "backend", ".env"),
  path.resolve(process.cwd(), "..", ".stellar", "deployer.env"),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

// ── Config Builder ─────────────────────────────────────────────────────────────

function buildConfig(): DeploymentConfig {
  const secretKey = process.env["STELLAR_SECRET_KEY"];
  if (!secretKey) {
    console.error(
      "\x1b[31mERROR: STELLAR_SECRET_KEY environment variable is not set.\x1b[0m"
    );
    console.error(
      "  Set it with: export STELLAR_SECRET_KEY=S...\n" +
      "  Or run: source contract/.stellar/deployer.env"
    );
    process.exit(1);
  }

  const network = (
    process.env["STELLAR_NETWORK"] ?? "testnet"
  ) as DeploymentConfig["network"];

  const rpcUrls: Record<string, string> = {
    testnet: "https://soroban-testnet.stellar.org",
    mainnet: "https://soroban.stellar.org",
    futurenet: "https://rpc-futurenet.stellar.org",
  };

  const passphrases: Record<string, string> = {
    testnet: "Test SDF Network ; September 2015",
    mainnet: "Public Global Stellar Network ; September 2015",
    futurenet: "Test SDF Future Network ; October 2022",
  };

  return {
    network,
    rpcUrl: process.env["STELLAR_RPC_URL"] ?? rpcUrls[network] ?? rpcUrls["testnet"]!,
    networkPassphrase:
      process.env["STELLAR_PASSPHRASE"] ??
      passphrases[network] ??
      passphrases["testnet"]!,
    secretKey,
    maxRetries: Number(process.env["MAX_RETRIES"] ?? "5"),
    retryDelayMs: Number(process.env["RETRY_DELAY_MS"] ?? "2000"),
    maxFee: Number(process.env["MAX_FEE"] ?? "1000000"),
  };
}

// ── Load Deployed Addresses ───────────────────────────────────────────────────

function loadDeployedAddresses(): DeployedAddresses {
  const possiblePaths = [
    path.resolve(process.cwd(), "deployed_addresses.json"),
    path.resolve(process.cwd(), "..", "deployed_addresses.json"),
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as DeployedAddresses;
    }
  }

  console.error(
    "\x1b[31mERROR: deployed_addresses.json not found.\x1b[0m\n" +
    "  Run 'npm run deploy' first."
  );
  process.exit(1);
}

// ── Commands ───────────────────────────────────────────────────────────────────

async function cmdDeploy(): Promise<DeployedAddresses> {
  console.log("\x1b[1m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║   Cortex Protocol — Deploy                   ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════════════╝\x1b[0m");

  const config = buildConfig();
  const deployer = new Deployer(config);
  return deployer.deployAll();
}

async function cmdInit(addresses?: DeployedAddresses): Promise<void> {
  console.log("\x1b[1m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║   Cortex Protocol — Init                     ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════════════╝\x1b[0m");

  const config = buildConfig();
  const deployer = new Deployer(config);
  const addrs = addresses ?? loadDeployedAddresses();
  const initialiser = new Initialiser(deployer, addrs);

  const results = await initialiser.run();
  const failed = results.filter((r) => !r.success);

  if (failed.length > 0) {
    console.error(`\n\x1b[31m${failed.length} initialisation step(s) failed.\x1b[0m`);
    process.exit(1);
  }
}

async function cmdVerify(addresses?: DeployedAddresses): Promise<void> {
  console.log("\x1b[1m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║   Cortex Protocol — Verify                   ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════════════╝\x1b[0m");

  const config = buildConfig();
  const deployer = new Deployer(config);
  const addrs = addresses ?? loadDeployedAddresses();
  const verifier = new Verifier(deployer, addrs);

  const report = await verifier.verify();

  // Write report to file
  const reportPath = path.resolve(process.cwd(), "..", "verification_report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, bigIntReplacer, 2));
  console.log(`\n📄 Verification report written to ${reportPath}`);

  if (!report.allPassed) {
    process.exit(1);
  }
}

async function cmdFull(): Promise<void> {
  console.log("\x1b[1m╔══════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║   Cortex Protocol — Full Pipeline            ║\x1b[0m");
  console.log("\x1b[1m║   deploy → init → verify                     ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════════════╝\x1b[0m");

  const startTime = Date.now();

  // Step 1: Deploy
  console.log("\n\x1b[1mStep 1/3: Deployment\x1b[0m");
  const addresses = await cmdDeploy();

  // Step 2: Init
  console.log("\n\x1b[1mStep 2/3: Initialisation\x1b[0m");
  await cmdInit(addresses);

  // Step 3: Verify
  console.log("\n\x1b[1mStep 3/3: Verification\x1b[0m");
  await cmdVerify(addresses);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\x1b[32m\x1b[1m✔ Full pipeline completed in ${elapsed}s\x1b[0m`);
  console.log("\n Contract Addresses:");
  console.log(`  Marketplace:    \x1b[36m${addresses.contracts.marketplace.address}\x1b[0m`);
  console.log(`  Micropayments:  \x1b[36m${addresses.contracts.micropayments.address}\x1b[0m`);
  console.log(`  Agent Registry: \x1b[36m${addresses.contracts.agent_registry.address}\x1b[0m`);
}

// ── JSON BigInt Serialiser ─────────────────────────────────────────────────────

function bigIntReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

// ── Help ───────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
\x1b[1mCortex Protocol — Deployment CLI\x1b[0m

Usage: ts-node src/index.ts <command>

Commands:
  deploy      Build and deploy all contracts to Stellar testnet
  init        Post-deploy initialisation (seeds assets & agents)
  verify      Verify on-chain state matches expected values
  full        Run the complete pipeline: deploy → init → verify

Environment variables:
  STELLAR_SECRET_KEY     Required. Deployer secret key (S...)
  STELLAR_NETWORK        Optional. testnet|mainnet|futurenet (default: testnet)
  STELLAR_RPC_URL        Optional. Override RPC endpoint
  STELLAR_PASSPHRASE     Optional. Override network passphrase
  MAX_RETRIES            Optional. Deploy retry attempts (default: 5)
  RETRY_DELAY_MS         Optional. Initial retry delay ms (default: 2000)
  MAX_FEE                Optional. Max fee in stroops (default: 1000000)

Examples:
  export STELLAR_SECRET_KEY=SXXX...
  npm run deploy:full
  npm run verify
`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";

  try {
    switch (command) {
      case "deploy":
        await cmdDeploy();
        break;
      case "init":
        await cmdInit();
        break;
      case "verify":
        await cmdVerify();
        break;
      case "full":
        await cmdFull();
        break;
      case "help":
      case "--help":
      case "-h":
        printHelp();
        break;
      default:
        console.error(`\x1b[31mUnknown command: ${command}\x1b[0m`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n\x1b[31mFatal error: ${message}\x1b[0m`);
    if (process.env["DEBUG"]) {
      console.error(err);
    }
    process.exit(1);
  }
}

main();
