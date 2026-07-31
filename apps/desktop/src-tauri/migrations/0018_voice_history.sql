-- Local transcription/draft history for the voice composer. A row is written
-- only when the user explicitly sends a draft, never while they type or dictate,
-- so this table records deliberate actions rather than keystrokes.
--
-- Drafts are user data: they are never logged (see src/storage/voice_history.rs)
-- and never leave the machine.
--
-- Deliberately device-local: no vault_id and no tombstone on delete, so this
-- table is outside the sync surface — a dictated draft cannot be replicated to
-- another device by accident.
CREATE TABLE voice_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    draft      TEXT NOT NULL,
    -- How the draft was produced: 'typed', 'dictated', or 'mixed'. Kept so the
    -- history panel can label entries without inspecting their contents.
    source     TEXT NOT NULL DEFAULT 'typed',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Listing order for the history panel, and the order pruning keeps.
CREATE INDEX idx_voice_history_recent
    ON voice_history(created_at DESC, id DESC);
