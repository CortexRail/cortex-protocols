-- ============================================================================
-- 020 — Fraud & anomaly detection: per-call usage log, scored detector output,
--       and the automated path into the existing moderation queue.
--
-- usage_events          — one row per metered call (stream or license). This is
--                         the detectors' only time series: before this table
--                         nothing in the schema recorded call-level activity,
--                         only the running counters on `streams`.
-- fraud_signals         — scored detector output. At most one OPEN row per
--                         (detector, agent, asset) so a re-scan updates the
--                         existing signal instead of duplicating it.
-- agent_funding_sources — optional first-funding lookup used by the sybil
--                         clustering. Empty until a Horizon backfill fills it;
--                         the detector treats an absent row as "unknown".
-- reports               — gains `source` + `evidence` so an automated flag can
--                         enter the same moderation queue as a user report.
-- ============================================================================


-- ── usage_events ─────────────────────────────────────────────────────────────
-- Append-only analytics log written on the metering hot path.
--
-- Deliberately carries NO foreign keys, exactly like events_log: this row is
-- inserted inside the same transaction that bills a paid call, and a missing
-- asset/stream/license row must never be the reason a paid call fails. The
-- detectors join by id where they need the related record.
--
-- asset_id is nullable because a stream token issued before this migration
-- carries no asset binding; those calls still record caller/counterparty.
-- payload_hash is nullable because a client may meter without sending a body.

