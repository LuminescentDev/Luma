CREATE TABLE accounts (
    subject       TEXT PRIMARY KEY,
    storage_id    TEXT NOT NULL UNIQUE,
    quota_bytes   INTEGER NOT NULL,
    used_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at    INTEGER
);

CREATE INDEX idx_accounts_storage_id ON accounts(storage_id);
