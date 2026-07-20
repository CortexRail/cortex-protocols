-- Track the pipeline cursor separately and enforce event uniqueness for reliable replay.

CREATE TABLE IF NOT EXISTS event_cursor (
    id                   BIGSERIAL PRIMARY KEY,
    name                 TEXT        NOT NULL UNIQUE,
    last_processed_ledger BIGINT     NOT NULL DEFAULT 0
);

ALTER TABLE events_log
  ADD COLUMN IF NOT EXISTS event_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

UPDATE events_log
  SET tx_hash = ''
  WHERE tx_hash IS NULL;

ALTER TABLE events_log
  ALTER COLUMN tx_hash SET DEFAULT '';
ALTER TABLE events_log
  ALTER COLUMN tx_hash SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_log_unique_event
  ON events_log (contract_id, ledger, COALESCE(tx_hash, ''), event_index);