CREATE TABLE IF NOT EXISTS usage_events (
    id           BIGSERIAL   PRIMARY KEY,
    -- Which metering path produced the call.
    source       TEXT        NOT NULL CHECK (source IN ('stream', 'license')),
    stream_id    BIGINT,
    license_id   BIGINT,
    asset_id     BIGINT,
    -- The address being billed (stream sender / license buyer).
    caller       TEXT        NOT NULL,
    -- The address being paid (stream recipient). NULL for license calls, where
    -- the payee is derivable from assets.owner via asset_id.
    counterparty TEXT,
    -- SHA-256 of the request payload, used by ReplayAbuseDetector.
    payload_hash TEXT,
    price_paid   BIGINT      NOT NULL DEFAULT 0 CHECK (price_paid >= 0),
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolling-window scans read by time first, then slice by subject.
CREATE INDEX IF NOT EXISTS idx_usage_events_occurred_at
    ON usage_events (occurred_at DESC);

-- VelocityDetector / WashUsageDetector: per-asset series.
CREATE INDEX IF NOT EXISTS idx_usage_events_asset_time
    ON usage_events (asset_id, occurred_at DESC) WHERE asset_id IS NOT NULL;

-- VelocityDetector: per-caller series. SybilGraphDetector: edge extraction.
CREATE INDEX IF NOT EXISTS idx_usage_events_caller_time
    ON usage_events (caller, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_counterparty_time
    ON usage_events (counterparty, occurred_at DESC) WHERE counterparty IS NOT NULL;

-- ReplayAbuseDetector: repeated payloads against the same asset.
CREATE INDEX IF NOT EXISTS idx_usage_events_asset_payload
    ON usage_events (asset_id, payload_hash) WHERE payload_hash IS NOT NULL;

COMMENT ON TABLE usage_events IS 'Per-call metering log; the time series every fraud detector reads';
COMMENT ON COLUMN usage_events.payload_hash IS 'SHA-256 of the metered request payload, NULL when the call carried no body';


-- ── fraud_signals ────────────────────────────────────────────────────────────
-- One scored finding. `explanation` is NOT NULL and non-empty by CHECK: the
-- acceptance criterion "every automated flag includes a human-readable
-- explanation, never a bare score" is enforced by the schema, not by
-- convention.

CREATE TABLE IF NOT EXISTS fraud_signals (
    id             BIGSERIAL   PRIMARY KEY,
    -- Groups every signal produced by one run of run-fraud-scan.js.
    scan_id        UUID        NOT NULL,
    detector       TEXT        NOT NULL CHECK (detector IN (
                       'velocity', 'sybil_graph', 'wash_usage',
                       'replay_abuse', 'composite'
                   )),
    -- The flagged address. Signals are per agent/asset pair; asset_id is NULL
    -- for findings that are about the address alone (e.g. a sybil cluster).
    agent_address  TEXT        NOT NULL,
    -- RESTRICT, mirroring licenses.asset_id: fraud findings are an audit
    -- trail and must not vanish with the asset they are about. Assets are
    -- only ever soft-deleted (assetRepository.softDelete flips is_active and
    -- stamps deleted_at) and the GDPR path pseudonymises rather than deleting,
    -- so this never fires in normal operation — it is a guard against a future
    -- hard delete silently destroying evidence.
    --
    -- SET NULL would be wrong here specifically: NULL already *means*
    -- "address-level finding", so a nulled row would masquerade as one, and
    -- it could collide with the COALESCE(asset_id, 0) unique index below and
    -- make the DELETE fail anyway.
    asset_id       BIGINT      REFERENCES assets (id) ON DELETE RESTRICT,
    -- Normalized 0..1 risk. NUMERIC, so re-reading never drifts.
    score          NUMERIC(6,4) NOT NULL CHECK (score >= 0 AND score <= 1),
    risk_tier      TEXT        NOT NULL CHECK (risk_tier IN (
                       'low', 'medium', 'high', 'critical'
                   )),
    -- Which signals fired, their metrics, and the sample rows behind them.
    evidence       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Human-readable rendering of `evidence`, shown to the moderator.
    explanation    TEXT        NOT NULL CHECK (char_length(explanation) > 0),
    window_start   TIMESTAMPTZ NOT NULL,
    window_end     TIMESTAMPTZ NOT NULL,
    status         TEXT        NOT NULL DEFAULT 'open' CHECK (status IN (
                       'open', 'dismissed', 'reported'
                   )),
    -- Set once the signal has been routed into the moderation queue.
    report_id      BIGINT      REFERENCES reports (id) ON DELETE SET NULL,
    dismissed_by   TEXT,
    dismissed_at   TIMESTAMPTZ,
    dismiss_reason TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fraud_signals_window_ordered CHECK (window_end >= window_start)
);

-- Idempotent re-scans: a detector that fires again for the same subject
-- updates the existing row instead of stacking duplicates. COALESCE keeps the
-- NULL asset_id case (address-only findings) inside the uniqueness rule.
--
-- The predicate covers 'reported' as well as 'open' on purpose. Routing a
-- signal into the moderation queue flips it to 'reported', and if that took it
-- out of the index every later scan would insert a fresh duplicate for a
-- subject already under review. Only a DISMISSED signal steps aside, so that
-- a genuinely new occurrence after a false-positive call opens a new row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fraud_signals_active_subject
    ON fraud_signals (detector, agent_address, COALESCE(asset_id, 0))
    WHERE status <> 'dismissed';

-- The admin risk queue: open signals, worst first.
CREATE INDEX IF NOT EXISTS idx_fraud_signals_queue
    ON fraud_signals (risk_tier, score DESC, id DESC) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS idx_fraud_signals_agent ON fraud_signals (agent_address);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_asset ON fraud_signals (asset_id)
    WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fraud_signals_scan ON fraud_signals (scan_id);
CREATE INDEX IF NOT EXISTS idx_fraud_signals_created_at ON fraud_signals (created_at DESC);

COMMENT ON TABLE fraud_signals IS 'Scored fraud detector output routed into the moderation queue';
COMMENT ON COLUMN fraud_signals.explanation IS 'Human-readable rendering of evidence; non-empty by CHECK so a bare score cannot be stored';
COMMENT ON COLUMN fraud_signals.status IS 'open: awaiting triage, reported: routed to moderation, dismissed: operator-marked false positive';


-- ── agent_funding_sources ────────────────────────────────────────────────────
-- Shared-first-funding is one of the sybil signals, but nothing in the indexer
-- reads Horizon payment history today. This table is the seam: empty by
-- default, and SybilGraphDetector scores the signal at zero when a row is
-- absent rather than assuming innocence or guilt.

CREATE TABLE IF NOT EXISTS agent_funding_sources (
    agent_address    TEXT        PRIMARY KEY,
    -- Address that sent the account's first inbound payment.
    funding_source   TEXT        NOT NULL,
    first_funding_tx TEXT,
    first_funded_at  TIMESTAMPTZ,
    resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_funding_sources_source
    ON agent_funding_sources (funding_source);

COMMENT ON TABLE agent_funding_sources IS 'Optional first-funding lookup for sybil clustering; populated by an out-of-band Horizon backfill';


-- ── reports: accept automated flags ──────────────────────────────────────────
-- The moderation queue already exists; automated findings join it rather than
-- getting a parallel flow. `source` distinguishes them in the admin UI and
-- `evidence` carries the explainability payload from the signal.

ALTER TABLE reports ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
ALTER TABLE reports ADD COLUMN IF NOT EXISTS evidence JSONB;

ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_source_check;
ALTER TABLE reports ADD CONSTRAINT reports_source_check
    CHECK (source IN ('user', 'automated'));

-- Widen the reason enum with the value automated flags file under. The inline
-- CHECK from 005 is named reports_reason_check by Postgres.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_reason_check;
ALTER TABLE reports ADD CONSTRAINT reports_reason_check
    CHECK (reason IN (
        'Spam', 'Plagiarism', 'Malicious', 'Misleading',
        'PolicyViolation', 'AutomatedFraud', 'Other'
    ));

CREATE INDEX IF NOT EXISTS idx_reports_source ON reports (source)
    WHERE source = 'automated';

COMMENT ON COLUMN reports.source IS 'user: filed via the Report Asset flow, automated: raised by the fraud scan';
COMMENT ON COLUMN reports.evidence IS 'Explainability payload copied from the fraud_signal that raised the report';
