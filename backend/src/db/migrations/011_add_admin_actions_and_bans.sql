-- Operator audit trail, agent bans, and off-chain contract pause flags for
-- the cortex-admin CLI.

-- Every cortex-admin command writes a row here before it executes (status
-- 'pending'), then stamps the outcome afterward — so a crashed command still
-- leaves a record of intent.
CREATE TABLE IF NOT EXISTS admin_actions (
    id           BIGSERIAL   PRIMARY KEY,
    operator     TEXT        NOT NULL,
    role         TEXT        NOT NULL CHECK (role IN ('readonly', 'moderator', 'superadmin')),
    command      TEXT        NOT NULL,
    args         JSONB       NOT NULL DEFAULT '{}',
    status       TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'error')),
    result       JSONB,
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created_at ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_operator ON admin_actions (operator);
CREATE INDEX IF NOT EXISTS idx_admin_actions_status ON admin_actions (status) WHERE status = 'pending';

-- Consulted by agentService.js on every agent write path (registration,
-- reputation changes) to reject calls from a banned agent.
CREATE TABLE IF NOT EXISTS agent_bans (
    agent_id  BIGINT      PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
    reason    TEXT        NOT NULL,
    banned_by TEXT        NOT NULL,
    banned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Off-chain pause flag per contract, toggled by `cortex-admin contract
-- pause|unpause`. Services consult this before performing the write the
-- named contract backs (e.g. licenseService checks 'marketplace').
CREATE TABLE IF NOT EXISTS contract_state (
    name      TEXT        PRIMARY KEY,
    paused    BOOLEAN     NOT NULL DEFAULT FALSE,
    paused_by TEXT,
    paused_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
