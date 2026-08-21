-- Add multi-token pricing support to assets and licenses.
-- Adds usd_price_cents (canonical USD price in cents) and accepted_tokens (JSONB array).
-- Licenses now track which token was used for purchase.

-- Add columns to assets table
ALTER TABLE IF EXISTS assets
  ADD COLUMN IF NOT EXISTS usd_price_cents BIGINT,
  ADD COLUMN IF NOT EXISTS accepted_tokens JSONB NOT NULL DEFAULT '["native"]'::jsonb;

-- Add constraint for usd_price_cents
ALTER TABLE IF EXISTS assets
  ADD CONSTRAINT check_usd_price_cents CHECK (usd_price_cents IS NULL OR usd_price_cents > 0);

-- Create index for accepted_tokens queries
CREATE INDEX IF NOT EXISTS idx_assets_accepted_tokens
  ON assets USING GIN (accepted_tokens jsonb_path_ops);

-- Add token column to licenses table to track which token was used for purchase
ALTER TABLE IF EXISTS licenses
  ADD COLUMN IF NOT EXISTS token TEXT DEFAULT 'native';

-- Index for token queries (analytics on token usage)
CREATE INDEX IF NOT EXISTS idx_licenses_token
  ON licenses (token);

-- Create a view for multi-token pricing health
CREATE OR REPLACE VIEW asset_pricing_health AS
  SELECT
    a.id,
    a.owner,
    a.name,
    a.price,
    a.usd_price_cents,
    a.accepted_tokens,
    jsonb_array_length(a.accepted_tokens) AS token_count,
    COUNT(DISTINCT l.id) FILTER (WHERE l.is_active) AS active_licenses,
    COUNT(DISTINCT l.token) FILTER (WHERE l.is_active) AS unique_payment_tokens,
    a.created_at,
    a.updated_at
  FROM assets a
  LEFT JOIN licenses l ON a.id = l.asset_id
  WHERE a.is_active AND a.deleted_at IS NULL
  GROUP BY a.id, a.owner, a.name, a.price, a.usd_price_cents,
           a.accepted_tokens, a.created_at, a.updated_at;
