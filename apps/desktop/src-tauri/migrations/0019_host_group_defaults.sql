-- Group-level configuration inheritance.
--
-- A host group can now carry defaults for the hosts inside it. Every column is
-- nullable and NULL means "this group sets no default", so resolution keeps
-- walking up `parent_id` until some ancestor sets the field (or the built-in
-- default applies). The `hosts` table is deliberately untouched: a host row
-- still stores exactly what the user typed into that host, and inheritance is
-- computed at read time.
--
-- `auth_type` and `key_id` are intentionally absent. They are NOT NULL /
-- credential-bearing on hosts, so there is no way to tell "the user chose
-- interactive" apart from "the user never touched it", and guessing wrong
-- would silently change how a host authenticates. Groups express credentials
-- through `identity_id` (and `username`) instead.
ALTER TABLE host_groups ADD COLUMN username TEXT NULL;
ALTER TABLE host_groups ADD COLUMN identity_id TEXT NULL REFERENCES identities(id) ON DELETE SET NULL;
ALTER TABLE host_groups ADD COLUMN proxy_jump_host_id TEXT NULL REFERENCES hosts(id) ON DELETE SET NULL;
ALTER TABLE host_groups ADD COLUMN startup_command TEXT NULL;
ALTER TABLE host_groups ADD COLUMN working_directory TEXT NULL;
ALTER TABLE host_groups ADD COLUMN environment TEXT NULL; -- JSON object
ALTER TABLE host_groups ADD COLUMN tab_color TEXT NULL;
ALTER TABLE host_groups ADD COLUMN transport TEXT NULL
    CHECK (transport IS NULL OR transport IN ('ssh', 'auto', 'mosh'));
ALTER TABLE host_groups ADD COLUMN mosh_server_path TEXT NULL;
ALTER TABLE host_groups ADD COLUMN mosh_port_range TEXT NULL;
