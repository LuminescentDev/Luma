-- Managed vaults: shared vaults whose content key Luma Cloud distributes,
-- sealed to each member device, instead of members passing a passphrase around.
--
-- A managed vault *is* a shared vault — the two differ only in how the key is
-- obtained — so `kind` stays 'shared' and the presence of `remote_vault_id` is
-- what makes it managed. That keeps this migration to two ADD COLUMNs: relaxing
-- the `kind` CHECK would mean rebuilding `vaults`, and `sync_state.vault_id`
-- references it, so dropping the old table trips foreign key enforcement.
--
-- `remote_vault_id` is the vault's identity on the server, separate from the
-- local id because a vault joined on two machines has one server id and two
-- local rows. `key_epoch` records which generation of the content key this
-- device holds, so a rotation is noticed rather than silently failing to
-- decrypt.

ALTER TABLE vaults ADD COLUMN remote_vault_id TEXT;
ALTER TABLE vaults ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX idx_vaults_remote_id ON vaults(remote_vault_id)
    WHERE remote_vault_id IS NOT NULL;
