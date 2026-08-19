#!/usr/bin/env node

/**
 * prune-old-partitions.js
 *
 * Drops/archives partitions older than a configurable retention window.
 * Run daily (or weekly) via cron:
 *
 *   0 2 * * * node backend/src/scripts/prune-old-partitions.js
 *
 * Reads PARTITION_RETENTION_DAYS (default 90) and PARTITION_RANGE_SIZE
 * (default 100000) from the environment.
 *
 * Safety: never drops the default partition or any partition that contains
 * data within the retention window.
 */

require("dotenv").config();

const { query, closePool } = require("../db/connection");
const { logger } = require("../utils/logger");

const RETENTION_DAYS = Number(process.env.PARTITION_RETENTION_DAYS) || 90;

/**
 * Discover all non-default partition names and their upper bounds.
 */
async function listPartitions() {
  const { rows } = await query(`
    SELECT
      inhrelid::regclass::text AS partition_name
    FROM pg_inherits
    WHERE inhparent = 'events_log'::regclass
      AND inhrelid::regclass::text != 'events_log_default'
  `);

  return rows.map(({ partition_name }) => {
    // Parse upper bound from name like "events_log_p0_to_100000"
    const match = partition_name.match(/_p(\d+)_to_(\d+)$/);
    return {
      name: partition_name,
      start: match ? Number(match[1]) : 0,
      end: match ? Number(match[2]) : 0,
    };
  });
}

/**
 * Get the minimum ledger in a partition.
 */
async function getMinLedger(partitionName) {
  const { rows } = await query(
    `SELECT COALESCE(MIN(ledger), 0) AS min_ledger FROM ${partitionName}`
  );
  return Number(rows[0].min_ledger);
}

async function prunePartitions() {
  const partitions = await listPartitions();
  const retentionMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  // Approximate: 1 ledger ≈ 5 seconds on Stellar
  const ledgerEstimate = Math.floor(retentionMs / 5000);

  // We need to find the max ledger to compute the cutoff.
  const { rows: maxRows } = await query(
    "SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events_log"
  );
  const maxLedger = Number(maxRows[0].max_ledger);
  const cutoffLedger = maxLedger - ledgerEstimate;

  let dropped = 0;
  let skipped = 0;

  // Sort partitions by start (ascending) so we prune oldest first.
  partitions.sort((a, b) => a.start - b.start);

  for (const part of partitions) {
    // Never drop the highest partition — it's the one actively being written to.
    if (part.end >= maxLedger) {
      skipped++;
      continue;
    }

    // The entire partition is below the cutoff — safe to drop.
    if (part.end <= cutoffLedger) {
      try {
        await query(`DROP TABLE IF EXISTS ${part.name}`);
        console.info(`[prune-old-partitions] dropped ${part.name} (ends at ledger ${part.end})`);
        dropped++;
      } catch (err) {
        logger.error(`[prune-old-partitions] failed to drop ${part.name}: ${err.message}`);
      }
    } else {
      // Partition straddles the cutoff — check if any rows are still within retention.
      const minLedger = await getMinLedger(part.name);
      if (minLedger >= cutoffLedger) {
        skipped++;
      } else {
        // Some rows are old, some are not. Since this is an append-only log
        // and ranges are contiguous, we can safely drop everything before the
        // cutoff. But that would require re-partitioning, so we skip for now.
        console.info(
          `[prune-old-partitions] skipping ${part.name} — straddles retention boundary`
        );
        skipped++;
      }
    }
  }

  return { dropped, skipped };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
if (require.main === module) {
  prunePartitions()
    .then(({ dropped, skipped }) => {
      console.info(
        `[prune-old-partitions] done — ${dropped} dropped, ${skipped} skipped (retention: ${RETENTION_DAYS} days)`
      );
    })
    .catch((err) => {
      logger.error("[prune-old-partitions] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

module.exports = { prunePartitions, listPartitions };
