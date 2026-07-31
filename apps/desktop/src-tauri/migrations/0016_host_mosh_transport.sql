-- Per-host transport preference for Mosh support:
--   'ssh'  — plain SSH (default, previous behavior)
--   'auto' — try Mosh, fall back to SSH with a diagnostic
--   'mosh' — Mosh only
-- Plus optional Mosh settings: a custom remote mosh-server path and a UDP
-- port range ("N" or "N-M") passed to mosh-server as -p.
ALTER TABLE hosts ADD COLUMN transport TEXT NOT NULL DEFAULT 'ssh';
ALTER TABLE hosts ADD COLUMN mosh_server_path TEXT NULL;
ALTER TABLE hosts ADD COLUMN mosh_port_range TEXT NULL;
