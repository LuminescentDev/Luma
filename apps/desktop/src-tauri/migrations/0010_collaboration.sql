CREATE TABLE collaboration_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_url TEXT NOT NULL,
  device_id TEXT,
  device_public_key TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (
    (device_id IS NULL AND device_public_key IS NULL)
    OR (device_id IS NOT NULL AND device_public_key IS NOT NULL)
  )
);

INSERT INTO collaboration_state (id, server_url)
VALUES (1, 'https://collab.luma.bwmp.dev');
