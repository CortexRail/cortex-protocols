-- Index the current marketplace asset version and the version selected by a
-- license purchase. Existing rows are backfilled to the contract's legacy
-- version (1) by the NOT NULL defaults.

ALTER TABLE assets
    ADD COLUMN version BIGINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT assets_version_positive CHECK (version >= 1);

ALTER TABLE licenses
    ADD COLUMN asset_version BIGINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT licenses_asset_version_positive CHECK (asset_version >= 1);
