#[cfg(not(any(target_os = "android", target_os = "ios")))]
use keyring::Entry;
use pkcs8::der::pem::PemLabel;
use pkcs8::der::SecretDocument;
use pkcs8::{DecodePrivateKey as _, EncryptedPrivateKeyInfo};
use rsa::pkcs1::DecodeRsaPrivateKey as _;
use serde::{Deserialize, Serialize};
use sqlx::{Executor, Row, Sqlite, SqlitePool};
use ssh_key::{HashAlg, PrivateKey, PublicKey};
use zeroize::{Zeroize, Zeroizing};

use crate::errors::{LumaError, Result};

const MAX_NAME_LENGTH: usize = 128;
const MAX_PATH_LENGTH: usize = 4096;
const MAX_PUBLIC_KEY_LENGTH: usize = 64 * 1024;
const MAX_PRIVATE_KEY_LENGTH: usize = 1024 * 1024;
const MAX_FINGERPRINT_LENGTH: usize = 512;
const MAX_PASSPHRASE_LENGTH: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReference {
    pub id: String,
    pub name: String,
    pub public_key: Option<String>,
    pub storage_mode: String,
    pub local_path: Option<String>,
    pub fingerprint: Option<String>,
    pub certificate: Option<String>,
    pub has_private_key: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReferenceInput {
    pub name: String,
    pub public_key: Option<String>,
    pub storage_mode: String,
    pub local_path: Option<String>,
    pub fingerprint: Option<String>,
    pub certificate: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
}

impl Drop for KeyReferenceInput {
    fn drop(&mut self) {
        if let Some(private_key) = &mut self.private_key {
            private_key.zeroize();
        }
        if let Some(passphrase) = &mut self.passphrase {
            passphrase.zeroize();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedPublicKey {
    pub public_key: String,
    pub fingerprint: String,
}

fn encode_public_key(mut public_key: PublicKey) -> Result<DerivedPublicKey> {
    public_key.set_comment("");
    let fingerprint = public_key.fingerprint(HashAlg::Sha256).to_string();
    let public_key = public_key.to_openssh().map_err(|_| {
        LumaError::InvalidInput("could not encode the derived SSH public key".into())
    })?;
    Ok(DerivedPublicKey {
        public_key,
        fingerprint,
    })
}

fn public_key_from_rsa(private_key: &rsa::RsaPrivateKey) -> Result<PublicKey> {
    let rsa_public = rsa::RsaPublicKey::from(private_key);
    let ssh_public = ssh_key::public::RsaPublicKey::try_from(rsa_public).map_err(|_| {
        LumaError::InvalidInput(
            "could not derive an SSH public key from the RSA private key".into(),
        )
    })?;
    Ok(PublicKey::from(ssh_public))
}

fn public_key_from_ed25519(private_key: &ed25519_dalek::SigningKey) -> PublicKey {
    let ssh_public = ssh_key::public::Ed25519PublicKey::from(private_key.verifying_key());
    PublicKey::from(ssh_public)
}

fn parse_unencrypted_pem(private_key: &str) -> Option<Result<PublicKey>> {
    if private_key.contains("-----BEGIN RSA PRIVATE KEY-----")
        && !private_key.contains("Proc-Type: 4,ENCRYPTED")
    {
        return Some(
            rsa::RsaPrivateKey::from_pkcs1_pem(private_key)
                .map_err(|_| {
                    LumaError::InvalidInput(
                        "private key could not be parsed as an RSA PEM private key".into(),
                    )
                })
                .and_then(|private_key| public_key_from_rsa(&private_key)),
        );
    }

    if private_key.contains("-----BEGIN PRIVATE KEY-----") {
        if let Ok(rsa_key) = rsa::RsaPrivateKey::from_pkcs8_pem(private_key) {
            return Some(public_key_from_rsa(&rsa_key));
        }
        if let Ok(ed25519_key) = ed25519_dalek::SigningKey::from_pkcs8_pem(private_key) {
            return Some(Ok(public_key_from_ed25519(&ed25519_key)));
        }
        return Some(Err(LumaError::InvalidInput(
            "private key could not be parsed as an RSA or ed25519 PKCS#8 private key".into(),
        )));
    }

    None
}

fn parse_encrypted_pkcs8(private_key: &str, passphrase: Option<&str>) -> Option<Result<PublicKey>> {
    if !private_key.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return None;
    }
    let Some(passphrase) = passphrase.filter(|value| !value.is_empty()) else {
        return Some(Err(LumaError::InvalidInput(
            "private key is encrypted and requires a passphrase".into(),
        )));
    };

    let decrypted = (|| {
        let (label, document) = SecretDocument::from_pem(private_key).map_err(|_| {
            LumaError::InvalidInput("encrypted private key PEM is malformed".into())
        })?;
        EncryptedPrivateKeyInfo::validate_pem_label(label).map_err(|_| {
            LumaError::InvalidInput("encrypted private key PEM is malformed".into())
        })?;
        let encrypted = EncryptedPrivateKeyInfo::try_from(document.as_bytes()).map_err(|_| {
            LumaError::InvalidInput("encrypted private key PEM is malformed".into())
        })?;
        encrypted.decrypt(passphrase).map_err(|_| {
            LumaError::InvalidInput(
                "could not decrypt private key; the passphrase is incorrect or the encryption is unsupported"
                    .into(),
            )
        })
    })();

    Some(decrypted.and_then(|document| {
        if let Ok(rsa_key) = rsa::RsaPrivateKey::from_pkcs8_der(document.as_bytes()) {
            return public_key_from_rsa(&rsa_key);
        }
        if let Ok(ed25519_key) = ed25519_dalek::SigningKey::from_pkcs8_der(document.as_bytes()) {
            return Ok(public_key_from_ed25519(&ed25519_key));
        }
        Err(LumaError::InvalidInput(
            "decrypted private key is not a supported RSA or ed25519 PKCS#8 key".into(),
        ))
    }))
}

fn normalize_private_key(private_key: &str) -> Zeroizing<String> {
    let unescape_newlines = !private_key.contains(['\r', '\n']) && private_key.contains("\\n");
    let mut normalized = Zeroizing::new(String::with_capacity(private_key.len()));
    let mut chars = private_key.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                normalized.push('\n');
            }
            '\\' if unescape_newlines && chars.peek() == Some(&'n') => {
                chars.next();
                normalized.push('\n');
            }
            _ => normalized.push(character),
        }
    }
    normalized
}

