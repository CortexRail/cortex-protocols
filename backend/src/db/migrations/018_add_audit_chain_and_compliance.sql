-- ============================================================================
-- 018 — Hash-chained audit log, Merkle anchor records, and compliance tables.
--
-- audit_log           — tamper-evident, hash-chained append-only audit trail
-- merkle_anchors      — records of on-chain Merkle root commitments
-- compliance_requests — tracks export and erasure requests
-- pseudonym_map       — maps original identifiers to stable pseudonyms used
--                       during erasure so the hash chain stays structurally
--                       intact while PII is replaced with irreversible tokens.
-- ============================================================================

-- ── audit_log ────────────────────────────────────────────────────────────────
-- Each row is one audit event. The `entry_hash` field commits to the
-- payload AND the preceding entry's hash, forming a tamper-evident chain.
-- A modification to any historical row will cause every subsequent
-- entry_hash to become invalid, detectable by AuditChainVerifier.

CREATE TABLE IF NOT EXISTS audit_log (
    id           BIGSERIAL    PRIMARY KEY,
    -- Monotonically increasing sequence number; gaps signal a missing entry.
    seq          BIGINT       NOT NULL UNIQUE,
    -- Category of the audit event (see AuditLogWriter for the full list).
    event_type   TEXT         NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 100),
    -- The actor who caused this event (admin operator key or 'system').
    actor        TEXT         NOT NULL,
    -- Stable identifier for the subject of the action (agent id, user key, asset id…).
    subject_id   TEXT,
    -- JSON payload.  PII in this column may be pseudonymised by ErasureService;
    -- the structural hash chain is preserved after pseudonymisation.
    payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- SHA-256( prev_entry_hash || seq || event_type || actor || subject_id || payload )
    -- For seq=1 the genesis hash uses the empty string as prev_entry_hash.
    entry_hash   TEXT         NOT NULL,
    -- entry_hash of the immediately preceding row (NULL only for seq=1).
    prev_hash    TEXT,
    -- Ledger sequence at time of write (if triggered by an on-chain event).
    ledger       BIGINT,
    -- Wall-clock timestamp.
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_seq          ON audit_log (seq);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type   ON audit_log (event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor        ON audit_log (actor);
CREATE INDEX IF NOT EXISTS idx_audit_log_subject_id   ON audit_log (subject_id)
    WHERE subject_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at   ON audit_log (created_at DESC);


-- ── merkle_anchors ────────────────────────────────────────────────────────────
-- Every time MerkleAnchor commits a root on-chain, this table records the
-- full context: which entries were covered, the root itself, and the
-- on-chain transaction hash so the commitment can be independently verified.

CREATE TABLE IF NOT EXISTS merkle_anchors (
    id              BIGSERIAL    PRIMARY KEY,
    -- The last audit_log.seq included in this Merkle tree.
    from_seq        BIGINT       NOT NULL,
    to_seq          BIGINT       NOT NULL,
    -- Total count of entries in this tree.
    entry_count     BIGINT       NOT NULL CHECK (entry_count > 0),
    -- Hex-encoded Merkle root (SHA-256 based binary tree).
    merkle_root     TEXT         NOT NULL,
    -- On-chain contract address of the AuditAnchorContract instance.
    anchor_contract TEXT,
    -- Transaction hash returned by the Soroban RPC after submission.
    on_chain_tx     TEXT,
    -- Zero-based index in the contract's append-only anchor list.
    anchor_index    INTEGER,
    -- Status of the on-chain submission attempt.
    status          TEXT         NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
    error_message   TEXT,
    anchored_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_merkle_anchors_to_seq ON merkle_anchors (to_seq DESC);
CREATE INDEX IF NOT EXISTS idx_merkle_anchors_status ON merkle_anchors (status)
    WHERE status IN ('pending', 'submitted');


-- ── compliance_requests ───────────────────────────────────────────────────────
-- Tracks every GDPR / compliance export or erasure request made through the
-- admin API.  Async processing is recorded here so operators have a durable
-- log of what was requested and what was done.

CREATE TABLE IF NOT EXISTS compliance_requests (
    id              BIGSERIAL    PRIMARY KEY,
    -- 'export' — produce a structured data bundle for the subject.
    -- 'erasure' — pseudonymise PII fields for the subject.
    request_type    TEXT         NOT NULL CHECK (request_type IN ('export', 'erasure')),
    -- The subject identifier (typically a Stellar public key or agent id).
    subject_id      TEXT         NOT NULL,
    -- Admin who submitted the request.
    requested_by    TEXT         NOT NULL,
    -- Current lifecycle state.
    status          TEXT         NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    -- JSON summary of what the export contains or what was pseudonymised.
    result_summary  JSONB,
    -- For exports: the serialised bundle stored as JSON for download.
    export_bundle   JSONB,
    error_message   TEXT,
    -- Unique token so the download URL is not guessable.
    download_token  TEXT         UNIQUE,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_compliance_requests_subject  ON compliance_requests (subject_id);
CREATE INDEX IF NOT EXISTS idx_compliance_requests_status   ON compliance_requests (status)
    WHERE status IN ('pending', 'processing');
CREATE INDEX IF NOT EXISTS idx_compliance_requests_created  ON compliance_requests (created_at DESC);


-- ── pseudonym_map ─────────────────────────────────────────────────────────────
-- Maps original PII values to their stable pseudonyms.  Once a mapping is
-- created it is never changed, so repeated pseudonymisation of the same
-- value produces the same token (enabling consistent audit log reads).
-- The original value is NOT stored here — only the pseudonym.

CREATE TABLE IF NOT EXISTS pseudonym_map (
    id           BIGSERIAL    PRIMARY KEY,
    -- Stable key: SHA-256 of ( subject_id || field_name || original_value ).
    lookup_key   TEXT         NOT NULL UNIQUE,
    -- The pseudonym token that replaced the original value.
    pseudonym    TEXT         NOT NULL,
    -- Which subject this mapping belongs to.
    subject_id   TEXT         NOT NULL,
    -- Which field was pseudonymised (e.g. 'owner', 'buyer', 'actor').
    field_name   TEXT         NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pseudonym_map_subject ON pseudonym_map (subject_id);
