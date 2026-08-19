#!/usr/bin/env node

/**
 * create-future-partitions.js
 *
 * Cron-friendly script that pre-creates upcoming ledger-range partitions for
 * the `events_log` table so ingestion never blocks on DDL. Run this daily
 * (or every few hours) via cron:
 *
 *   0 0,6,12,18 * * * node backend/src/scripts/create-future-partitions.js
 *
 * Reads PARTITION_RANGE_SIZE (default 100000) and PARTITIONS_AHEAD (default 5)
 * from the environment.
 */

require("dotenv").config();

const { query, closePool } = require("../db/connection");
const { logger } = require("../utils/logger");

const RANGE_SIZE = Number(process.env.PARTITION_RANGE_SIZE) || 100_000;
const PARTITIONS_AHEAD = Number(process.env.PARTITIONS_AHEAD) || 5;

/**
 * Return the partition name for a given range start.
 */
function partitionName(start) {
  const end = start + RANGE_SIZE;
  if (end >= 1_000_000) {
    return `events_log_p${start}_to_${end}`;
  }
  return `events_log_p${start}_to_${end}`;
}

/**
 * Discover the highest existing partition upper bound.
 */
async function getMaxPartitionBound() {
  const { rows } = await query(`
    SELECT
      regexp_replace(inhrelid::regclass::text, '^events_log_p', '') AS suffix
    FROM pg_inherits
    WHERE inhparent = 'events_log'::regclass
  `);

  let maxBound = 0;
  for (const { suffix } of rows) {
    // suffix looks like "0_to_100000" or "100000_to_200000"
    const parts = suffix.split("_to_");
    if (parts.length === 2) {
      const upper = Number(parts[1]);
      if (!Number.isNaN(upper) && upper > maxBound) maxBound = upper;
    }
  }
  return maxBound;
}

async function createPartitions() {
  const maxBound = await getMaxPartitionBound();
  const currentLedger = await getCurrentLedger();

  // We want to ensure partitions cover `currentLedger` + PARTITIONS_AHEAD * RANGE_SIZE.
  const targetUpper = currentLedger + PARTITIONS_AHEAD * RANGE_SIZE;

  let nextStart = maxBound;
  let created = 0;

  while (nextStart < targetUpper) {
    const name = partitionName(nextStart);
    const upper = nextStart + RANGE_SIZE;

    try {
      await query(`
        CREATE TABLE IF NOT EXISTS ${name}
          PARTITION OF events_log
          FOR VALUES FROM (${nextStart}) TO (${upper})
      `);
      console.info(`[create-future-partitions] created ${name}`);
      created++;
    } catch (err) {
      logger.error(`[create-future-partitions] failed to create ${name}: ${err.message}`);
      break;
    }

    nextStart = upper;
  }

  return { created, nextStart };
}

/**
 * Get the current max ledger from the events_log table.
 */
async function getCurrentLedger() {
  try {
    const { rows } = await query("SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events_log");
    return Number(rows[0].max_ledger);
  } catch {
    return 0;
  }
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────
if (require.main === module) {
  createPartitions()
    .then(({ created, nextStart }) => {
      console.info(
        `[create-future-partitions] done — ${created} partition(s) created, next boundary: ${nextStart}`
      );
    })
    .catch((err) => {
      logger.error("[create-future-partitions] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}

module.exports = { createPartitions, getMaxPartitionBound, partitionName };