pub fn derive_public_key(private_key: &str, passphrase: Option<&str>) -> Result<DerivedPublicKey> {
    if private_key.trim().is_empty() {
        return Err(LumaError::InvalidInput("privateKey is required".into()));
    }
    if private_key.len() > MAX_PRIVATE_KEY_LENGTH || private_key.contains('\0') {
        return Err(LumaError::InvalidInput(
            "privateKey is too large or contains a null character".into(),
        ));
    }
    if passphrase.is_some_and(|value| value.len() > MAX_PASSPHRASE_LENGTH) {
        return Err(LumaError::InvalidInput("passphrase is too large".into()));
    }

    let private_key = private_key.trim_start_matches('\u{feff}').trim();
    let normalized = normalize_private_key(private_key);

    if let Ok(private_key) = PrivateKey::from_openssh(normalized.as_str()) {
        return encode_public_key(private_key.public_key().clone());
    }
    if let Some(public_key) = parse_unencrypted_pem(&normalized) {
        return encode_public_key(public_key?);
    }
    if let Some(public_key) = parse_encrypted_pkcs8(&normalized, passphrase) {
        return encode_public_key(public_key?);
    }
    if normalized.contains("Proc-Type: 4,ENCRYPTED") {
        return Err(LumaError::InvalidInput(
            "legacy encrypted RSA PEM is unsupported; convert it to OpenSSH or encrypted PKCS#8 format"
                .into(),
        ));
    }

    Err(LumaError::InvalidInput(
        "private key could not be parsed; provide an RSA or ed25519 private key in OpenSSH or PEM format"
            .into(),
    ))
}

