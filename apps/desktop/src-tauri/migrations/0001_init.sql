-- Luma initial schema.
-- Secrets (passwords, passphrases, private keys) are never stored in these
-- tables; they live in the OS keychain or the encrypted vault.

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL, -- JSON
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE host_groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE key_references (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    public_key   TEXT,
    storage_mode TEXT NOT NULL DEFAULT 'local-path'
                 CHECK (storage_mode IN ('local-path', 'encrypted-vault', 'ssh-agent')),
    local_path   TEXT,
    fingerprint  TEXT,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE hosts (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    hostname           TEXT NOT NULL,
    port               INTEGER NOT NULL DEFAULT 22,
    username           TEXT,
    group_id           TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
    auth_type          TEXT NOT NULL DEFAULT 'agent'
                       CHECK (auth_type IN ('agent', 'key', 'password', 'interactive')),
    key_id             TEXT REFERENCES key_references(id) ON DELETE SET NULL,
    proxy_jump_host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    startup_command    TEXT,
    working_directory  TEXT,
    environment        TEXT, -- JSON object
    tags               TEXT NOT NULL DEFAULT '[]', -- JSON array
    favorite           INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_hosts_group_id ON hosts(group_id);
CREATE INDEX idx_hosts_name ON hosts(name);

CREATE TABLE terminal_profiles (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    shell_path        TEXT NOT NULL,
    args              TEXT NOT NULL DEFAULT '[]', -- JSON array
    working_directory TEXT,
    environment       TEXT, -- JSON object
    platform          TEXT CHECK (platform IN ('windows', 'macos', 'linux')),
    is_default        INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at        INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE snippets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    command     TEXT NOT NULL,
    description TEXT,
    tags        TEXT NOT NULL DEFAULT '[]', -- JSON array
    variables   TEXT NOT NULL DEFAULT '[]', -- JSON array
    host_id     TEXT REFERENCES hosts(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE recent_connections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id      TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    connected_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_recent_connections_host_id ON recent_connections(host_id);

CREATE TABLE sync_state (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    device_id      TEXT NOT NULL,
    provider       TEXT,
    last_synced_at INTEGER,
    state          TEXT -- JSON, provider-specific non-secret state
);

CREATE TABLE vault_metadata (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    kdf        TEXT NOT NULL DEFAULT 'argon2id',
    kdf_params TEXT NOT NULL, -- JSON: memory, iterations, parallelism
    salt       BLOB NOT NULL,
    verifier   BLOB NOT NULL, -- MAC to verify a passphrase without decrypting data
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Deleted-object tombstones preserved for sync conflict handling.
CREATE TABLE tombstones (
    object_type TEXT NOT NULL,
    object_id   TEXT NOT NULL,
    deleted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (object_type, object_id)
);
