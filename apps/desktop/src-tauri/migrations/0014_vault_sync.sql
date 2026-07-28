-- Per-vault sync: every vault carries its own provider, remote state and
-- baseline. The pre-existing configuration moves to the personal vault so the
-- remote it already points at keeps working with no re-upload.

-- The device id identifies this installation to every remote, not one vault,
-- so it outlives the sync_state rebuild in its own single-row table.
CREATE TABLE device_state (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    device_id TEXT NOT NULL
);

INSERT INTO device_state (id, device_id)
SELECT 1, device_id FROM sync_state WHERE id = 1;

-- SQLite cannot alter a primary key, and CHECK (id = 1) is exactly what has to
-- go, so rebuild keyed on vault_id.
CREATE TABLE sync_state_new (
    vault_id       TEXT PRIMARY KEY REFERENCES vaults(id),
    provider       TEXT,
    last_synced_at INTEGER,
    state          TEXT -- JSON, provider-specific non-secret state
);

INSERT INTO sync_state_new (vault_id, provider, last_synced_at, state)
SELECT 'personal', provider, last_synced_at, state FROM sync_state WHERE id = 1;

DROP TABLE sync_state;
ALTER TABLE sync_state_new RENAME TO sync_state;

-- Secret sharing is a per-vault property now. Carry the old global opt-in onto
-- the personal vault so a user who enabled it does not silently lose key sync.
UPDATE vaults SET share_secrets = 1, updated_at = unixepoch()
WHERE id = 'personal'
  AND EXISTS (
      SELECT 1 FROM settings
      WHERE key = 'sync.includePrivateKeys' AND value = 'true'
  );
