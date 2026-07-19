-- Licenses purchased against marketplace assets.
--
-- calls_remaining: NULL means unlimited (Perpetual / OpenSource / Subscription);
--                  a number means usage-based metering.
-- expires_at:      NULL means the license never expires.

CREATE TABLE IF NOT EXISTS licenses (
    id              BIGSERIAL PRIMARY KEY,
    asset_id        BIGINT      NOT NULL REFERENCES assets (id) ON DELETE RESTRICT,
    buyer           TEXT        NOT NULL,
    license_type    TEXT        NOT NULL CHECK (license_type IN (
                        'Perpetual', 'UsageBased', 'Subscription', 'OpenSource'
                    )),
    price_paid      BIGINT      NOT NULL DEFAULT 0 CHECK (price_paid >= 0),
    calls_remaining BIGINT      CHECK (calls_remaining IS NULL OR calls_remaining >= 0),
    expires_at      TIMESTAMPTZ,
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
    purchased_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A buyer holds at most one active license per asset.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_one_active_per_buyer_asset
    ON licenses (asset_id, buyer) WHERE is_active;

CREATE INDEX IF NOT EXISTS idx_licenses_buyer ON licenses (buyer);
CREATE INDEX IF NOT EXISTS idx_licenses_asset ON licenses (asset_id);
CREATE INDEX IF NOT EXISTS idx_licenses_expires
    ON licenses (expires_at) WHERE is_active AND expires_at IS NOT NULL;
