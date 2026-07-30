-- Command history feeding the (opt-in, off by default) terminal autocomplete
-- overlay. Commands are user data: they are recorded only while the setting is
-- on, never logged, and lines that look secret-bearing are dropped before they
-- reach this table (see src/storage/command_history.rs).
--
-- `scope_key` partitions history by where the command ran — "host:<id>" for an
-- SSH/Mosh session, "local:<shell-or-profile-id>" for a local shell — so a
-- host's history never leaks suggestions into an unrelated session.
--
-- Deliberately device-local: no vault_id and no tombstone on delete, so this
-- table is outside the sync surface and never leaves the machine.
CREATE TABLE command_history (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key    TEXT NOT NULL,
    command      TEXT NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT (unixepoch()),
    use_count    INTEGER NOT NULL DEFAULT 1
);

-- Dedup target: recording an already-seen command bumps use_count/last_used_at
-- through ON CONFLICT rather than appending a row.
CREATE UNIQUE INDEX idx_command_history_scope_command
    ON command_history(scope_key, command);

-- Ranking order for the overlay's prefix query, and the order pruning keeps.
CREATE INDEX idx_command_history_scope_rank
    ON command_history(scope_key, use_count DESC, last_used_at DESC);
