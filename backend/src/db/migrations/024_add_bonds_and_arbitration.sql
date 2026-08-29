-- Migration: 024_add_bonds_and_arbitration.sql
-- Description: Adds database tables for seller collateral bonds, multi-round commit-reveal dispute games, arbiter stakes, and slashing events.

CREATE TABLE IF NOT EXISTS bonds (
    id SERIAL PRIMARY KEY,
    seller_address VARCHAR(56) NOT NULL,
    asset_id BIGINT NOT NULL,
    amount NUMERIC(38, 0) NOT NULL,
    posted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    unlocked_at TIMESTAMP WITH TIME ZONE NULL,
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE (seller_address, asset_id)
);

CREATE INDEX IF NOT EXISTS idx_bonds_seller ON bonds(seller_address);
CREATE INDEX IF NOT EXISTS idx_bonds_asset ON bonds(asset_id);

CREATE TABLE IF NOT EXISTS dispute_rounds (
    id SERIAL PRIMARY KEY,
    dispute_id BIGINT NOT NULL,
    round_number INT NOT NULL,
    phase VARCHAR(32) NOT NULL DEFAULT 'COMMIT',
    buyer_address VARCHAR(56) NOT NULL,
    seller_address VARCHAR(56) NOT NULL,
    buyer_bond NUMERIC(38, 0) NOT NULL,
    seller_bond NUMERIC(38, 0) NOT NULL,
    buyer_claim_hash VARCHAR(64) NOT NULL,
    seller_response_hash VARCHAR(64) NULL,
    buyer_evidence TEXT NULL,
    seller_evidence TEXT NULL,
    buyer_revealed BOOLEAN DEFAULT FALSE,
    seller_revealed BOOLEAN DEFAULT FALSE,
    buyer_escalated BOOLEAN DEFAULT FALSE,
    seller_escalated BOOLEAN DEFAULT FALSE,
    outcome VARCHAR(32) DEFAULT 'NONE',
    phase_deadline TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (dispute_id, round_number)
);

CREATE INDEX IF NOT EXISTS idx_dispute_rounds_dispute ON dispute_rounds(dispute_id);
CREATE INDEX IF NOT EXISTS idx_dispute_rounds_phase ON dispute_rounds(phase);

CREATE TABLE IF NOT EXISTS arbiters (
    address VARCHAR(56) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    stake_amount NUMERIC(38, 0) NOT NULL DEFAULT 0,
    disputes_adjudicated INT DEFAULT 0,
    slashed_amount NUMERIC(38, 0) DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS slashing_events (
    id SERIAL PRIMARY KEY,
    dispute_id BIGINT NOT NULL,
    slashed_address VARCHAR(56) NOT NULL,
    recipient_address VARCHAR(56) NOT NULL,
    slashed_amount NUMERIC(38, 0) NOT NULL,
    treasury_share NUMERIC(38, 0) NOT NULL,
    reason VARCHAR(128) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slashing_dispute ON slashing_events(dispute_id);
CREATE INDEX IF NOT EXISTS idx_slashing_address ON slashing_events(slashed_address);
