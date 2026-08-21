-- ============================================================================
-- 021 — Proof-of-execution attestations.
--
-- The issue asks for this as `019_add_attestations.sql`; 019 and 020 were both
-- taken by the time it landed (settlement ledger, fraud signals), so it is
-- numbered 021. The migration runner orders by numeric prefix, so the number
-- is the only thing that had to change.
--
-- attestation_leaves   — one row per metered call, the full signed statement.
--                        This is the archive: the on-chain commitment is only
--                        a root, so a buyer disputing a batch needs these rows
--                        to reconstruct the proof.
-- attestation_batches  — the Merkle commitment over a contiguous run of leaves,
--                        plus its on-chain lifecycle (pending → recorded →
--                        challenged/voided).
-- used_nonces          — the replay set. Kept separate from attestation_leaves
--                        so the uniqueness check is a single narrow index probe
--                        on the metering hot path, and so a nonce stays burnt
--                        even if its leaf is later voided.
--
-- No foreign keys to `streams`, matching usage_events and events_log: these
-- rows are written inside the transaction that bills a call, and a stream row
-- that has not been indexed from chain yet must never fail a paid call.
-- ============================================================================


-- ── attestation_batches ──────────────────────────────────────────────────────
-- One row per Merkle commitment. `batch_id` is assigned by the contract when
-- record_usage_batch succeeds; until then the row sits in 'pending' with a NULL
-- batch_id, which is why the primary key is a local surrogate.

CREATE TABLE IF NOT EXISTS attestation_batches (
    id                BIGSERIAL   PRIMARY KEY,
    stream_id         BIGINT      NOT NULL,
    -- Assigned on-chain; NULL until the batch is recorded.
    batch_id          BIGINT,
    seller            TEXT        NOT NULL,
    -- 64 hex chars = the 32-byte root committed on-chain.
    merkle_root       TEXT        NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
    call_count        BIGINT      NOT NULL CHECK (call_count > 0),
    -- Batches cover a contiguous index run; these two bound it inclusively and
    -- are what turns a disputed leaf's call_index into a refundable position.
    first_call_index  BIGINT      NOT NULL CHECK (first_call_index >= 0),
    last_call_index   BIGINT      NOT NULL CHECK (last_call_index >= first_call_index),
    -- 128 hex chars = the seller's 64-byte Ed25519 batch commitment signature.
    batch_signature   TEXT        NOT NULL CHECK (batch_signature ~ '^[0-9a-f]{128}$'),
    status            TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'recorded', 'challenged', 'voided'
                      )),
    -- Set when a challenge succeeds: how many calls were reversed and what the
    -- contract refunded, mirrored off-chain so the UI need not replay events.
    voided_calls      BIGINT      NOT NULL DEFAULT 0 CHECK (voided_calls >= 0),
    refunded_amount   BIGINT      NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
    tx_hash           TEXT,
    recorded_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT attestation_batches_range_matches_count
        CHECK (last_call_index - first_call_index + 1 = call_count),
    CONSTRAINT attestation_batches_void_within_batch
        CHECK (voided_calls <= call_count)
);

-- A given on-chain batch id is unique per stream. Partial: 'pending' rows all
-- carry NULL and must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS uq_attestation_batches_stream_batch
    ON attestation_batches (stream_id, batch_id) WHERE batch_id IS NOT NULL;

-- The buyer's attestation page: newest batches for one stream.
CREATE INDEX IF NOT EXISTS idx_attestation_batches_stream
    ON attestation_batches (stream_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attestation_batches_seller
    ON attestation_batches (seller, created_at DESC);

-- The submitter's work queue.
CREATE INDEX IF NOT EXISTS idx_attestation_batches_pending
    ON attestation_batches (created_at) WHERE status = 'pending';


-- ── attestation_leaves ───────────────────────────────────────────────────────
-- The archived attestation itself. Every column except batch_ref and the
-- bookkeeping timestamps is covered by `signature`, so a row that has been
-- tampered with in the database fails verification the same way a forged one
-- does — the archive is untrusted storage by design.

CREATE TABLE IF NOT EXISTS attestation_leaves (
    id             BIGSERIAL   PRIMARY KEY,
    -- NULL while a call is metered but not yet batched.
    batch_ref      BIGINT      REFERENCES attestation_batches (id) ON DELETE SET NULL,
    stream_id      BIGINT      NOT NULL,
    call_index     BIGINT      NOT NULL CHECK (call_index >= 0),
    request_hash   TEXT        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_hash  TEXT        NOT NULL CHECK (response_hash ~ '^[0-9a-f]{64}$'),
    attested_at    BIGINT      NOT NULL CHECK (attested_at >= 0),
    nonce          TEXT        NOT NULL CHECK (nonce ~ '^[0-9a-f]{64}$'),
    signature      TEXT        NOT NULL CHECK (signature ~ '^[0-9a-f]{128}$'),
    signer         TEXT        NOT NULL,
    -- Cached sha256(0x00 || leaf preimage). Derivable from the columns above;
    -- stored so proof assembly is a plain SELECT rather than N rehashes.
    leaf_hash      TEXT        NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
    -- Verification outcome recorded at metering time, for triage. Never trusted
    -- on the dispute path: a challenge re-verifies from the signed bytes.
    verify_reason  TEXT        NOT NULL DEFAULT 'OK',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- The monotonic-index rule, enforced by the schema rather than only in JS.
    CONSTRAINT uq_attestation_leaves_stream_call UNIQUE (stream_id, call_index)
);

-- Proof assembly reads a whole batch in call order.
CREATE INDEX IF NOT EXISTS idx_attestation_leaves_batch
    ON attestation_leaves (batch_ref, call_index) WHERE batch_ref IS NOT NULL;

-- Batching reads the un-batched tail of a stream in call order.
CREATE INDEX IF NOT EXISTS idx_attestation_leaves_unbatched
    ON attestation_leaves (stream_id, call_index) WHERE batch_ref IS NULL;


-- ── used_nonces ──────────────────────────────────────────────────────────────
-- The replay set, keyed per stream. A nonce lifted from another stream cannot
-- be replayed anyway (stream_id is inside the signed bytes), so the composite
-- key is both sufficient and narrower than a global one.
--
-- Rows are never deleted on a void: the point is that a nonce is spent once,
-- and a voided batch must not free its nonces for reuse.

CREATE TABLE IF NOT EXISTS used_nonces (
    stream_id  BIGINT      NOT NULL,
    nonce      TEXT        NOT NULL CHECK (nonce ~ '^[0-9a-f]{64}$'),
    call_index BIGINT      NOT NULL CHECK (call_index >= 0),
    used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (stream_id, nonce)
);

-- Restoring AttestationBuilder's counter after a restart: MAX(call_index).
CREATE INDEX IF NOT EXISTS idx_used_nonces_stream_index
    ON used_nonces (stream_id, call_index DESC);
