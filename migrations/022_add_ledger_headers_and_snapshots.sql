CREATE TABLE ledger_headers (
    height BIGINT PRIMARY KEY,
    hash VARCHAR(64) NOT NULL
);

CREATE TABLE state_snapshots (
    ledger_height BIGINT PRIMARY KEY,
    state_data JSONB NOT NULL
);