pub(crate) fn apply_derived_vault_metadata(input: &mut KeyReferenceInput) -> Result<()> {
    if input.storage_mode != "encrypted-vault" {
        return Ok(());
    }
    let Some(private_key) = input
        .private_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };
    let derived = derive_public_key(private_key, input.passphrase.as_deref())?;
    input.public_key = Some(derived.public_key);
    input.fingerprint = Some(derived.fingerprint);
    Ok(())
}

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub(crate) fn validate(input: &KeyReferenceInput) -> Result<()> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH || name.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "key reference name must be 1-{MAX_NAME_LENGTH} characters"
        )));
    }
    if !matches!(
        input.storage_mode.as_str(),
        "local-path" | "encrypted-vault" | "ssh-agent"
    ) {
        return Err(LumaError::InvalidInput(
            "storageMode must be 'local-path', 'encrypted-vault', or 'ssh-agent'".into(),
        ));
    }
    let local_path = input.local_path.as_deref().map(str::trim);
    if input.storage_mode == "local-path" && local_path.is_none_or(str::is_empty) {
        return Err(LumaError::InvalidInput(
            "local-path storage requires localPath".into(),
        ));
    }
    if local_path.is_some_and(|path| path.len() > MAX_PATH_LENGTH || path.contains('\0')) {
        return Err(LumaError::InvalidInput(
            "localPath is too large or contains a null character".into(),
        ));
    }
    let derives_metadata = input.storage_mode == "encrypted-vault"
        && input
            .private_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    if !derives_metadata {
        if let Some(public_key) = &input.public_key {
            if public_key.len() > MAX_PUBLIC_KEY_LENGTH || public_key.contains('\0') {
                return Err(LumaError::InvalidInput(
                    "publicKey is too large or contains a null character".into(),
                ));
            }
            if public_key.to_ascii_uppercase().contains("PRIVATE KEY") {
                return Err(LumaError::InvalidInput(
                    "private key contents must never be stored; provide only a public key".into(),
                ));
            }
        }
        if input
            .fingerprint
            .as_ref()
            .is_some_and(|value| value.len() > MAX_FINGERPRINT_LENGTH || value.contains('\0'))
        {
            return Err(LumaError::InvalidInput(
                "fingerprint is too large or contains a null character".into(),
            ));
        }
    }
    if input
        .private_key
        .as_ref()
        .is_some_and(|value| value.len() > MAX_PRIVATE_KEY_LENGTH || value.contains('\0'))
    {
        return Err(LumaError::InvalidInput(
            "privateKey is too large or contains a null character".into(),
        ));
    }
    if input
        .passphrase
        .as_ref()
        .is_some_and(|value| value.len() > MAX_PASSPHRASE_LENGTH)
    {
        return Err(LumaError::InvalidInput("passphrase is too large".into()));
    }
    Ok(())
}

