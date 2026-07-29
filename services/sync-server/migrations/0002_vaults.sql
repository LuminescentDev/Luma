CREATE TABLE vaults (
    id            TEXT PRIMARY KEY,
    owner_subject TEXT NOT NULL,
    storage_id    TEXT NOT NULL UNIQUE,
    key_epoch     INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch > 0),
    used_bytes    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at    INTEGER
);

CREATE INDEX idx_vaults_owner ON vaults(owner_subject) WHERE deleted_at IS NULL;

CREATE TABLE vault_members (
    vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    subject    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'writer', 'reader')),
    joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at INTEGER,
    PRIMARY KEY (vault_id, subject)
);

CREATE INDEX idx_vault_members_subject ON vault_members(subject) WHERE revoked_at IS NULL;

-- Devices are registered per subject so an inviter can seal the vault's content
-- key to every device a member actually holds. The public key is the same P-256
-- identity the collaboration client already publishes; it is stored here rather
-- than fetched across services so a sync request never depends on the
-- collaboration server being reachable.
CREATE TABLE vault_devices (
    subject    TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    public_key TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked_at INTEGER,
    PRIMARY KEY (subject, device_id)
);

CREATE TABLE vault_invites (
    id                 TEXT PRIMARY KEY,
    vault_id           TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    secret_hash        TEXT NOT NULL UNIQUE,
    role               TEXT NOT NULL CHECK (role IN ('writer', 'reader')),
    key_epoch          INTEGER NOT NULL CHECK (key_epoch > 0),
    created_by_subject TEXT,
    expires_at         INTEGER NOT NULL,
    revoked_at         INTEGER
);

CREATE INDEX idx_vault_invites_vault ON vault_invites(vault_id);

-- One row per (vault, device, epoch): the content key sealed to that device's
-- public key. Opaque to the server, exactly like the collaboration room keys.
CREATE TABLE vault_member_keys (
    vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    subject      TEXT NOT NULL,
    device_id    TEXT NOT NULL,
    key_epoch    INTEGER NOT NULL CHECK (key_epoch > 0),
    key_envelope TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (vault_id, device_id, key_epoch)
);

CREATE INDEX idx_vault_member_keys_subject ON vault_member_keys(vault_id, subject, key_epoch);
