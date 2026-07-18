use tauri::State;

use crate::errors::Result;
use crate::storage::host_groups::{self, HostGroup, HostGroupInput};
use crate::storage::hosts::{self, Host, HostInput};
use crate::storage::identities::{self, Identity, IdentityInput};
use crate::storage::key_references::{self, DerivedPublicKey, KeyReference, KeyReferenceInput};
use crate::vault::{self, VaultState};
use crate::AppState;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

#[tauri::command]
pub async fn hosts_list(state: State<'_, AppState>) -> Result<Vec<Host>> {
    hosts::list(&state.pool).await
}

#[tauri::command]
pub async fn host_get(state: State<'_, AppState>, id: String) -> Result<Option<Host>> {
    hosts::get(&state.pool, &id).await
}

#[tauri::command]
pub async fn host_create(state: State<'_, AppState>, input: HostInput) -> Result<Host> {
    hosts::create(&state.pool, input).await
}

#[tauri::command]
pub async fn host_update(state: State<'_, AppState>, id: String, input: HostInput) -> Result<Host> {
    hosts::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn host_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    hosts::delete(&state.pool, &id).await
}

#[tauri::command]
pub async fn host_duplicate(state: State<'_, AppState>, id: String) -> Result<Host> {
    hosts::duplicate(&state.pool, &id).await
}

#[tauri::command]
pub async fn recent_hosts_list(state: State<'_, AppState>) -> Result<Vec<Host>> {
    hosts::recent(&state.pool, 10).await
}

#[tauri::command]
pub async fn host_groups_list(state: State<'_, AppState>) -> Result<Vec<HostGroup>> {
    host_groups::list(&state.pool).await
}

#[tauri::command]
pub async fn host_group_create(
    state: State<'_, AppState>,
    input: HostGroupInput,
) -> Result<HostGroup> {
    host_groups::create(&state.pool, input).await
}

#[tauri::command]
pub async fn host_group_update(
    state: State<'_, AppState>,
    id: String,
    input: HostGroupInput,
) -> Result<HostGroup> {
    host_groups::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn host_group_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    host_groups::delete(&state.pool, &id).await
}

#[tauri::command]
pub fn derive_public_key(
    private_key: String,
    passphrase: Option<String>,
) -> Result<DerivedPublicKey> {
    let private_key = Zeroizing::new(private_key);
    let passphrase = passphrase.map(Zeroizing::new);
    key_references::derive_public_key(&private_key, passphrase.as_deref().map(String::as_str))
}

