#!/usr/bin/env node

/**
 * SettlementReplayCLI — operator tool to inspect and manually replay dead-lettered settlements.
 * 
 * Usage:
 *   node scripts/replay-settlements.js list                    # List all dead-lettered settlements
 *   node scripts/replay-settlements.js inspect <id>            # Inspect a specific settlement
 *   node scripts/replay-settlements.js retry <id>               # Retry a dead-lettered settlement
 *   node scripts/replay-settlements.js discard <id> <reason>   # Discard a dead-lettered settlement
 *   node scripts/replay-settlements.js stats                    # Show dead letter queue statistics
 *   node scripts/replay-settlements.js health                   # Show settlement system health
 */

const DeadLetterQueue = require("../protocol/DeadLetterQueue");
const SettlementLedger = require("../protocol/SettlementLedger");
const SettlementReconciler = require("../protocol/SettlementReconciler");
const { withTransaction } = require("../db/connection");

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

async function main() {
  try {
    switch (command) {
      case "list":
        await listDeadLettered();
        break;
      case "inspect":
        await inspectSettlement(Number(arg1));
        break;
      case "retry":
        await retrySettlement(Number(arg1));
        break;
      case "discard":
        await discardSettlement(Number(arg1), arg2);
        break;
      case "stats":
        await showStats();
        break;
      case "health":
        await showHealth();
        break;
      case "reconcile":
        await runReconciliation();
        break;
      default:
        showUsage();
        process.exit(1);
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

function showUsage() {
  console.log(`
Settlement Replay CLI - Operator tool for settlement management

Usage:
  node scripts/replay-settlements.js list                    List all dead-lettered settlements
  node scripts/replay-settlements.js inspect <id>            Inspect a specific settlement
  node scripts/replay-settlements.js retry <id>               Retry a dead-lettered settlement
  node scripts/replay-settlements.js discard <id> <reason>   Discard a dead-lettered settlement
  node scripts/replay-settlements.js stats                    Show dead letter queue statistics
  node scripts/replay-settlements.js health                   Show settlement system health
  node scripts/replay-settlements.js reconcile                 Run a reconciliation cycle

Examples:
  node scripts/replay-settlements.js list
  node scripts/replay-settlements.js inspect 123
  node scripts/replay-settlements.js retry 123
  node scripts/replay-settlements.js discard 123 "Stream no longer exists"
  node scripts/replay-settlements.js stats
  node scripts/replay-settlements.js health
  node scripts/replay-settlements.js reconcile
`);
}

async function listDeadLettered() {
  console.log("\n=== Dead-Lettered Settlements ===\n");
  
  const settlements = await DeadLetterQueue.list({ limit: 50 });
  
  if (settlements.length === 0) {
    console.log("No dead-lettered settlements found.");
    return;
  }
  
  console.log(`Found ${settlements.length} dead-lettered settlements:\n`);
  
  for (const s of settlements) {
    const isDiscarded = s.errorMessage?.startsWith("DISCARDED:");
    console.log(`ID: ${s.id}`);
    console.log(`  Nonce: ${s.batchNonce}`);
    console.log(`  Recipient: ${s.recipient}`);
    console.log(`  Stream IDs: [${s.streamIds.join(", ")}]`);
    console.log(`  Expected Amounts: [${s.expectedAmounts.join(", ")}]`);
    console.log(`  Status: ${s.status}${isDiscarded ? " (discarded)" : ""}`);
    console.log(`  Retry Count: ${s.retryCount}`);
    console.log(`  Error: ${s.errorMessage || "None"}`);
    console.log(`  Created: ${new Date(s.createdAt).toISOString()}`);
    console.log(`  Updated: ${new Date(s.updatedAt).toISOString()}`);
    console.log("");
  }
}

async function inspectSettlement(id) {
  if (!id || isNaN(id)) {
    console.error("Invalid settlement ID");
    process.exit(1);
  }
  
  console.log(`\n=== Settlement ${id} ===\n`);
  
  const settlement = await withTransaction(async (client) => {
    const settlementRepository = require("../repositories/settlementRepository");
    return settlementRepository.findById(id, client);
  });
  
  if (!settlement) {
    console.log(`Settlement ${id} not found.`);
    return;
  }
  
  console.log(`ID: ${settlement.id}`);
  console.log(`Batch Nonce: ${settlement.batchNonce}`);
  console.log(`Recipient: ${settlement.recipient}`);
  console.log(`Stream IDs: [${settlement.streamIds.join(", ")}]`);
  console.log(`Expected Amounts: [${settlement.expectedAmounts.join(", ")}]`);
  console.log(`Status: ${settlement.status}`);
  console.log(`Retry Count: ${settlement.retryCount}`);
  console.log(`Error Message: ${settlement.errorMessage || "None"}`);
  console.log(`Created At: ${new Date(settlement.createdAt).toISOString()}`);
  console.log(`Updated At: ${new Date(settlement.updatedAt).toISOString()}`);
  console.log(`Confirmed At: ${settlement.confirmedAt ? new Date(settlement.confirmedAt).toISOString() : "Not confirmed"}`);
  console.log(`Ledger Sequence: ${settlement.ledgerSequence || "N/A"}`);
}

async function retrySettlement(id) {
  if (!id || isNaN(id)) {
    console.error("Invalid settlement ID");
    process.exit(1);
  }
  
  console.log(`\n=== Retrying Settlement ${id} ===\n`);
  
  const settlement = await DeadLetterQueue.retry(id);
  
  console.log(`Settlement ${id} has been moved from DEAD_LETTERED to FAILED status.`);
  console.log(`It will be automatically retried by the settlement processor.`);
  console.log(`\nUpdated status: ${settlement.status}`);
  console.log(`Retry count reset to: ${settlement.retryCount}`);
}

async function discardSettlement(id, reason) {
  if (!id || isNaN(id)) {
    console.error("Invalid settlement ID");
    process.exit(1);
  }
  
  if (!reason) {
    console.error("Reason is required for discarding a settlement");
    console.log("Usage: node scripts/replay-settlements.js discard <id> <reason>");
    process.exit(1);
  }
  
  console.log(`\n=== Discarding Settlement ${id} ===\n`);
  
  const settlement = await DeadLetterQueue.discard(id, reason);
  
  console.log(`Settlement ${id} has been discarded.`);
  console.log(`Reason: ${reason}`);
  console.log(`\nError message updated: ${settlement.errorMessage}`);
}

async function showStats() {
  console.log("\n=== Dead Letter Queue Statistics ===\n");
  
  const stats = await DeadLetterQueue.getStats();
  
  console.log(`Total dead-lettered: ${stats.totalCount}`);
  console.log(`Active (not discarded): ${stats.activeCount}`);
  console.log(`Discarded: ${stats.discardedCount}`);
  
  if (stats.oldestAt) {
    console.log(`Oldest: ${new Date(stats.oldestAt).toISOString()}`);
  }
  if (stats.newestAt) {
    console.log(`Newest: ${new Date(stats.newestAt).toISOString()}`);
  }
  
  console.log("");
}

async function showHealth() {
  console.log("\n=== Settlement System Health ===\n");
  
  const ledgerMetrics = await SettlementLedger.getHealthMetrics();
  const dlqStats = await DeadLetterQueue.getStats();
  
  console.log("--- Settlement Ledger ---");
  console.log(`Pending: ${ledgerMetrics.pendingCount}`);
  console.log(`Failed: ${ledgerMetrics.failedCount}`);
  console.log(`Dead-Lettered: ${ledgerMetrics.deadLetteredCount}`);
  console.log(`Confirmed: ${ledgerMetrics.confirmedCount}`);
  
  if (ledgerMetrics.oldestPendingAt) {
    const age = Date.now() - ledgerMetrics.oldestPendingAt;
    console.log(`Oldest pending age: ${Math.floor(age / 1000)}s`);
  }
  
  console.log("\n--- Dead Letter Queue ---");
  console.log(`Total: ${dlqStats.totalCount}`);
  console.log(`Active: ${dlqStats.activeCount}`);
  console.log(`Discarded: ${dlqStats.discardedCount}`);
  
  console.log("");
}

async function runReconciliation() {
  console.log("\n=== Running Reconciliation Cycle ===\n");
  
  const result = await SettlementReconciler.runReconciliation();
  
  console.log(`Streams checked: ${result.checked}`);
  console.log(`Divergences detected: ${result.divergences.length}`);
  console.log(`Divergences healed: ${result.healed}`);
  console.log(`Divergences requiring manual review: ${result.unhealed || 0}`);
  console.log(`Duration: ${result.durationMs}ms`);
  
  if (result.divergences.length > 0) {
    console.log("\n--- Divergences ---");
    for (const d of result.divergences) {
      console.log(`Stream ${d.streamId}: ${d.type}`);
      console.log(`  Off-chain: ${d.offChainWithdrawn}, On-chain: ${d.onChainWithdrawn}`);
      if (d.difference) {
        console.log(`  Difference: ${d.difference}`);
      }
    }
  }
  
  console.log("");
}

// Run the CLI
main();
