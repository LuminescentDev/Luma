CREATE TABLE identities (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    username   TEXT NOT NULL,
    key_id     TEXT REFERENCES key_references(id) ON DELETE SET NULL,
    has_password INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE hosts ADD COLUMN identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL;
CREATE INDEX idx_hosts_identity_id ON hosts(identity_id);
