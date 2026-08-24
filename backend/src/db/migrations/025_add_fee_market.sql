-- Migration 025: Congestion-priced capacity market & priority auction

CREATE TABLE IF NOT EXISTS capacity_windows (
    id SERIAL PRIMARY KEY,
    asset_id VARCHAR(64) NOT NULL,
    window_id BIGINT NOT NULL,
    window_start_ms BIGINT NOT NULL,
    window_end_ms BIGINT NOT NULL,
    max_capacity INTEGER NOT NULL DEFAULT 1000,
    target_capacity INTEGER NOT NULL DEFAULT 500,
    consumed_units INTEGER NOT NULL DEFAULT 0,
    carry_over_units INTEGER NOT NULL DEFAULT 0,
    utilisation_bps INTEGER NOT NULL DEFAULT 0,
    base_fee NUMERIC(38, 0) NOT NULL DEFAULT 100,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_asset_window UNIQUE (asset_id, window_id)
);

CREATE TABLE IF NOT EXISTS base_fee_history (
    id SERIAL PRIMARY KEY,
    asset_id VARCHAR(64) NOT NULL,
    window_id BIGINT NOT NULL,
    base_fee NUMERIC(38, 0) NOT NULL,
    utilisation_bps INTEGER NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reservations (
    id VARCHAR(64) PRIMARY KEY,
    asset_id VARCHAR(64) NOT NULL,
    buyer_id VARCHAR(64) NOT NULL,
    window_id BIGINT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 1,
    base_fee NUMERIC(38, 0) NOT NULL,
    max_base_fee NUMERIC(38, 0) NOT NULL,
    tip NUMERIC(38, 0) NOT NULL DEFAULT 0,
    status VARCHAR(32) NOT NULL DEFAULT 'COMMITTED', -- COMMITTED, SETTLED, REVERTED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tip_receipts (
    id SERIAL PRIMARY KEY,
    reservation_id VARCHAR(64) NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    asset_id VARCHAR(64) NOT NULL,
    seller_id VARCHAR(64) NOT NULL,
    buyer_id VARCHAR(64) NOT NULL,
    tip_amount NUMERIC(38, 0) NOT NULL,
    distributed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capacity_windows_asset_window ON capacity_windows(asset_id, window_id);
CREATE INDEX IF NOT EXISTS idx_base_fee_history_asset ON base_fee_history(asset_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_reservations_buyer ON reservations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_tip_receipts_seller ON tip_receipts(seller_id);