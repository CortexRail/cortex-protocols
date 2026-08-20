#!/usr/bin/env node

/**
 * Fraud scan runner — the scheduled job behind the detection pipeline.
 *
 * Usage:
 *   node src/scripts/run-fraud-scan.js scan                 # scan the default window
 *   node src/scripts/run-fraud-scan.js scan --hours 48      # widen the window
 *   node src/scripts/run-fraud-scan.js scan --dry-run       # score, write nothing
 *   node src/scripts/run-fraud-scan.js stats                # current queue state
 *
 * Exit codes: 0 on a clean run, 1 on a failure, 2 when the scan completed but
 * one or more detectors errored — so a cron wrapper can alert on a partially
 * degraded scan without treating it as a total failure.
 */

require("dotenv").config();

const fraudService = require("../services/fraudService");
const { closePool } = require("../db/connection");

function parseArgs(argv) {
  const args = { command: argv[2] || "help", hours: undefined, dryRun: false };

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--hours") {
      args.hours = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--hours=")) {
      args.hours = Number(arg.split("=")[1]);
    }
  }

  return args;
}

function showUsage() {
  console.log(`
Fraud scan runner

  scan [--hours N] [--dry-run]   Run the detectors over a rolling window
  stats                          Show the current fraud queue state

Options:
  --hours N   Look back N hours instead of the configured default
  --dry-run   Score everything and print the result without writing
`);
}

function formatWindow(window) {
  return `${new Date(window.from).toISOString()} → ${new Date(window.to).toISOString()}`;
}

async function scan({ hours, dryRun }) {
  const summary = await fraudService.runScan({ lookbackHours: hours, dryRun });

  console.log(`[fraud-scan] scan ${summary.scanId}${dryRun ? " (dry run)" : ""}`);
  console.log(`[fraud-scan] window     ${formatWindow(summary.window)}`);
  console.log(
    `[fraud-scan] graph      ${summary.graph.nodes} addresses, ` +
      `${summary.graph.edges} edges, ${summary.graph.components} components`
  );

  for (const [detector, count] of Object.entries(summary.detectorCounts)) {
    console.log(`[fraud-scan]   ${detector.padEnd(13)} ${count} signal(s)`);
  }

  console.log(
    `[fraud-scan] composites ${summary.composites} ` +
      `(critical ${summary.tiers.critical}, high ${summary.tiers.high}, ` +
      `medium ${summary.tiers.medium}, low ${summary.tiers.low})`
  );

  if (!dryRun) {
    console.log(`[fraud-scan] reports    ${summary.reportsRouted} signal(s) routed into moderation`);
  } else if (summary.preview?.length) {
    console.log("\n[fraud-scan] top findings this scan would record:\n");
    for (const composite of summary.preview.slice(0, 5)) {
      console.log(composite.explanation);
      console.log("");
    }
  }

  if (summary.errors.length) {
    console.warn(`[fraud-scan] ${summary.errors.length} error(s):`);
    for (const error of summary.errors) {
      console.warn(`[fraud-scan]   ${error.detector}: ${error.message}`);
    }
  }

  console.log(`[fraud-scan] done in ${summary.durationMs}ms`);
  return summary.errors.length ? 2 : 0;
}

async function stats() {
  const result = await fraudService.getScanStats();

  console.log(`[fraud-scan] open signals: ${result.openTotal}`);
  for (const [tier, count] of Object.entries(result.openByTier)) {
    console.log(`[fraud-scan]   ${tier.padEnd(9)} ${count}`);
  }

  if (result.recent.length) {
    console.log("\n[fraud-scan] most recent:");
    for (const signal of result.recent) {
      const asset = signal.assetId === null ? "-" : signal.assetId;
      console.log(
        `[fraud-scan]   #${signal.id} ${signal.detector.padEnd(13)} ` +
          `${signal.riskTier.padEnd(9)} ${signal.score.toFixed(2)} ` +
          `agent=${signal.agentAddress} asset=${asset}`
      );
    }
  }

  return 0;
}

async function main() {
  const args = parseArgs(process.argv);

  switch (args.command) {
    case "scan":
      return scan(args);
    case "stats":
      return stats();
    default:
      showUsage();
      return args.command === "help" ? 0 : 1;
  }
}

module.exports = { parseArgs, scan, stats, main };

// ── CLI entrypoint ────────────────────────────────────────────────────────────
// Guarded so the backtest harness can require this module without triggering a
// scan (and without closing the pool out from under the test run).
if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error("[fraud-scan] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
