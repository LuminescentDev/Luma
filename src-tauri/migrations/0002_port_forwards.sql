CREATE TABLE port_forwards (
    id               TEXT PRIMARY KEY,
    host_id          TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL CHECK (type IN ('local', 'remote', 'dynamic')),
    bind_address     TEXT NOT NULL DEFAULT '127.0.0.1',
    local_port       INTEGER,
    destination_host TEXT,
    destination_port INTEGER,
    remote_port      INTEGER,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_port_forwards_host_id ON port_forwards(host_id);
