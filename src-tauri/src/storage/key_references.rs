use keyring::Entry;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_NAME_LENGTH: usize = 128;
const MAX_PATH_LENGTH: usize = 4096;
const MAX_PUBLIC_KEY_LENGTH: usize = 64 * 1024;
const MAX_FINGERPRINT_LENGTH: usize = 512;

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

#[derive(Debug, Clone, Deserialize)]
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

pub async fn create(pool: &SqlitePool, input: KeyReferenceInput) -> Result<KeyReference> {
    validate_create(&input)?;
    create_validated(pool, input, true).await
}

pub(crate) async fn create_metadata(
    pool: &SqlitePool,
    input: KeyReferenceInput,
) -> Result<KeyReference> {
    validate(&input)?;
    create_validated(pool, input, false).await
}

async fn create_validated(
    pool: &SqlitePool,
    mut input: KeyReferenceInput,
    store_credentials: bool,
) -> Result<KeyReference> {
    input.public_key = optional_trimmed(input.public_key);
    input.local_path = optional_trimmed(input.local_path);
    input.fingerprint = optional_trimmed(input.fingerprint);
    input.certificate = optional_trimmed(input.certificate);
    if input.storage_mode == "ssh-agent" {
        input.local_path = None;
    }

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

pub async fn update(
    pool: &SqlitePool,
    id: &str,
    mut input: KeyReferenceInput,
) -> Result<KeyReference> {
    if get(pool, id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown key reference".into()));
    }
    validate(&input)?;
    let current = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown key reference".into()))?;
    input.public_key = optional_trimmed(input.public_key);
    input.local_path = optional_trimmed(input.local_path);
    input.fingerprint = optional_trimmed(input.fingerprint);
    input.certificate = optional_trimmed(input.certificate);
    if input.storage_mode == "ssh-agent" {
        input.local_path = None;
    }

    let has_private_key = match input.private_key.as_deref() {
        None => current.has_private_key,
        value => store_chunked_secret("luma.ssh.key.private", id, value)?,
    };
    if input.passphrase.is_some() {
        let _ = store_secret("luma.ssh.key.passphrase", id, input.passphrase.as_deref())?;
    }
    sqlx::query(
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
    .execute(pool)
    .await?;

    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown key reference".into()))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM key_references WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
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
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    purge_secrets(id);
    Ok(())
}

pub(crate) fn purge_secrets(id: &str) {
    delete_chunked_secret("luma.ssh.key.private", id);
    let _ = Entry::new("luma.ssh.key.passphrase", id).and_then(|entry| entry.delete_credential());
}

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
fn store_chunked_secret(service: &str, id: &str, value: Option<&str>) -> Result<bool> {
    if value.is_none() {
        return Ok(false);
    }
    delete_chunked_secret(service, id);
    let value = value.unwrap_or_default();
    if value.is_empty() {
        return Ok(false);
    }
    let chars: Vec<char> = value.chars().collect();
    let chunks: Vec<String> = chars
        .chunks(1800)
        .map(|chunk| chunk.iter().collect())
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