#[tauri::command]
pub async fn key_references_list(state: State<'_, AppState>) -> Result<Vec<KeyReference>> {
    key_references::list(&state.pool).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyReferenceSecrets {
    private_key: Option<String>,
    passphrase: Option<String>,
}

#[tauri::command]
pub async fn key_reference_secrets(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    id: String,
) -> Result<KeyReferenceSecrets> {
    key_references::get(&state.pool, &id)
        .await?
        .ok_or_else(|| crate::errors::LumaError::InvalidInput("unknown key reference".into()))?;
    Ok(KeyReferenceSecrets {
        private_key: vault::load(&state.pool, &vault_state, "key", &id, "private-key").await?,
        passphrase: vault::load(&state.pool, &vault_state, "key", &id, "passphrase").await?,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AtomicWriteFailure {
    None,
    AfterSecretWrite,
}

async fn inject_atomic_write_failure(
    transaction: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    failure: AtomicWriteFailure,
) -> Result<()> {
    if failure == AtomicWriteFailure::AfterSecretWrite {
        sqlx::query("INSERT INTO __luma_injected_failure DEFAULT VALUES")
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

async fn create_key_reference(
    pool: &SqlitePool,
    vault_state: &VaultState,
    mut input: KeyReferenceInput,
    failure: AtomicWriteFailure,
) -> Result<KeyReference> {
    key_references::validate_create(&input)?;
    let has_secret = input
        .private_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || input
            .passphrase
            .as_deref()
            .is_some_and(|value| !value.is_empty());
    if has_secret && !vault::is_unlocked(vault_state) {
        return Err(crate::errors::LumaError::InvalidInput(
            "vault is locked; unlock it before saving secrets".into(),
        ));
    }
    key_references::apply_derived_vault_metadata(&mut input)?;
    let private_key = input.private_key.take().map(Zeroizing::new);
    let passphrase = input.passphrase.take().map(Zeroizing::new);
    let has_private_key = private_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty());

    let mut transaction = pool.begin().await?;
    let id = key_references::insert_metadata(&mut *transaction, input, has_private_key).await?;
    if let Some(value) = private_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        vault::store(
            &mut *transaction,
            vault_state,
            "key",
            &id,
            "private-key",
            value,
        )
        .await?;
    }
    if let Some(value) = passphrase.as_deref().filter(|value| !value.is_empty()) {
        vault::store(
            &mut *transaction,
            vault_state,
            "key",
            &id,
            "passphrase",
            value,
        )
        .await?;
    }
    inject_atomic_write_failure(&mut transaction, failure).await?;
    transaction.commit().await?;
    key_references::get(pool, &id).await?.ok_or_else(|| {
        crate::errors::LumaError::InvalidInput("key reference creation failed".into())
    })
}

#[tauri::command]
pub async fn key_reference_create(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    input: KeyReferenceInput,
) -> Result<KeyReference> {
    create_key_reference(&state.pool, &vault_state, input, AtomicWriteFailure::None).await
}

async fn update_key_reference(
    pool: &SqlitePool,
    vault_state: &VaultState,
    id: &str,
    mut input: KeyReferenceInput,
    failure: AtomicWriteFailure,
) -> Result<KeyReference> {
    key_references::validate(&input)?;
    let current = key_references::get(pool, id)
        .await?
        .ok_or_else(|| crate::errors::LumaError::InvalidInput("unknown key reference".into()))?;
    let has_secret = input
        .private_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        || input
            .passphrase
            .as_deref()
            .is_some_and(|value| !value.is_empty());
    if has_secret && !vault::is_unlocked(vault_state) {
        return Err(crate::errors::LumaError::InvalidInput(
            "vault is locked; unlock it before saving secrets".into(),
        ));
    }
    key_references::apply_derived_vault_metadata(&mut input)?;
    let private_key = input.private_key.take().map(Zeroizing::new);
    let passphrase = input.passphrase.take().map(Zeroizing::new);
    let has_private_key = if private_key
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        true
    } else {
        current.has_private_key
    };

    let mut transaction = pool.begin().await?;
    key_references::update_metadata(&mut *transaction, id, input, has_private_key).await?;
    if let Some(value) = private_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        vault::store(
            &mut *transaction,
            vault_state,
            "key",
            id,
            "private-key",
            value,
        )
        .await?;
    }
    if let Some(value) = passphrase.as_deref().filter(|value| !value.is_empty()) {
        vault::store(
            &mut *transaction,
            vault_state,
            "key",
            id,
            "passphrase",
            value,
        )
        .await?;
    }
    inject_atomic_write_failure(&mut transaction, failure).await?;
    transaction.commit().await?;
    key_references::get(pool, id)
        .await?
        .ok_or_else(|| crate::errors::LumaError::InvalidInput("unknown key reference".into()))
}

#[tauri::command]
pub async fn key_reference_update(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    id: String,
    input: KeyReferenceInput,
) -> Result<KeyReference> {
    update_key_reference(
        &state.pool,
        &vault_state,
        &id,
        input,
        AtomicWriteFailure::None,
    )
    .await
}

async fn delete_key_reference(
    pool: &SqlitePool,
    id: &str,
    failure: AtomicWriteFailure,
) -> Result<()> {
    let mut transaction = pool.begin().await?;
    key_references::delete_metadata(&mut transaction, id).await?;
    vault::delete(&mut *transaction, "key", id).await?;
    inject_atomic_write_failure(&mut transaction, failure).await?;
    transaction.commit().await?;
    key_references::purge_secrets(id);
    Ok(())
}

#[tauri::command]
pub async fn key_reference_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    delete_key_reference(&state.pool, &id, AtomicWriteFailure::None).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateKeyInput {
    name: String,
    local_path: String,
    passphrase: String,
    certificate: Option<String>,
}

struct GeneratedKeyFiles {
    private_path: PathBuf,
    public_path: PathBuf,
    private_created: bool,
    public_created: bool,
    keep: bool,
}

impl Drop for GeneratedKeyFiles {
    fn drop(&mut self) {
        if !self.keep {
            if self.private_created {
                let _ = std::fs::remove_file(&self.private_path);
            }
            if self.public_created {
                let _ = std::fs::remove_file(&self.public_path);
            }
        }
    }
}

fn write_new_key_file(path: &Path, contents: &[u8], private: bool) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if private { 0o600 } else { 0o644 });
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            crate::errors::LumaError::InvalidInput("a key already exists at that path".into())
        } else {
            error.into()
        }
    })?;
    file.write_all(contents)?;
    file.flush()?;
    file.sync_all()?;
    Ok(())
}

