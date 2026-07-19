-- Registered agents indexed from the agent_registry contract.
-- Capabilities are a text[] so we can use array containment with a GIN index.

CREATE TABLE IF NOT EXISTS agents (
    id                 BIGINT PRIMARY KEY,
    owner              TEXT        NOT NULL,
    name               TEXT        NOT NULL,
    description        TEXT        NOT NULL DEFAULT '',
    capabilities       TEXT[]      NOT NULL DEFAULT '{}',
    reputation         INTEGER     NOT NULL DEFAULT 5000
                           CHECK (reputation >= 0 AND reputation <= 10000),
    total_transactions BIGINT      NOT NULL DEFAULT 0 CHECK (total_transactions >= 0),
    is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
    registered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    indexed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- capability filter: capabilities @> ARRAY['Reasoning']
CREATE INDEX IF NOT EXISTS idx_agents_capabilities
    ON agents USING GIN (capabilities);

CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents (owner);
CREATE INDEX IF NOT EXISTS idx_agents_reputation ON agents (reputation DESC);

CREATE INDEX IF NOT EXISTS idx_agents_active
    ON agents (registered_at DESC) WHERE is_active;
