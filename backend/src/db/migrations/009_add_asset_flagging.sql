-- Flags assets that have accumulated excessive moderation reports.

ALTER TABLE assets
    ADD COLUMN IF NOT EXISTS flagged    BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS flagged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_assets_flagged ON assets (flagged) WHERE flagged;