async fn generate_ssh_key(
    pool: &SqlitePool,
    vault_state: &VaultState,
    input: GenerateKeyInput,
) -> Result<KeyReference> {
    let raw_path = input.local_path.trim();
    if raw_path.is_empty() || raw_path.contains('\0') {
        return Err(crate::errors::LumaError::InvalidInput(
            "key path is required".into(),
        ));
    }
    let path = if let Some(rest) = raw_path
        .strip_prefix("~/")
        .or_else(|| raw_path.strip_prefix("~\\"))
    {
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(PathBuf::from)
            .ok_or_else(|| {
                crate::errors::LumaError::InvalidInput("home directory is unavailable".into())
            })?;
        home.join(rest)
    } else {
        PathBuf::from(raw_path)
    };
    let public_path = PathBuf::from(format!("{}.pub", path.to_string_lossy()));
    if path.exists() || public_path.exists() {
        return Err(crate::errors::LumaError::InvalidInput(
            "a key already exists at that path".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let name = input.name;
    let certificate = input.certificate;
    let passphrase = Zeroizing::new(input.passphrase);
    if !passphrase.is_empty() && !vault::is_unlocked(vault_state) {
        return Err(crate::errors::LumaError::InvalidInput(
            "vault is locked; unlock it before saving secrets".into(),
        ));
    }
    let mut rng = OsRng;
    let mut private_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).map_err(|_| {
        crate::errors::LumaError::InvalidInput("could not generate the SSH key".into())
    })?;
    private_key.set_comment(name.trim());
    let public_key = private_key.public_key().to_openssh().map_err(|_| {
        crate::errors::LumaError::InvalidInput("could not encode the SSH public key".into())
    })?;
    let encoded_private_key = if passphrase.is_empty() {
        private_key.to_openssh(LineEnding::LF)
    } else {
        private_key
            .encrypt(&mut rng, passphrase.as_bytes())
            .and_then(|key| key.to_openssh(LineEnding::LF))
    }
    .map_err(|_| {
        crate::errors::LumaError::InvalidInput("could not encode the SSH private key".into())
    })?;

    let mut files = GeneratedKeyFiles {
        private_path: path.clone(),
        public_path: public_path.clone(),
        private_created: false,
        public_created: false,
        keep: false,
    };
    write_new_key_file(&path, encoded_private_key.as_bytes(), true)?;
    files.private_created = true;
    write_new_key_file(&public_path, format!("{public_key}\n").as_bytes(), false)?;
    files.public_created = true;

    let created = create_key_reference(
        pool,
        vault_state,
        KeyReferenceInput {
            name,
            public_key: Some(public_key),
            storage_mode: "local-path".into(),
            local_path: Some(path.to_string_lossy().into_owned()),
            fingerprint: None,
            certificate,
            private_key: None,
            passphrase: (!passphrase.is_empty()).then(|| passphrase.to_string()),
        },
        AtomicWriteFailure::None,
    )
    .await?;
    files.keep = true;
    Ok(created)
}

#[tauri::command]
pub async fn ssh_key_generate(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    input: GenerateKeyInput,
) -> Result<KeyReference> {
    generate_ssh_key(&state.pool, &vault_state, input).await
}

#[tauri::command]
pub async fn identities_list(state: State<'_, AppState>) -> Result<Vec<Identity>> {
    identities::list(&state.pool).await
}
#[tauri::command]
pub async fn identity_create(state: State<'_, AppState>, input: IdentityInput) -> Result<Identity> {
    identities::create(&state.pool, input).await
}
#[tauri::command]
pub async fn identity_update(
    state: State<'_, AppState>,
    id: String,
    input: IdentityInput,
) -> Result<Identity> {
    identities::update(&state.pool, &id, input).await
}
#[tauri::command]
pub async fn identity_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    identities::delete(&state.pool, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_key_input(name: &str, passphrase: Option<&str>) -> KeyReferenceInput {
        KeyReferenceInput {
            name: name.into(),
            public_key: Some("ssh-ed25519 AAAA test".into()),
            storage_mode: "local-path".into(),
            local_path: Some("/test/id_ed25519".into()),
            fingerprint: None,
            certificate: None,
            private_key: None,
            passphrase: passphrase.map(str::to_owned),
        }
    }

    async fn unlocked_vault() -> (SqlitePool, VaultState) {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let state = VaultState::default();
        vault::setup(&pool, &state, "test vault password", false)
            .await
            .unwrap();
        (pool, state)
    }

    #[tokio::test]
    async fn failed_key_reference_create_rolls_back_metadata_and_vault_secret() {
        let (pool, vault_state) = unlocked_vault().await;
        let error = create_key_reference(
            &pool,
            &vault_state,
            local_key_input("Failed create", Some("new secret")),
            AtomicWriteFailure::AfterSecretWrite,
        )
        .await
        .unwrap_err();
        assert_eq!(error.category(), "database");
        let metadata_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_references")
            .fetch_one(&pool)
            .await
            .unwrap();
        let secret_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM vault_secrets")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((metadata_count, secret_count), (0, 0));
    }

    #[tokio::test]
    async fn failed_key_reference_update_restores_metadata_and_vault_secret() {
        let (pool, vault_state) = unlocked_vault().await;
        let created = create_key_reference(
            &pool,
            &vault_state,
            local_key_input("Original", Some("old secret")),
            AtomicWriteFailure::None,
        )
        .await
        .unwrap();

        let error = update_key_reference(
            &pool,
            &vault_state,
            &created.id,
            local_key_input("Changed", Some("new secret")),
            AtomicWriteFailure::AfterSecretWrite,
        )
        .await
        .unwrap_err();
        assert_eq!(error.category(), "database");
        let stored = key_references::get(&pool, &created.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.name, "Original");
        assert_eq!(
            vault::load(&pool, &vault_state, "key", &created.id, "passphrase")
                .await
                .unwrap()
                .as_deref(),
            Some("old secret")
        );
    }

    #[tokio::test]
    async fn failed_key_reference_delete_restores_metadata_and_vault_secret() {
        let (pool, vault_state) = unlocked_vault().await;
        let created = create_key_reference(
            &pool,
            &vault_state,
            local_key_input("Keep", Some("keep secret")),
            AtomicWriteFailure::None,
        )
        .await
        .unwrap();

        let error = delete_key_reference(&pool, &created.id, AtomicWriteFailure::AfterSecretWrite)
            .await
            .unwrap_err();
        assert_eq!(error.category(), "database");
        assert!(key_references::get(&pool, &created.id)
            .await
            .unwrap()
            .is_some());
        assert_eq!(
            vault::load(&pool, &vault_state, "key", &created.id, "passphrase")
                .await
                .unwrap()
                .as_deref(),
            Some("keep secret")
        );
    }

    async fn assert_generated_key(passphrase: &str, encrypted: bool) {
        let (pool, vault_state) = unlocked_vault().await;
        let directory =
            std::env::temp_dir().join(format!("luma-generated-key-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("id_ed25519");
        let created = generate_ssh_key(
            &pool,
            &vault_state,
            GenerateKeyInput {
                name: "Generated test key".into(),
                local_path: path.to_string_lossy().into_owned(),
                passphrase: passphrase.into(),
                certificate: None,
            },
        )
        .await
        .unwrap();

        let encoded = std::fs::read_to_string(&path).unwrap();
        let parsed = PrivateKey::from_openssh(&encoded).unwrap();
        assert_eq!(parsed.is_encrypted(), encrypted);
        if encrypted {
            assert!(parsed.decrypt(passphrase.as_bytes()).is_ok());
            assert!(parsed.decrypt(b"wrong passphrase").is_err());
            assert_eq!(
                vault::load(&pool, &vault_state, "key", &created.id, "passphrase")
                    .await
                    .unwrap()
                    .as_deref(),
                Some(passphrase)
            );
        }
        let public = std::fs::read_to_string(format!("{}.pub", path.to_string_lossy())).unwrap();
        assert!(public.starts_with("ssh-ed25519 "));
        pool.close().await;
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn generates_parseable_unencrypted_ed25519_key_in_process() {
        assert_generated_key("", false).await;
    }

    #[tokio::test]
    async fn generates_parseable_encrypted_ed25519_key_in_process() {
        assert_generated_key("generated key passphrase", true).await;
    }
}
