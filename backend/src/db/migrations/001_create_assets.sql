-- Intelligence assets indexed from the marketplace contract.
-- Tags live in JSONB; full-text search runs over a stored tsvector column.

CREATE TABLE IF NOT EXISTS assets (
    id            BIGINT PRIMARY KEY,
    owner         TEXT        NOT NULL,
    name          TEXT        NOT NULL,
    description   TEXT        NOT NULL DEFAULT '',
    asset_type    TEXT        NOT NULL CHECK (asset_type IN (
                      'Prompt', 'Workflow', 'ReasoningChain', 'Dataset',
                      'Evaluator', 'MemorySystem', 'ModelInstruction', 'Tool'
                  )),
    license_type  TEXT        NOT NULL CHECK (license_type IN (
                      'Perpetual', 'UsageBased', 'Subscription', 'OpenSource'
                  )),
    price         BIGINT      NOT NULL DEFAULT 0 CHECK (price >= 0),
    usage_count   BIGINT      NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
    is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    tags          JSONB       NOT NULL DEFAULT '[]'::jsonb,
    search_vector tsvector GENERATED ALWAYS AS (
                      setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
                      setweight(to_tsvector('english', coalesce(description, '')), 'B')
                  ) STORED,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    indexed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at    TIMESTAMPTZ
);

-- Full-text search over name + description.
CREATE INDEX IF NOT EXISTS idx_assets_search
    ON assets USING GIN (search_vector);

-- Containment queries on tags (tags @> '["reasoning"]').
CREATE INDEX IF NOT EXISTS idx_assets_tags
    ON assets USING GIN (tags jsonb_path_ops);

CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets (owner);
CREATE INDEX IF NOT EXISTS idx_assets_asset_type ON assets (asset_type);
CREATE INDEX IF NOT EXISTS idx_assets_license_type ON assets (license_type);
CREATE INDEX IF NOT EXISTS idx_assets_price ON assets (price);

-- Most queries only touch live listings.
CREATE INDEX IF NOT EXISTS idx_assets_active
    ON assets (created_at DESC) WHERE is_active;
