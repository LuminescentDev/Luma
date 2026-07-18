-- Best-effort, device-local metadata learned from successful SSH sessions.
-- These columns are deliberately excluded from sync payloads: another device
-- can rediscover the remote OS without creating host-edit conflicts.
ALTER TABLE hosts ADD COLUMN os_id TEXT;
ALTER TABLE hosts ADD COLUMN os_pretty_name TEXT;
