use tauri::State;

use crate::errors::Result;
use crate::keystore::{self, KeystoreState};
use crate::storage::host_groups::{self, HostGroup, HostGroupInput};
use crate::storage::host_inheritance::{self, EffectiveHost};
use crate::storage::hosts::{self, Host, HostInput};
use crate::storage::identities::{self, Identity, IdentityInput};
use crate::storage::key_references::{self, DerivedPublicKey, KeyReference, KeyReferenceInput};
use crate::AppState;
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// `vaultId` is optional everywhere it appears: omitting it lists across every
/// vault, which is what the command palette and the vault overview want.
#[tauri::command]
pub async fn hosts_list(state: State<'_, AppState>, vault_id: Option<String>) -> Result<Vec<Host>> {
    hosts::list(&state.pool, vault_id.as_deref()).await
}

#[tauri::command]
pub async fn host_get(state: State<'_, AppState>, id: String) -> Result<Option<Host>> {
    hosts::get(&state.pool, &id).await
}

/// A host's effective configuration plus the provenance of every field.
///
/// With `id`, this resolves the stored host through its own group chain: what a
/// connection will actually use. With `id` omitted it resolves a host that sets
/// nothing at all against `groupId`, which answers the editor's question —
/// "what would a host in this group inherit?" — for whichever group is selected
/// in the form, including one the host has not been saved into yet.
///
/// `host_get` deliberately keeps returning the raw row: the editor has to show
/// what this host actually stores, or saving the form would bake inherited
/// values into the host and quietly break the link to its group.
#[tauri::command]
pub async fn host_effective_config(
    state: State<'_, AppState>,
    id: Option<String>,
    group_id: Option<String>,
) -> Result<Option<EffectiveHost>> {
    if let Some(id) = id {
        let Some(host) = hosts::get(&state.pool, &id).await? else {
            return Ok(None);
        };
        return host_inheritance::effective_host(&state.pool, host)
            .await
            .map(Some);
    }
    host_inheritance::group_defaults_preview(&state.pool, group_id.as_deref())
        .await
        .map(Some)
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
pub async fn host_groups_list(
    state: State<'_, AppState>,
    vault_id: Option<String>,
) -> Result<Vec<HostGroup>> {
    host_groups::list(&state.pool, vault_id.as_deref()).await
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
pub async fn key_references_list(
    state: State<'_, AppState>,
    vault_id: Option<String>,
) -> Result<Vec<KeyReference>> {
    key_references::list(&state.pool, vault_id.as_deref()).await
}

// Both of these serve `ssh_agent_identities`, which mobile targets do not
// compile — without the same gate they are dead code in a mobile build.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshAgentIdentity {
    public_key: String,
    fingerprint: String,
    comment: String,
    algorithm: String,
    hardware_backed: bool,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_hardware_backed_agent_algorithm(algorithm: &str) -> bool {
    algorithm.starts_with("sk-") || algorithm.contains("security-key")
}

/// Lists public identities exposed by the device's SSH agent. Private material
/// never crosses this boundary; signing remains inside the agent/provider.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn ssh_agent_identities() -> Result<Vec<SshAgentIdentity>> {
    use russh::keys::agent::AgentIdentity;
    use russh::keys::HashAlg;

    let mut agent = crate::ssh::agent::connect_client().await?;
    let identities = agent.request_identities().await.map_err(|error| {
        crate::errors::LumaError::KeyUnavailable(format!(
            "could not list SSH-agent identities: {error}"
        ))
    })?;
    let mut result = Vec::new();
    for identity in identities {
        let AgentIdentity::PublicKey { mut key, comment } = identity else {
            // Certificate-backed agent identities require preserving the full
            // certificate during authentication. Do not misrepresent their
            // underlying public key as directly usable.
            continue;
        };
        let algorithm = key.algorithm().to_string();
        let hardware_backed = is_hardware_backed_agent_algorithm(&algorithm);
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        key.set_comment("");
        let public_key = key.to_openssh().map_err(|error| {
            crate::errors::LumaError::KeyUnavailable(format!(
                "could not encode SSH-agent public key: {error}"
            ))
        })?;
        result.push(SshAgentIdentity {
            public_key,
            fingerprint,
            comment,
            algorithm,
            hardware_backed,
        });
    }
    Ok(result)
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
    keystore_state: State<'_, KeystoreState>,
    id: String,
) -> Result<KeyReferenceSecrets> {
    key_references::get(&state.pool, &id)
        .await?
        .ok_or_else(|| crate::errors::LumaError::InvalidInput("unknown key reference".into()))?;
    Ok(KeyReferenceSecrets {
        private_key: keystore::load(&state.pool, &keystore_state, "key", &id, "private-key")
            .await?,
        passphrase: keystore::load(&state.pool, &keystore_state, "key", &id, "passphrase").await?,
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
    keystore_state: &KeystoreState,
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
    if has_secret && !keystore::is_unlocked(keystore_state) {
        return Err(crate::errors::LumaError::InvalidInput(
            "keystore is locked; unlock it before saving secrets".into(),
        ));
    }
    key_references::apply_derived_keystore_metadata(&mut input)?;
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
        keystore::store(
            &mut *transaction,
            keystore_state,
            "key",
            &id,
            "private-key",
            value,
        )
        .await?;
    }
    if let Some(value) = passphrase.as_deref().filter(|value| !value.is_empty()) {
        keystore::store(
            &mut *transaction,
            keystore_state,
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
    keystore_state: State<'_, KeystoreState>,
    input: KeyReferenceInput,
) -> Result<KeyReference> {
    create_key_reference(
        &state.pool,
        &keystore_state,
        input,
        AtomicWriteFailure::None,
    )
    .await
}

async fn update_key_reference(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
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
    if has_secret && !keystore::is_unlocked(keystore_state) {
        return Err(crate::errors::LumaError::InvalidInput(
            "keystore is locked; unlock it before saving secrets".into(),
        ));
    }
    key_references::apply_derived_keystore_metadata(&mut input)?;
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
        keystore::store(
            &mut *transaction,
            keystore_state,
            "key",
            id,
            "private-key",
            value,
        )
        .await?;
    }
    if let Some(value) = passphrase.as_deref().filter(|value| !value.is_empty()) {
        keystore::store(
            &mut *transaction,
            keystore_state,
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
    keystore_state: State<'_, KeystoreState>,
    id: String,
    input: KeyReferenceInput,
) -> Result<KeyReference> {
    update_key_reference(
        &state.pool,
        &keystore_state,
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
    keystore::delete(&mut *transaction, "key", id).await?;
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
    #[serde(default = "crate::storage::vaults::default_id")]
    vault_id: String,
    name: String,
    local_path: String,
    passphrase: String,
    certificate: Option<String>,
}

struct GeneratedKeystoreKey {
    private_key: Zeroizing<String>,
    public_key: String,
    fingerprint: String,
}

fn generate_keystore_key_material(
    key_type: &str,
    comment: &str,
    passphrase: Option<&str>,
) -> Result<GeneratedKeystoreKey> {
    if comment.len() > 1024 || comment.chars().any(char::is_control) {
        return Err(crate::errors::LumaError::InvalidInput(
            "key comment must be at most 1024 characters and contain no control characters".into(),
        ));
    }
    let algorithm = match key_type {
        "ed25519" => Algorithm::Ed25519,
        "rsa4096" => Algorithm::Rsa { hash: None },
        _ => {
            return Err(crate::errors::LumaError::InvalidInput(
                "keyType must be 'ed25519' or 'rsa4096'".into(),
            ))
        }
    };
    let mut rng = OsRng;
    let mut private_key = PrivateKey::random(&mut rng, algorithm).map_err(|_| {
        crate::errors::LumaError::InvalidInput("could not generate the SSH key".into())
    })?;
    private_key.set_comment(comment);
    let public_key = private_key.public_key().to_openssh().map_err(|_| {
        crate::errors::LumaError::InvalidInput("could not encode the SSH public key".into())
    })?;
    let fingerprint = private_key
        .public_key()
        .fingerprint(ssh_key::HashAlg::Sha256)
        .to_string();
    let encoded = match passphrase.filter(|value| !value.is_empty()) {
        Some(passphrase) => private_key
            .encrypt(&mut rng, passphrase.as_bytes())
            .and_then(|key| key.to_openssh(LineEnding::LF)),
        None => private_key.to_openssh(LineEnding::LF),
    }
    .map_err(|_| {
        crate::errors::LumaError::InvalidInput("could not encode the SSH private key".into())
    })?;
    Ok(GeneratedKeystoreKey {
        private_key: Zeroizing::new(encoded.to_string()),
        public_key,
        fingerprint,
    })
}

async fn generate_keystore_ssh_key(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    vault_id: String,
    key_type: String,
    name: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<KeyReference> {
    if !keystore::is_unlocked(keystore_state) {
        return Err(crate::errors::LumaError::KeystoreLocked(
            "unlock the keystore before generating a private key".into(),
        ));
    }
    let trimmed_name = name.trim();
    if trimmed_name.is_empty() || trimmed_name.len() > 128 {
        return Err(crate::errors::LumaError::InvalidInput(
            "key name must be 1-128 characters".into(),
        ));
    }
    if passphrase
        .as_ref()
        .is_some_and(|value| value.len() > 16 * 1024)
    {
        return Err(crate::errors::LumaError::InvalidInput(
            "passphrase is too large".into(),
        ));
    }
    let comment = comment.unwrap_or_else(|| trimmed_name.to_string());
    let key_type_for_task = key_type.clone();
    let comment_for_task = comment.clone();
    let passphrase_for_task = passphrase.clone();
    let generated = tokio::task::spawn_blocking(move || {
        generate_keystore_key_material(
            &key_type_for_task,
            &comment_for_task,
            passphrase_for_task.as_deref(),
        )
    })
    .await
    .map_err(|error| {
        crate::errors::LumaError::InvalidInput(format!("SSH key generation task failed: {error}"))
    })??;

    create_key_reference(
        pool,
        keystore_state,
        KeyReferenceInput {
            vault_id,
            name,
            public_key: Some(generated.public_key),
            storage_mode: "encrypted-vault".into(),
            local_path: None,
            fingerprint: Some(generated.fingerprint),
            certificate: None,
            private_key: Some(generated.private_key.to_string()),
            passphrase: passphrase.filter(|value| !value.is_empty()),
        },
        AtomicWriteFailure::None,
    )
    .await
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
    keystore_state: &KeystoreState,
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

    let vault_id = input.vault_id;
    let name = input.name;
    let certificate = input.certificate;
    let passphrase = Zeroizing::new(input.passphrase);
    if !passphrase.is_empty() && !keystore::is_unlocked(keystore_state) {
        return Err(crate::errors::LumaError::InvalidInput(
            "keystore is locked; unlock it before saving secrets".into(),
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
        keystore_state,
        KeyReferenceInput {
            vault_id,
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
#[allow(clippy::too_many_arguments)]
pub async fn ssh_key_generate(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
    key_type: Option<String>,
    name: Option<String>,
    passphrase: Option<String>,
    comment: Option<String>,
    input: Option<GenerateKeyInput>,
) -> Result<KeyReference> {
    if let Some(input) = input {
        if key_type.is_some() || name.is_some() || passphrase.is_some() || comment.is_some() {
            return Err(crate::errors::LumaError::InvalidInput(
                "legacy input cannot be combined with keyType, name, passphrase, or comment".into(),
            ));
        }
        return generate_ssh_key(&state.pool, &keystore_state, input).await;
    }

    generate_keystore_ssh_key(
        &state.pool,
        &keystore_state,
        vault_id.unwrap_or_else(crate::storage::vaults::default_id),
        key_type
            .ok_or_else(|| crate::errors::LumaError::InvalidInput("keyType is required".into()))?,
        name.ok_or_else(|| crate::errors::LumaError::InvalidInput("name is required".into()))?,
        passphrase,
        comment,
    )
    .await
}

#[tauri::command]
pub async fn identities_list(
    state: State<'_, AppState>,
    vault_id: Option<String>,
) -> Result<Vec<Identity>> {
    identities::list(&state.pool, vault_id.as_deref()).await
}
#[tauri::command]
pub async fn identity_create(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    input: IdentityInput,
) -> Result<Identity> {
    identities::create(&state.pool, &keystore_state, input).await
}
#[tauri::command]
pub async fn identity_update(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    id: String,
    input: IdentityInput,
) -> Result<Identity> {
    identities::update(&state.pool, &keystore_state, &id, input).await
}
#[tauri::command]
pub async fn identity_delete(
    state: State<'_, AppState>,
    _keystore_state: State<'_, KeystoreState>,
    id: String,
) -> Result<()> {
    identities::delete(&state.pool, &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn recognizes_fido_agent_algorithms_without_mislabeling_software_keys() {
        assert!(is_hardware_backed_agent_algorithm(
            "sk-ssh-ed25519@openssh.com"
        ));
        assert!(is_hardware_backed_agent_algorithm(
            "sk-ecdsa-sha2-nistp256@openssh.com"
        ));
        assert!(!is_hardware_backed_agent_algorithm("ssh-ed25519"));
        assert!(!is_hardware_backed_agent_algorithm("rsa-sha2-512"));
    }

    fn local_key_input(name: &str, passphrase: Option<&str>) -> KeyReferenceInput {
        KeyReferenceInput {
            vault_id: crate::storage::vaults::default_id(),
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

    async fn unlocked_keystore() -> (SqlitePool, KeystoreState) {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let state = KeystoreState::default();
        keystore::setup(&pool, &state, "test keystore password", false)
            .await
            .unwrap();
        (pool, state)
    }

    #[tokio::test]
    async fn failed_key_reference_create_rolls_back_metadata_and_keystore_secret() {
        let (pool, keystore_state) = unlocked_keystore().await;
        let error = create_key_reference(
            &pool,
            &keystore_state,
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
        let secret_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM keystore_secrets")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((metadata_count, secret_count), (0, 0));
    }

    #[tokio::test]
    async fn failed_key_reference_update_restores_metadata_and_keystore_secret() {
        let (pool, keystore_state) = unlocked_keystore().await;
        let created = create_key_reference(
            &pool,
            &keystore_state,
            local_key_input("Original", Some("old secret")),
            AtomicWriteFailure::None,
        )
        .await
        .unwrap();

        let error = update_key_reference(
            &pool,
            &keystore_state,
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
            keystore::load(&pool, &keystore_state, "key", &created.id, "passphrase")
                .await
                .unwrap()
                .as_deref(),
            Some("old secret")
        );
    }

    #[tokio::test]
    async fn failed_key_reference_delete_restores_metadata_and_keystore_secret() {
        let (pool, keystore_state) = unlocked_keystore().await;
        let created = create_key_reference(
            &pool,
            &keystore_state,
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
            keystore::load(&pool, &keystore_state, "key", &created.id, "passphrase")
                .await
                .unwrap()
                .as_deref(),
            Some("keep secret")
        );
    }

    async fn assert_generated_key(passphrase: &str, encrypted: bool) {
        let (pool, keystore_state) = unlocked_keystore().await;
        let directory =
            std::env::temp_dir().join(format!("luma-generated-key-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("id_ed25519");
        let created = generate_ssh_key(
            &pool,
            &keystore_state,
            GenerateKeyInput {
                vault_id: crate::storage::vaults::default_id(),
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
                keystore::load(&pool, &keystore_state, "key", &created.id, "passphrase")
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

    #[test]
    fn generated_ed25519_and_rsa4096_keys_have_stable_public_metadata() {
        for key_type in ["ed25519", "rsa4096"] {
            let generated = generate_keystore_key_material(
                key_type,
                "luma-generated-test",
                Some("test key passphrase"),
            )
            .unwrap();
            let private = PrivateKey::from_openssh(generated.private_key.as_str()).unwrap();
            assert!(private.is_encrypted());
            let decrypted = private.decrypt(b"test key passphrase").unwrap();
            let public = ssh_key::PublicKey::from_openssh(&generated.public_key).unwrap();
            assert_eq!(decrypted.public_key().key_data(), public.key_data());
            assert_eq!(
                public.fingerprint(ssh_key::HashAlg::Sha256).to_string(),
                generated.fingerprint
            );
            assert_eq!(public.comment(), "luma-generated-test");
            match key_type {
                "ed25519" => assert!(generated.public_key.starts_with("ssh-ed25519 ")),
                "rsa4096" => assert!(generated.public_key.starts_with("ssh-rsa ")),
                _ => unreachable!(),
            }
        }
    }

    async fn assert_generated_key_plaintext_absent_from_database(shared: bool) {
        let directory = std::env::temp_dir().join(format!(
            "luma-generated-keystore-key-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let database_path = directory.join("luma.db");
        let pool = crate::storage::init(&database_path).await.unwrap();
        let keystore_state = KeystoreState::default();
        keystore::setup(&pool, &keystore_state, "test keystore password", false)
            .await
            .unwrap();
        let vault_id = if shared {
            crate::storage::vaults::create(
                &pool,
                crate::storage::vaults::VaultInput {
                    name: "Infra".into(),
                    share_secrets: true,
                    sort_order: 0,
                },
            )
            .await
            .unwrap()
            .id
        } else {
            crate::storage::vaults::default_id()
        };
        let created = generate_keystore_ssh_key(
            &pool,
            &keystore_state,
            vault_id.clone(),
            "ed25519".into(),
            "Keystore generated".into(),
            Some("private key passphrase".into()),
            Some("db plaintext sentinel".into()),
        )
        .await
        .unwrap();
        assert_eq!(created.vault_id, vault_id);
        assert_eq!(created.storage_mode, "encrypted-vault");
        assert!(created.has_private_key);
        assert!(created
            .public_key
            .as_deref()
            .is_some_and(|value| value.starts_with("ssh-ed25519 ")));
        assert!(created
            .fingerprint
            .as_deref()
            .is_some_and(|value| value.starts_with("SHA256:")));
        let private_key = Zeroizing::new(
            keystore::load(&pool, &keystore_state, "key", &created.id, "private-key")
                .await
                .unwrap()
                .unwrap(),
        );
        sqlx::query("PRAGMA wal_checkpoint(FULL)")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
        let database = std::fs::read(&database_path).unwrap();
        assert!(
            !database
                .windows(private_key.len())
                .any(|window| window == private_key.as_bytes()),
            "plaintext private key was found in SQLite"
        );
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn generated_private_key_plaintext_is_absent_from_database_file() {
        assert_generated_key_plaintext_absent_from_database(false).await;
    }

    #[tokio::test]
    async fn generated_shared_vault_private_key_plaintext_is_absent_from_database_file() {
        assert_generated_key_plaintext_absent_from_database(true).await;
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
