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
    logger.error("Error:", err.message);
    process.exit(1);
  }
}

function showUsage() {
  logger.info(`
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
  logger.info("\n=== Dead-Lettered Settlements ===\n");
  
  const settlements = await DeadLetterQueue.list({ limit: 50 });
  
  if (settlements.length === 0) {
    logger.info("No dead-lettered settlements found.");
    return;
  }
  
  logger.info(`Found ${settlements.length} dead-lettered settlements:\n`);
  
  for (const s of settlements) {
    const isDiscarded = s.errorMessage?.startsWith("DISCARDED:");
    logger.info(`ID: ${s.id}`);
    logger.info(`  Nonce: ${s.batchNonce}`);
    logger.info(`  Recipient: ${s.recipient}`);
    logger.info(`  Stream IDs: [${s.streamIds.join(", ")}]`);
    logger.info(`  Expected Amounts: [${s.expectedAmounts.join(", ")}]`);
    logger.info(`  Status: ${s.status}${isDiscarded ? " (discarded)" : ""}`);
    logger.info(`  Retry Count: ${s.retryCount}`);
    logger.info(`  Error: ${s.errorMessage || "None"}`);
    logger.info(`  Created: ${new Date(s.createdAt).toISOString()}`);
    logger.info(`  Updated: ${new Date(s.updatedAt).toISOString()}`);
    logger.info("");
  }
}

async function inspectSettlement(id) {
  if (!id || isNaN(id)) {
    logger.error("Invalid settlement ID");
    process.exit(1);
  }
  
  logger.info(`\n=== Settlement ${id} ===\n`);
  
  const settlement = await withTransaction(async (client) => {
    const settlementRepository = require("../repositories/settlementRepository");
const { logger } = require("../utils/logger");
    return settlementRepository.findById(id, client);
  });
  
  if (!settlement) {
    logger.info(`Settlement ${id} not found.`);
    return;
  }
  
  logger.info(`ID: ${settlement.id}`);
  logger.info(`Batch Nonce: ${settlement.batchNonce}`);
  logger.info(`Recipient: ${settlement.recipient}`);
  logger.info(`Stream IDs: [${settlement.streamIds.join(", ")}]`);
  logger.info(`Expected Amounts: [${settlement.expectedAmounts.join(", ")}]`);
  logger.info(`Status: ${settlement.status}`);
  logger.info(`Retry Count: ${settlement.retryCount}`);
  logger.info(`Error Message: ${settlement.errorMessage || "None"}`);
  logger.info(`Created At: ${new Date(settlement.createdAt).toISOString()}`);
  logger.info(`Updated At: ${new Date(settlement.updatedAt).toISOString()}`);
  logger.info(`Confirmed At: ${settlement.confirmedAt ? new Date(settlement.confirmedAt).toISOString() : "Not confirmed"}`);
  logger.info(`Ledger Sequence: ${settlement.ledgerSequence || "N/A"}`);
}

async function retrySettlement(id) {
  if (!id || isNaN(id)) {
    logger.error("Invalid settlement ID");
    process.exit(1);
  }
  
  logger.info(`\n=== Retrying Settlement ${id} ===\n`);
  
  const settlement = await DeadLetterQueue.retry(id);
  
  logger.info(`Settlement ${id} has been moved from DEAD_LETTERED to FAILED status.`);
  logger.info(`It will be automatically retried by the settlement processor.`);
  logger.info(`\nUpdated status: ${settlement.status}`);
  logger.info(`Retry count reset to: ${settlement.retryCount}`);
}

async function discardSettlement(id, reason) {
  if (!id || isNaN(id)) {
    logger.error("Invalid settlement ID");
    process.exit(1);
  }
  
  if (!reason) {
    logger.error("Reason is required for discarding a settlement");
    logger.info("Usage: node scripts/replay-settlements.js discard <id> <reason>");
    process.exit(1);
  }
  
  logger.info(`\n=== Discarding Settlement ${id} ===\n`);
  
  const settlement = await DeadLetterQueue.discard(id, reason);
  
  logger.info(`Settlement ${id} has been discarded.`);
  logger.info(`Reason: ${reason}`);
  logger.info(`\nError message updated: ${settlement.errorMessage}`);
}

async function showStats() {
  logger.info("\n=== Dead Letter Queue Statistics ===\n");
  
  const stats = await DeadLetterQueue.getStats();
  
  logger.info(`Total dead-lettered: ${stats.totalCount}`);
  logger.info(`Active (not discarded): ${stats.activeCount}`);
  logger.info(`Discarded: ${stats.discardedCount}`);
  
  if (stats.oldestAt) {
    logger.info(`Oldest: ${new Date(stats.oldestAt).toISOString()}`);
  }
  if (stats.newestAt) {
    logger.info(`Newest: ${new Date(stats.newestAt).toISOString()}`);
  }
  
  logger.info("");
}

async function showHealth() {
  logger.info("\n=== Settlement System Health ===\n");
  
  const ledgerMetrics = await SettlementLedger.getHealthMetrics();
  const dlqStats = await DeadLetterQueue.getStats();
  
  logger.info("--- Settlement Ledger ---");
  logger.info(`Pending: ${ledgerMetrics.pendingCount}`);
  logger.info(`Failed: ${ledgerMetrics.failedCount}`);
  logger.info(`Dead-Lettered: ${ledgerMetrics.deadLetteredCount}`);
  logger.info(`Confirmed: ${ledgerMetrics.confirmedCount}`);
  
  if (ledgerMetrics.oldestPendingAt) {
    const age = Date.now() - ledgerMetrics.oldestPendingAt;
    logger.info(`Oldest pending age: ${Math.floor(age / 1000)}s`);
  }
  
  logger.info("\n--- Dead Letter Queue ---");
  logger.info(`Total: ${dlqStats.totalCount}`);
  logger.info(`Active: ${dlqStats.activeCount}`);
  logger.info(`Discarded: ${dlqStats.discardedCount}`);
  
  logger.info("");
}

async function runReconciliation() {
  logger.info("\n=== Running Reconciliation Cycle ===\n");
  
  const result = await SettlementReconciler.runReconciliation();
  
  logger.info(`Streams checked: ${result.checked}`);
  logger.info(`Divergences detected: ${result.divergences.length}`);
  logger.info(`Divergences healed: ${result.healed}`);
  logger.info(`Divergences requiring manual review: ${result.unhealed || 0}`);
  logger.info(`Duration: ${result.durationMs}ms`);
  
  if (result.divergences.length > 0) {
    logger.info("\n--- Divergences ---");
    for (const d of result.divergences) {
      logger.info(`Stream ${d.streamId}: ${d.type}`);
      logger.info(`  Off-chain: ${d.offChainWithdrawn}, On-chain: ${d.onChainWithdrawn}`);
      if (d.difference) {
        logger.info(`  Difference: ${d.difference}`);
      }
    }
  }
  
  logger.info("");
}

// Run the CLI
main();
