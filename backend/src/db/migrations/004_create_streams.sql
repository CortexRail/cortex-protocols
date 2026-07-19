-- Payment streams indexed from the micropayments contract.
-- start_time / end_time are unix seconds exactly as emitted on-chain.

CREATE TABLE IF NOT EXISTS streams (
    id              BIGINT PRIMARY KEY,
    sender          TEXT        NOT NULL,
    recipient       TEXT        NOT NULL,
    token           TEXT        NOT NULL,
    deposit         BIGINT      NOT NULL CHECK (deposit >= 0),
    rate_per_second BIGINT      NOT NULL CHECK (rate_per_second >= 0),
    start_time      BIGINT      NOT NULL CHECK (start_time >= 0),
    end_time        BIGINT      NOT NULL CHECK (end_time >= 0),
    status          TEXT        NOT NULL DEFAULT 'Active' CHECK (status IN (
                        'Active', 'Paused', 'Completed', 'Cancelled'
                    )),
    withdrawn       BIGINT      NOT NULL DEFAULT 0
                        CHECK (withdrawn >= 0 AND withdrawn <= deposit),
    indexed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_streams_sender ON streams (sender);
CREATE INDEX IF NOT EXISTS idx_streams_recipient ON streams (recipient);
CREATE INDEX IF NOT EXISTS idx_streams_status ON streams (status);
