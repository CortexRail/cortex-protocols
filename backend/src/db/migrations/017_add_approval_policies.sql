-- Multi-signature threshold approval workflow tables

CREATE TABLE IF NOT EXISTS approval_policies (
    org_id     VARCHAR(56) PRIMARY KEY,
    threshold  INTEGER     NOT NULL CHECK (threshold > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS purchase_proposals (
    id            BIGSERIAL   PRIMARY KEY,
    org_id        VARCHAR(56) NOT NULL REFERENCES approval_policies(org_id) ON DELETE CASCADE,
    asset_id      INTEGER     NOT NULL,
    asset_version INTEGER     NOT NULL,
    buyer         VARCHAR(56) NOT NULL,
    price         NUMERIC     NOT NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (
                    status IN ('pending', 'approved', 'rejected', 'expired', 'executed')
                  ),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS proposal_approvals (
    id          BIGSERIAL   PRIMARY KEY,
    proposal_id BIGINT      NOT NULL REFERENCES purchase_proposals(id) ON DELETE CASCADE,
    signer      VARCHAR(56) NOT NULL,
    status      VARCHAR(20) NOT NULL CHECK (
                  status IN ('approved', 'rejected')
                ),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT  unique_proposal_signer UNIQUE(proposal_id, signer)
);

CREATE INDEX IF NOT EXISTS idx_proposals_org ON purchase_proposals(org_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON purchase_proposals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON proposal_approvals(proposal_id);
