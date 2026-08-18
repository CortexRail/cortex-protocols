-- Reputation engine: staking collateral, disputes, weighted votes, and the
-- decay clock the off-chain mirror recomputes scores from.
--
-- Stakes and disputes are keyed by *address* (matching the agent_registry
-- contract, where collateral is locked per account), while the denormalized
-- stake columns on `agents` let discovery queries filter and sort without a
-- join.

-- Collateral locked by an address, mirrored from STAKED / UNSTAKED /
-- STAKE_SLASHED events.
CREATE TABLE IF NOT EXISTS agent_stakes (
    agent_address TEXT        PRIMARY KEY,
    token         TEXT        NOT NULL DEFAULT '',
    amount        BIGINT      NOT NULL DEFAULT 0 CHECK (amount >= 0),
    slashed       BIGINT      NOT NULL DEFAULT 0 CHECK (slashed >= 0),
    staked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_stakes_amount ON agent_stakes (amount DESC);

-- One row per on-chain dispute. `evidence` holds the off-chain bundle whose
-- SHA-256 digest is what `evidence_hash` (and the contract) commits to.
CREATE TABLE IF NOT EXISTS disputes (
    id             BIGINT      PRIMARY KEY,
    complainant    TEXT        NOT NULL,
    respondent     TEXT        NOT NULL,
    evidence_hash  TEXT        NOT NULL DEFAULT '',
    evidence       JSONB,
    status         TEXT        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'resolved')),
    outcome        TEXT        CHECK (outcome IN ('guilty', 'not_guilty', 'quorum_failed')),
    weight_for     BIGINT      NOT NULL DEFAULT 0,
    weight_against BIGINT      NOT NULL DEFAULT 0,
    slashed_amount BIGINT      NOT NULL DEFAULT 0,
    opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    closes_at      TIMESTAMPTZ,
    resolved_at    TIMESTAMPTZ,
    indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputes_respondent ON disputes (respondent);
CREATE INDEX IF NOT EXISTS idx_disputes_complainant ON disputes (complainant);
CREATE INDEX IF NOT EXISTS idx_disputes_open ON disputes (closes_at) WHERE status = 'open';

-- Weighted votes cast on a dispute. One vote per (dispute, voter), matching
-- the contract's double-vote guard.
CREATE TABLE IF NOT EXISTS dispute_votes (
    dispute_id BIGINT      NOT NULL REFERENCES disputes (id) ON DELETE CASCADE,
    voter      TEXT        NOT NULL,
    in_favor   BOOLEAN     NOT NULL,
    weight     BIGINT      NOT NULL DEFAULT 0 CHECK (weight >= 0),
    voted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dispute_id, voter)
);

CREATE INDEX IF NOT EXISTS idx_dispute_votes_voter ON dispute_votes (voter);

-- Decay clock + denormalized stake for agents. `reputation` stays the *base*
-- score exactly as the contract stores it; what a reader sees is that score
-- decayed from `reputation_updated_at`, computed by reputationEngine.js.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reputation_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stake_amount BIGINT NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS stake_slashed BIGINT NOT NULL DEFAULT 0;
