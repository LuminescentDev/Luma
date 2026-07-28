-- Rename the device-local encrypted secret store from "vault" to "keystore".
-- "Vault" is reserved for the shareable, independently-synced credential scope.
-- The 'encrypted-vault' storage_mode value is wire format and stays unchanged.

ALTER TABLE vault_config RENAME TO keystore_config;
ALTER TABLE vault_secrets RENAME TO keystore_secrets;

-- Declared in 0001 but never read or written by any code path.
DROP TABLE IF EXISTS vault_metadata;
