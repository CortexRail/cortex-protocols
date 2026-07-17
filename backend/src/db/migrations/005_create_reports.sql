-- Moderation reports filed against marketplace assets.

CREATE TABLE IF NOT EXISTS reports (
    id              BIGSERIAL PRIMARY KEY,
    asset_id        BIGINT      NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
    reporter        TEXT        NOT NULL,
    reason          TEXT        NOT NULL CHECK (reason IN (
                        'Spam', 'Plagiarism', 'Malicious', 'Misleading',
                        'PolicyViolation', 'Other'
                    )),
    details         TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'Pending' CHECK (status IN (
                        'Pending', 'UnderReview', 'Resolved', 'Dismissed'
                    )),
    resolution_note TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at     TIMESTAMPTZ
);

-- One open report per reporter per asset keeps spam manageable.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_reporter
    ON reports (asset_id, reporter) WHERE status IN ('Pending', 'UnderReview');

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
CREATE INDEX IF NOT EXISTS idx_reports_asset ON reports (asset_id);
