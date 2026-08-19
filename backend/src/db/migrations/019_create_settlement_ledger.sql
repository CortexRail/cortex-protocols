-- Settlement ledger for crash-safe two-phase commit settlement tracking
-- Tracks settlement batches through PENDING -> CONFIRMED/FAILED states
-- Enables recovery from process crashes and network partitions

CREATE TABLE IF NOT EXISTS settlement_ledger (
    id              BIGSERIAL PRIMARY KEY,
    batch_nonce     BIGINT      NOT NULL,
    recipient       TEXT        NOT NULL,
    stream_ids      BIGINT[]    NOT NULL,
    expected_amounts BIGINT[]   NOT NULL,
    status          TEXT        NOT NULL DEFAULT 'PENDING' 
                        CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'DEAD_LETTERED')),
    error_message   TEXT,
    retry_count     INT         NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at    TIMESTAMPTZ,
    ledger_sequence BIGINT
);

CREATE INDEX IF NOT EXISTS idx_settlement_ledger_status ON settlement_ledger (status);
CREATE INDEX IF NOT EXISTS idx_settlement_ledger_recipient ON settlement_ledger (recipient);
CREATE INDEX IF NOT EXISTS idx_settlement_ledger_nonce ON settlement_ledger (batch_nonce, recipient);
CREATE INDEX IF NOT EXISTS idx_settlement_ledger_created_at ON settlement_ledger (created_at);

-- Add comment for documentation
COMMENT ON TABLE settlement_ledger IS 'Two-phase commit log for settlement batches with crash recovery';
COMMENT ON COLUMN settlement_ledger.batch_nonce IS 'Idempotency nonce for on-chain batch_settle call';
COMMENT ON COLUMN settlement_ledger.stream_ids IS 'Array of stream IDs in this settlement batch';
COMMENT ON COLUMN settlement_ledger.expected_amounts IS 'Expected settlement amounts per stream (aligned with stream_ids)';
COMMENT ON COLUMN settlement_ledger.status IS 'PENDING: before submission, CONFIRMED: after success, FAILED: after error, DEAD_LETTERED: after max retries';
COMMENT ON COLUMN settlement_ledger.retry_count IS 'Number of retry attempts for failed settlements';
