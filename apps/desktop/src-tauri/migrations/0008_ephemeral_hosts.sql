ALTER TABLE hosts ADD COLUMN is_ephemeral INTEGER NOT NULL DEFAULT 0
    CHECK (is_ephemeral IN (0, 1));

CREATE INDEX idx_hosts_ephemeral_created_at
    ON hosts(is_ephemeral, created_at);
