-- Heartbeat table written every few seconds by the primary so replicas can
-- measure replication lag even when pg_stat_replication is unavailable.

CREATE TABLE IF NOT EXISTS replica_heartbeat (
    id          INTEGER PRIMARY KEY DEFAULT 1,
    written_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed a single row so INSERT … ON CONFLICT always works.
INSERT INTO replica_heartbeat (id, written_at) VALUES (1, now())
    ON CONFLICT (id) DO NOTHING;
