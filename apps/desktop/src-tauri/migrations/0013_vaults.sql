-- Vaults: named, independently-synced scopes for hosts, groups, keys,
-- identities and snippets. Every existing row belongs to the personal vault so
-- the personal bundle stays byte-equivalent to what remotes already hold.

CREATE TABLE vaults (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('personal', 'shared')),
    share_secrets INTEGER NOT NULL DEFAULT 0 CHECK (share_secrets IN (0, 1)),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO vaults (id, name, kind, sort_order) VALUES ('personal', 'Personal', 'personal', 0);

-- No REFERENCES clause on these five: SQLite refuses to add a column with both
-- a foreign key and a non-NULL default to a table that already holds rows, and
-- every upgrading install does. NOT NULL is the constraint worth keeping here —
-- a row with no vault is invisible to every vault-scoped query — while an
-- unknown vault id is rejected at the boundary by storage::vaults::require.
ALTER TABLE hosts          ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE host_groups    ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE key_references ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE identities     ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE snippets       ADD COLUMN vault_id TEXT NOT NULL DEFAULT 'personal';

CREATE INDEX idx_hosts_vault_id ON hosts(vault_id);
CREATE INDEX idx_host_groups_vault_id ON host_groups(vault_id);
CREATE INDEX idx_key_references_vault_id ON key_references(vault_id);
CREATE INDEX idx_identities_vault_id ON identities(vault_id);
CREATE INDEX idx_snippets_vault_id ON snippets(vault_id);

-- Tombstones are keyed per vault: the same object type and id may legitimately
-- be deleted in two vaults. SQLite cannot alter a primary key, so rebuild.
CREATE TABLE tombstones_new (
    vault_id    TEXT NOT NULL DEFAULT 'personal' REFERENCES vaults(id),
    object_type TEXT NOT NULL,
    object_id   TEXT NOT NULL,
    deleted_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (vault_id, object_type, object_id)
);

INSERT INTO tombstones_new (vault_id, object_type, object_id, deleted_at)
SELECT 'personal', object_type, object_id, deleted_at FROM tombstones;

DROP TABLE tombstones;
ALTER TABLE tombstones_new RENAME TO tombstones;