fn row_to_key_reference(row: &sqlx::sqlite::SqliteRow) -> KeyReference {
    KeyReference {
        id: row.get("id"),
        name: row.get("name"),
        public_key: row.get("public_key"),
        storage_mode: row.get("storage_mode"),
        local_path: row.get("local_path"),
        fingerprint: row.get("fingerprint"),
        certificate: row.get("certificate"),
        has_private_key: row.get::<i64, _>("has_private_key") != 0,
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<KeyReference>> {
    let rows = sqlx::query(
        "SELECT id, name, public_key, storage_mode, local_path, fingerprint, certificate, has_private_key
         FROM key_references ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_key_reference).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<KeyReference>> {
    let row = sqlx::query(
        "SELECT id, name, public_key, storage_mode, local_path, fingerprint, certificate, has_private_key
         FROM key_references WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(row_to_key_reference))
}

pub(crate) fn validate_create(input: &KeyReferenceInput) -> Result<()> {
    validate(input)?;
    if input.storage_mode == "encrypted-vault"
        && input
            .private_key
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
    {
        return Err(LumaError::InvalidInput(
            "encrypted-vault storage requires privateKey".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
pub async fn create(pool: &SqlitePool, input: KeyReferenceInput) -> Result<KeyReference> {
    validate_create(&input)?;
    create_validated(pool, input, true).await
}

#[cfg(test)]
pub(crate) async fn create_metadata(
    pool: &SqlitePool,
    input: KeyReferenceInput,
) -> Result<KeyReference> {
    validate(&input)?;
    let id = insert_metadata(pool, input, false).await?;
    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("key reference creation failed".into()))
}

fn prepare_metadata_input(mut input: KeyReferenceInput) -> Result<KeyReferenceInput> {
    apply_derived_vault_metadata(&mut input)?;
    validate(&input)?;
    input.public_key = optional_trimmed(input.public_key.take());
    input.local_path = optional_trimmed(input.local_path.take());
    input.fingerprint = optional_trimmed(input.fingerprint.take());
    input.certificate = optional_trimmed(input.certificate.take());
    if input.storage_mode == "ssh-agent" {
        input.local_path = None;
    }
    Ok(input)
}

pub(crate) async fn insert_metadata<'e, E>(
    executor: E,
    input: KeyReferenceInput,
    has_private_key: bool,
) -> Result<String>
where
    E: Executor<'e, Database = Sqlite>,
{
    let input = prepare_metadata_input(input)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO key_references
             (id, name, public_key, storage_mode, local_path, fingerprint, certificate, has_private_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.public_key)
    .bind(&input.storage_mode)
    .bind(&input.local_path)
    .bind(&input.fingerprint)
    .bind(&input.certificate)
    .bind(has_private_key)
    .execute(executor)
    .await?;
    Ok(id)
}

#[cfg(test)]
async fn create_validated(
    pool: &SqlitePool,
    input: KeyReferenceInput,
    store_credentials: bool,
) -> Result<KeyReference> {
    let input = prepare_metadata_input(input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let has_private_key = if store_credentials {
        let stored =
            store_chunked_secret("luma.ssh.key.private", &id, input.private_key.as_deref())?;
        let _ = store_secret("luma.ssh.key.passphrase", &id, input.passphrase.as_deref())?;
        stored
    } else {
        false
    };
    sqlx::query(
        "INSERT INTO key_references
             (id, name, public_key, storage_mode, local_path, fingerprint, certificate, has_private_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.public_key)
    .bind(&input.storage_mode)
    .bind(&input.local_path)
    .bind(&input.fingerprint)
    .bind(&input.certificate)
    .bind(has_private_key)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("key reference creation failed".into()))
}

pub(crate) async fn update_metadata<'e, E>(
    executor: E,
    id: &str,
    input: KeyReferenceInput,
    has_private_key: bool,
) -> Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    let input = prepare_metadata_input(input)?;
    let result = sqlx::query(
        "UPDATE key_references SET
             name = ?2, public_key = ?3, storage_mode = ?4, local_path = ?5,
             fingerprint = ?6, certificate = ?7, has_private_key = ?8, updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(&input.public_key)
    .bind(&input.storage_mode)
    .bind(&input.local_path)
    .bind(&input.fingerprint)
    .bind(&input.certificate)
    .bind(has_private_key)
    .execute(executor)
    .await?;
    if result.rows_affected() != 1 {
        return Err(LumaError::InvalidInput("unknown key reference".into()));
    }
    Ok(())
}

#[cfg(test)]
pub async fn update(pool: &SqlitePool, id: &str, input: KeyReferenceInput) -> Result<KeyReference> {
    validate(&input)?;
    let current = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown key reference".into()))?;
    let has_private_key = match input.private_key.as_deref() {
        None => current.has_private_key,
        value => store_chunked_secret("luma.ssh.key.private", id, value)?,
    };
    if input.passphrase.is_some() {
        let _ = store_secret("luma.ssh.key.passphrase", id, input.passphrase.as_deref())?;
    }
    update_metadata(pool, id, input, has_private_key).await?;
    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown key reference".into()))
}

pub(crate) async fn delete_metadata(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    id: &str,
) -> Result<()> {
    let result = sqlx::query("DELETE FROM key_references WHERE id = ?1")
        .bind(id)
        .execute(&mut **transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown key reference".into()));
    }
    sqlx::query(
        "INSERT INTO tombstones (object_type, object_id, deleted_at)
         VALUES ('key_reference', ?1, unixepoch())
         ON CONFLICT(object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
    )
    .bind(id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[cfg(test)]
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    delete_metadata(&mut transaction, id).await?;
    transaction.commit().await?;
    purge_secrets(id);
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn purge_secrets(id: &str) {
    delete_chunked_secret("luma.ssh.key.private", id);
    let _ = Entry::new("luma.ssh.key.passphrase", id).and_then(|entry| entry.delete_credential());
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn purge_secrets(_id: &str) {}

#[cfg(test)]
fn store_secret(service: &str, id: &str, value: Option<&str>) -> Result<bool> {
    let entry = Entry::new(service, id)
        .map_err(|e| LumaError::InvalidInput(format!("credential store unavailable: {e}")))?;
    match value {
        Some(value) if !value.is_empty() => {
            entry
                .set_password(value)
                .map_err(|e| LumaError::InvalidInput(format!("could not store key secret: {e}")))?;
            Ok(true)
        }
        Some(_) => {
            let _ = entry.delete_credential();
            Ok(false)
        }
        None => Ok(false),
    }
}

// Windows Credential Manager limits each credential blob to 2560 UTF-16
// characters. Private keys can exceed that, so keep them in conservative
// chunks and store the chunk count in a small manifest credential.
#[cfg(test)]
fn store_chunked_secret(service: &str, id: &str, value: Option<&str>) -> Result<bool> {
    if value.is_none() {
        return Ok(false);
    }
    delete_chunked_secret(service, id);
    let value = value.unwrap_or_default();
    if value.is_empty() {
        return Ok(false);
    }
    let chars = Zeroizing::new(value.chars().collect::<Vec<char>>());
    let chunks: Vec<Zeroizing<String>> = chars
        .chunks(1800)
        .map(|chunk| Zeroizing::new(chunk.iter().collect()))
        .collect();
    for (index, chunk) in chunks.iter().enumerate() {
        Entry::new(service, &format!("{id}:chunk:{index}"))
            .map_err(|e| LumaError::InvalidInput(format!("credential store unavailable: {e}")))?
            .set_password(chunk)
            .map_err(|e| {
                LumaError::InvalidInput(format!("could not store private key chunk: {e}"))
            })?;
    }
    Entry::new(service, id)
        .map_err(|e| LumaError::InvalidInput(format!("credential store unavailable: {e}")))?
        .set_password(&chunks.len().to_string())
        .map_err(|e| {
            LumaError::InvalidInput(format!("could not store private key manifest: {e}"))
        })?;
    Ok(true)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn delete_chunked_secret(service: &str, id: &str) {
    let count = Entry::new(service, id)
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(64)
        .min(64);
    for index in 0..count {
        let _ = Entry::new(service, &format!("{id}:chunk:{index}"))
            .and_then(|entry| entry.delete_credential());
    }
    let _ = Entry::new(service, id).and_then(|entry| entry.delete_credential());
}

#[cfg(test)]
mod tests {
    use super::*;
    use pkcs8::EncodePrivateKey as _;
    use rand::{rngs::OsRng, RngCore};
    use rsa::pkcs1::EncodeRsaPrivateKey as _;
    use ssh_key::{Algorithm, LineEnding};

    fn authoritative_values(private_key: &PrivateKey) -> DerivedPublicKey {
        let mut public_key = private_key.public_key().clone();
        public_key.set_comment("");
        DerivedPublicKey {
            fingerprint: public_key.fingerprint(HashAlg::Sha256).to_string(),
            public_key: public_key.to_openssh().unwrap(),
        }
    }

    async fn assert_vault_import_stores_authoritative_metadata(
        pool: &SqlitePool,
        name: &str,
        private_key: &str,
        passphrase: Option<&str>,
        expected: &DerivedPublicKey,
    ) {
        let input = KeyReferenceInput {
            name: name.into(),
            public_key: Some("ssh-ed25519 AAAA unrelated caller value".into()),
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: Some("SHA256:unrelated-caller-value".into()),
            certificate: None,
            private_key: Some(private_key.into()),
            passphrase: passphrase.map(str::to_owned),
        };
        validate_create(&input).unwrap();
        let stored = create_metadata(pool, input).await.unwrap();
        assert_eq!(
            stored.public_key.as_deref(),
            Some(expected.public_key.as_str())
        );
        assert_eq!(
            stored.fingerprint.as_deref(),
            Some(expected.fingerprint.as_str())
        );

        let row: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT public_key, fingerprint FROM key_references WHERE id = ?1")
                .bind(&stored.id)
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(row.0.as_deref(), Some(expected.public_key.as_str()));
        assert_eq!(row.1.as_deref(), Some(expected.fingerprint.as_str()));
    }

    #[tokio::test]
    async fn vault_imports_derive_rsa_and_ed25519_metadata_from_private_keys() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let mut rng = OsRng;
        let rsa = PrivateKey::random(&mut rng, Algorithm::Rsa { hash: None }).unwrap();
        let ed25519 = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();

        for (name, private_key) in [("RSA", &rsa), ("ed25519", &ed25519)] {
            let expected = authoritative_values(private_key);
            let unencrypted = private_key.to_openssh(LineEnding::LF).unwrap();
            assert_vault_import_stores_authoritative_metadata(
                &pool,
                &format!("{name} unencrypted"),
                &unencrypted,
                None,
                &expected,
            )
            .await;

            let encrypted = private_key
                .encrypt(&mut rng, b"correct horse battery staple")
                .unwrap()
                .to_openssh(LineEnding::LF)
                .unwrap();
            assert_vault_import_stores_authoritative_metadata(
                &pool,
                &format!("{name} encrypted"),
                &encrypted,
                Some("correct horse battery staple"),
                &expected,
            )
            .await;
        }
    }

    #[tokio::test]
    async fn vault_update_replaces_existing_mismatched_metadata() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let mut rng = OsRng;
        let private_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let expected = authoritative_values(&private_key);
        let private_key = private_key.to_openssh(LineEnding::LF).unwrap();
        let existing = create_metadata(
            &pool,
            KeyReferenceInput {
                name: "Existing mismatched key".into(),
                public_key: Some("ssh-rsa AAAA stale value".into()),
                storage_mode: "encrypted-vault".into(),
                local_path: None,
                fingerprint: Some("SHA256:stale-value".into()),
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();

        let mut input = KeyReferenceInput {
            name: existing.name.clone(),
            public_key: existing.public_key.clone(),
            storage_mode: existing.storage_mode.clone(),
            local_path: existing.local_path.clone(),
            fingerprint: existing.fingerprint.clone(),
            certificate: existing.certificate.clone(),
            private_key: Some(private_key.to_string()),
            passphrase: None,
        };
        apply_derived_vault_metadata(&mut input).unwrap();
        let private_key = input.private_key.take().map(Zeroizing::new);
        let updated = update(&pool, &existing.id, input).await.unwrap();

        assert!(private_key.is_some());
        assert_eq!(
            updated.public_key.as_deref(),
            Some(expected.public_key.as_str())
        );
        assert_eq!(
            updated.fingerprint.as_deref(),
            Some(expected.fingerprint.as_str())
        );
    }

    #[test]
    fn unencrypted_rsa_pem_and_rsa_and_ed25519_pkcs8_are_supported() {
        let mut rng = OsRng;
        let rsa_key = rsa::RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let rsa_expected = encode_public_key(public_key_from_rsa(&rsa_key).unwrap()).unwrap();
        let rsa_pem = rsa_key.to_pkcs1_pem(pkcs8::LineEnding::LF).unwrap();
        let rsa_pkcs8 = rsa_key.to_pkcs8_pem(pkcs8::LineEnding::LF).unwrap();
        assert_eq!(derive_public_key(&rsa_pem, None).unwrap(), rsa_expected);
        assert_eq!(derive_public_key(&rsa_pkcs8, None).unwrap(), rsa_expected);

        let mut seed = [0_u8; 32];
        rng.fill_bytes(&mut seed);
        let ed25519_key = ed25519_dalek::SigningKey::from_bytes(&seed);
        seed.zeroize();
        let ed25519_expected = encode_public_key(public_key_from_ed25519(&ed25519_key)).unwrap();
        let ed25519_pkcs8 = ed25519_key.to_pkcs8_pem(pkcs8::LineEnding::LF).unwrap();
        assert_eq!(
            derive_public_key(&ed25519_pkcs8, None).unwrap(),
            ed25519_expected
        );
    }

    #[test]
    fn encrypted_openssh_public_key_derivation_does_not_need_the_passphrase() {
        let mut rng = OsRng;
        let private_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let expected = authoritative_values(&private_key);
        let encrypted = private_key
            .encrypt(&mut rng, b"actual passphrase")
            .unwrap()
            .to_openssh(LineEnding::LF)
            .unwrap();

        assert_eq!(derive_public_key(&encrypted, None).unwrap(), expected);
        assert_eq!(
            derive_public_key(&encrypted, Some("wrong passphrase")).unwrap(),
            expected
        );
    }

    #[test]
    fn encrypted_pkcs8_reports_missing_and_incorrect_passphrases() {
        let mut rng = OsRng;
        let rsa_key = rsa::RsaPrivateKey::new(&mut rng, 2048).unwrap();
        let encrypted = rsa_key
            .to_pkcs8_encrypted_pem(&mut rng, "actual passphrase", pkcs8::LineEnding::LF)
            .unwrap();

        let missing = derive_public_key(&encrypted, None).unwrap_err();
        assert_eq!(missing.category(), "invalid-input");
        assert_eq!(
            missing.to_string(),
            "invalid input: private key is encrypted and requires a passphrase"
        );

        let incorrect = derive_public_key(&encrypted, Some("wrong passphrase")).unwrap_err();
        assert_eq!(incorrect.category(), "invalid-input");
        assert_eq!(
            incorrect.to_string(),
            "invalid input: could not decrypt private key; the passphrase is incorrect or the encryption is unsupported"
        );

        let derived = derive_public_key(&encrypted, Some("actual passphrase")).unwrap();
        assert!(derived.public_key.starts_with("ssh-rsa "));
        assert!(derived.fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn encrypted_ed25519_pkcs8_is_supported() {
        let mut rng = OsRng;
        let mut seed = [0_u8; 32];
        rng.fill_bytes(&mut seed);
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        seed.zeroize();
        let encrypted = key
            .to_pkcs8_encrypted_pem(&mut rng, "ed25519 passphrase", pkcs8::LineEnding::LF)
            .unwrap();

        let derived = derive_public_key(&encrypted, Some("ed25519 passphrase")).unwrap();
        assert!(derived.public_key.starts_with("ssh-ed25519 "));
        assert!(derived.fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn unparseable_private_key_is_rejected() {
        let error = derive_public_key("definitely not a private key", None).unwrap_err();
        assert_eq!(error.category(), "invalid-input");
        assert_eq!(
            error.to_string(),
            "invalid input: private key could not be parsed; provide an RSA or ed25519 private key in OpenSSH or PEM format"
        );
    }

    #[tokio::test]
    async fn key_reference_crud_and_validation() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let created = create(
            &pool,
            KeyReferenceInput {
                name: "Personal".into(),
                public_key: Some("ssh-ed25519 AAAA example".into()),
                storage_mode: "local-path".into(),
                local_path: Some("~/.ssh/id_ed25519".into()),
                fingerprint: Some("SHA256:test".into()),
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(created.local_path.as_deref(), Some("~/.ssh/id_ed25519"));

        let updated = update(
            &pool,
            &created.id,
            KeyReferenceInput {
                name: "Agent key".into(),
                public_key: None,
                storage_mode: "ssh-agent".into(),
                local_path: Some("ignored".into()),
                fingerprint: None,
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();
        assert!(updated.local_path.is_none());

        let invalid = create(
            &pool,
            KeyReferenceInput {
                name: "Vault".into(),
                public_key: None,
                storage_mode: "encrypted-vault".into(),
                local_path: None,
                fingerprint: None,
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await;
        assert!(invalid.is_err());

        let private_key = create(
            &pool,
            KeyReferenceInput {
                name: "Secret material".into(),
                public_key: Some("-----BEGIN OPENSSH PRIVATE KEY-----".into()),
                storage_mode: "ssh-agent".into(),
                local_path: None,
                fingerprint: None,
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await;
        assert!(private_key.is_err());

        delete(&pool, &created.id).await.unwrap();
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type = 'key_reference' AND object_id = ?1",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);
    }
}
