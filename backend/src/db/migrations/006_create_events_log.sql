-- Append-only audit log of raw on-chain events, exactly as received from the
-- Soroban RPC. The event listener resumes from MAX(ledger) after a restart.

CREATE TABLE IF NOT EXISTS events_log (
    id          BIGSERIAL PRIMARY KEY,
    ledger      BIGINT      NOT NULL CHECK (ledger >= 0),
    contract_id TEXT        NOT NULL,
    topic       TEXT[]      NOT NULL DEFAULT '{}',
    payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    tx_hash     TEXT,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_log_ledger ON events_log (ledger);
CREATE INDEX IF NOT EXISTS idx_events_log_contract ON events_log (contract_id, ledger);

-- topic containment: topic @> ARRAY['LISTED']
CREATE INDEX IF NOT EXISTS idx_events_log_topic ON events_log USING GIN (topic);
