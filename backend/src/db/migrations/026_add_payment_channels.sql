-- Bidirectional payment channels indexed from the channels contract, plus
-- the durable backing a production node needs for RevocationStore and
-- Watchtower — both ship as pure in-memory primitives (see
-- backend/src/channels/RevocationStore.js and Watchtower.js) precisely so
-- they can be given a Postgres-backed store here without changing their
-- API, the same split AttestationVerifier's pluggable nonce/index stores
-- already use.

CREATE TABLE IF NOT EXISTS channels (
    id               BIGINT      PRIMARY KEY,        -- on-chain channel_id
    party_a          TEXT        NOT NULL,
    party_b          TEXT        NOT NULL,
    token            TEXT        NOT NULL,
    deposit_a        BIGINT      NOT NULL CHECK (deposit_a >= 0),
    deposit_b        BIGINT      NOT NULL CHECK (deposit_b >= 0),
    status           TEXT        NOT NULL DEFAULT 'Open' CHECK (status IN (
                         'Open', 'Closing', 'Closed'
                     )),
    closer           TEXT,
    dispute_deadline BIGINT,
    indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Metering's "route through a channel when one exists" lookup: at most one
-- open channel per (buyer, seller, token) triple. Older, closed channels
-- between the same pair are left alone — this only constrains what counts
-- as "the" currently usable channel.
CREATE UNIQUE INDEX IF NOT EXISTS uq_channels_open_pair
    ON channels (party_a, party_b, token)
    WHERE status = 'Open';

CREATE INDEX IF NOT EXISTS idx_channels_party_a ON channels (party_a);
CREATE INDEX IF NOT EXISTS idx_channels_party_b ON channels (party_b);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels (status);

-- Every off-chain state either party has fully countersigned, kept so a
-- node can resume ChannelNegotiator's currentState after a restart without
-- asking the counterparty to replay the whole history.
CREATE TABLE IF NOT EXISTS channel_states (
    channel_id           BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    version              BIGINT      NOT NULL CHECK (version >= 0),
    balance_a            BIGINT      NOT NULL CHECK (balance_a >= 0),
    balance_b            BIGINT      NOT NULL CHECK (balance_b >= 0),
    revocation_commit_a  TEXT        NOT NULL,
    revocation_commit_b  TEXT        NOT NULL,
    sig_a                TEXT        NOT NULL,
    sig_b                TEXT        NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, version)
);

-- Durable backing for RevocationStore: one row per (channel, version,
-- party) commitment slot, whether generated locally (commit()) or recorded
-- from the counterparty (recordCommitment()) — `secret` and `revealed`
-- distinguish the two until a reveal actually happens.
CREATE TABLE IF NOT EXISTS revocation_secrets (
    channel_id       BIGINT      NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    version          BIGINT      NOT NULL CHECK (version >= 0),
    party            TEXT        NOT NULL CHECK (party IN ('a', 'b')),
    commitment_hash  TEXT        NOT NULL,
    secret           TEXT,
    revealed         BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, version, party)
);

-- Durable backing for Watchtower: the encrypted-at-rest justice packages a
-- client has registered, keyed the same way the in-memory store is —
-- by commitment_hash, so a node can rebuild its Watchtower Map on restart
-- with no protocol change.
CREATE TABLE IF NOT EXISTS watchtower_blobs (
    commitment_hash  TEXT        PRIMARY KEY,
    iv               TEXT        NOT NULL,
    auth_tag         TEXT        NOT NULL,
    ciphertext       TEXT        NOT NULL,
    channel_id       BIGINT      REFERENCES channels(id) ON DELETE CASCADE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchtower_blobs_channel ON watchtower_blobs (channel_id);
