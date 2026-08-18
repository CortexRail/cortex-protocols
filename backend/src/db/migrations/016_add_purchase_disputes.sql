-- Escrow-backed refund system and on-chain dispute arbitration tables

CREATE TABLE IF NOT EXISTS escrow_holds (
    license_id        BIGINT       PRIMARY KEY,
    buyer             VARCHAR(56)  NOT NULL,
    seller            VARCHAR(56)  NOT NULL,
    token             VARCHAR(56)  NOT NULL,
    amount            NUMERIC      NOT NULL CHECK (amount >= 0),
    created_ledger    INTEGER      NOT NULL,
    hold_until_ledger INTEGER      NOT NULL,
    status            VARCHAR(20)  NOT NULL DEFAULT 'Held' CHECK (
                        status IN ('Held', 'Released', 'Disputed', 'Resolved')
                      ),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_disputes (
    dispute_id    BIGINT       PRIMARY KEY,
    license_id    BIGINT       NOT NULL REFERENCES escrow_holds(license_id) ON DELETE CASCADE,
    buyer         VARCHAR(56)  NOT NULL,
    evidence_hash CHAR(64)     NOT NULL,
    evidence_text TEXT,
    status        VARCHAR(20)  NOT NULL DEFAULT 'Open' CHECK (
                    status IN ('Open', 'Resolved')
                  ),
    decision      VARCHAR(30),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS arbitrator_votes (
    id          BIGSERIAL    PRIMARY KEY,
    dispute_id  BIGINT       NOT NULL REFERENCES purchase_disputes(dispute_id) ON DELETE CASCADE,
    arbitrator  VARCHAR(56)  NOT NULL,
    vote        VARCHAR(30)  NOT NULL CHECK (
                  vote IN ('FullRefund', 'PartialRefund', 'ReleaseToSeller')
                ),
    bps         INTEGER      CHECK (bps IS NULL OR (bps >= 0 AND bps <= 10000)),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT  unique_dispute_arbitrator UNIQUE(dispute_id, arbitrator)
);

CREATE INDEX IF NOT EXISTS idx_escrow_buyer ON escrow_holds(buyer);
CREATE INDEX IF NOT EXISTS idx_escrow_seller ON escrow_holds(seller);
CREATE INDEX IF NOT EXISTS idx_escrow_status ON escrow_holds(status);
CREATE INDEX IF NOT EXISTS idx_disputes_buyer ON purchase_disputes(buyer);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON purchase_disputes(status);
CREATE INDEX IF NOT EXISTS idx_votes_dispute ON arbitrator_votes(dispute_id);
