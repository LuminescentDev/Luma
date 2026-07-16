CREATE TABLE vault_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt BLOB NOT NULL,
  verifier_nonce BLOB NOT NULL,
  verifier_ciphertext BLOB NOT NULL,
  remember_on_device INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE vault_secrets (
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  secret_type TEXT NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  PRIMARY KEY (owner_type, owner_id, secret_type)
);
