-- Convert events_log to a declaratively partitioned table by ledger range
-- (one partition per 100 000-ledger window).  The migration:
--   1. Creates a new partitioned events_log table.
--   2. Backfills data from the old table in batches.
--   3. Atomically renames old → _old, new → events_log.
--   4. Re-creates indexes on the partitioned table.
--   5. Drops the old unpartitioned table.
--
-- Downside: requires an ACCESS EXCLUSIVE lock during the brief rename swap,
-- but no data is lost and the window is sub-second.

-- 1 ── New partitioned table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events_log_partitioned (
    id          BIGSERIAL,
    ledger      BIGINT      NOT NULL CHECK (ledger >= 0),
    contract_id TEXT        NOT NULL,
    topic       TEXT[]      NOT NULL DEFAULT '{}',
    payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    tx_hash     TEXT        NOT NULL DEFAULT '',
    event_index INTEGER     NOT NULL DEFAULT 0,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (id, ledger)
) PARTITION BY RANGE (ledger);

-- 2 ── Create initial partitions covering existing data ──────────────────────
-- Each partition covers a 100 000-ledger window. Names follow the
-- `events_log_p<start>_to_<end>` convention that
-- `src/scripts/create-future-partitions.js` extends from, so pre-creating
-- future ranges never collides with the ones seeded here.
-- A default partition catches any rows outside the defined ranges.
CREATE TABLE events_log_p0_to_100000     PARTITION OF events_log_partitioned FOR VALUES FROM (0)       TO (100000);
CREATE TABLE events_log_p100000_to_200000   PARTITION OF events_log_partitioned FOR VALUES FROM (100000)  TO (200000);
CREATE TABLE events_log_p200000_to_300000   PARTITION OF events_log_partitioned FOR VALUES FROM (200000)  TO (300000);
CREATE TABLE events_log_p300000_to_400000   PARTITION OF events_log_partitioned FOR VALUES FROM (300000)  TO (400000);
CREATE TABLE events_log_p400000_to_500000   PARTITION OF events_log_partitioned FOR VALUES FROM (400000)  TO (500000);
CREATE TABLE events_log_p500000_to_600000   PARTITION OF events_log_partitioned FOR VALUES FROM (500000)  TO (600000);
CREATE TABLE events_log_p600000_to_700000   PARTITION OF events_log_partitioned FOR VALUES FROM (600000)  TO (700000);
CREATE TABLE events_log_p700000_to_800000   PARTITION OF events_log_partitioned FOR VALUES FROM (700000)  TO (800000);
CREATE TABLE events_log_p800000_to_900000   PARTITION OF events_log_partitioned FOR VALUES FROM (800000)  TO (900000);
CREATE TABLE events_log_p900000_to_1000000     PARTITION OF events_log_partitioned FOR VALUES FROM (900000)  TO (1000000);
CREATE TABLE events_log_p1000000_to_1100000     PARTITION OF events_log_partitioned FOR VALUES FROM (1000000) TO (1100000);
CREATE TABLE events_log_p1100000_to_1200000   PARTITION OF events_log_partitioned FOR VALUES FROM (1100000) TO (1200000);
CREATE TABLE events_log_p1200000_to_1300000   PARTITION OF events_log_partitioned FOR VALUES FROM (1200000) TO (1300000);
CREATE TABLE events_log_p1300000_to_1400000   PARTITION OF events_log_partitioned FOR VALUES FROM (1300000) TO (1400000);
CREATE TABLE events_log_p1400000_to_1500000   PARTITION OF events_log_partitioned FOR VALUES FROM (1400000) TO (1500000);
CREATE TABLE events_log_default         PARTITION OF events_log_partitioned DEFAULT;

-- 3 ── Backfill data from the old table in batches ───────────────────────────
DO $$
DECLARE
    batch_size INT := 10000;
    max_ledger BIGINT;
    cur_start  BIGINT := 0;
BEGIN
    SELECT COALESCE(MAX(ledger), 0) INTO max_ledger FROM events_log;

    WHILE cur_start <= max_ledger LOOP
        INSERT INTO events_log_partitioned
            (id, ledger, contract_id, topic, payload, tx_hash, event_index, ingested_at, processed_at)
        SELECT id, ledger, contract_id, topic, payload,
               COALESCE(tx_hash, ''), event_index, ingested_at, processed_at
        FROM events_log
        WHERE ledger >= cur_start AND ledger < cur_start + batch_size;

        cur_start := cur_start + batch_size;
    END LOOP;
END $$;

-- 4 ── Atomic swap ───────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS events_log RENAME TO events_log_old;
ALTER TABLE events_log_partitioned RENAME TO events_log;

-- 5 ── Drop the old table ────────────────────────────────────────────────────
-- Must happen before the indexes below are created: renaming a table does not
-- rename its indexes, so the old table still owns idx_events_log_ledger and
-- friends until it is dropped.
DROP TABLE IF EXISTS events_log_old;

-- 6 ── Re-create indexes on the new partitioned table ────────────────────────
-- Partition-key indexes are automatically created per-partition, but we still
-- need the logical indexes on the parent so the planner can prune.
CREATE INDEX idx_events_log_ledger ON events_log (ledger);
CREATE INDEX idx_events_log_contract ON events_log (contract_id, ledger);
CREATE INDEX idx_events_log_topic ON events_log USING GIN (topic);
CREATE UNIQUE INDEX ux_events_log_unique_event
    ON events_log (contract_id, ledger, COALESCE(tx_hash, ''), event_index);
