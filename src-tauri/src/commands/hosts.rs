use tauri::State;

use crate::errors::Result;
use crate::storage::host_groups::{self, HostGroup, HostGroupInput};
use crate::storage::hosts::{self, Host, HostInput};
use crate::storage::identities::{self, Identity, IdentityInput};
use crate::storage::key_references::{self, DerivedPublicKey, KeyReference, KeyReferenceInput};
use crate::vault::{self, VaultState};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
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

#[tauri::command]
pub async fn key_reference_create(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    mut input: KeyReferenceInput,
) -> Result<KeyReference> {
    key_references::validate_create(&input)?;
    if input.storage_mode == "encrypted-vault"
        && input
            .private_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        && !vault::is_unlocked(&vault_state)
    {
        return Err(crate::errors::LumaError::InvalidInput(
            "vault is locked; unlock it before saving secrets".into(),
        ));
    }
    key_references::apply_derived_vault_metadata(&mut input)?;
    let private_key = input.private_key.take().map(Zeroizing::new);
    let passphrase = input.passphrase.take().map(Zeroizing::new);
    let mut created = key_references::create_metadata(&state.pool, input).await?;
    if let Some(value) = private_key.as_deref() {
        vault::store(
            &state.pool,
            &vault_state,
            "key",
            &created.id,
            "private-key",
            value,
        )
        .await?;
        created.has_private_key = true;
        sqlx::query("UPDATE key_references SET has_private_key=1 WHERE id=?1")
            .bind(&created.id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(value) = passphrase.as_deref().filter(|v| !v.is_empty()) {
        vault::store(
            &state.pool,
            &vault_state,
            "key",
            &created.id,
            "passphrase",
            value,
        )
        .await?;
    }
    Ok(created)
}

#[tauri::command]
pub async fn key_reference_update(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    id: String,
    mut input: KeyReferenceInput,
) -> Result<KeyReference> {
    if input.storage_mode == "encrypted-vault"
        && input
            .private_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        && !vault::is_unlocked(&vault_state)
    {
        return Err(crate::errors::LumaError::InvalidInput(
            "vault is locked; unlock it before saving secrets".into(),
        ));
    }
    key_references::apply_derived_vault_metadata(&mut input)?;
    let private_key = input.private_key.take().map(Zeroizing::new);
    let passphrase = input.passphrase.take().map(Zeroizing::new);
    key_references::update(&state.pool, &id, input).await?;
    if let Some(value) = private_key.as_deref().filter(|v| !v.is_empty()) {
        vault::store(&state.pool, &vault_state, "key", &id, "private-key", value).await?;
        sqlx::query("UPDATE key_references SET has_private_key=1 WHERE id=?1")
            .bind(&id)
            .execute(&state.pool)
            .await?;
    }
    if let Some(value) = passphrase.as_deref().filter(|v| !v.is_empty()) {
        vault::store(&state.pool, &vault_state, "key", &id, "passphrase", value).await?;
    }
    key_references::get(&state.pool, &id)
        .await?
        .ok_or_else(|| crate::errors::LumaError::InvalidInput("unknown key reference".into()))
}

#[tauri::command]
pub async fn key_reference_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    vault::delete(&state.pool, "key", &id).await?;
    key_references::delete(&state.pool, &id).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateKeyInput {
    name: String,
    local_path: String,
    passphrase: String,
    certificate: Option<String>,
}

#[tauri::command]
pub async fn ssh_key_generate(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
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
    if path.exists()
        || path
            .with_extension(format!(
                "{}pub",
                path.extension()
                    .and_then(|x| x.to_str())
                    .map(|x| format!("{x}."))
                    .unwrap_or_default()
            ))
            .exists()
    {
        return Err(crate::errors::LumaError::InvalidInput(
            "a key already exists at that path".into(),
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output = Command::new("ssh-keygen")
        .args([
            "-t",
            "ed25519",
            "-N",
            &input.passphrase,
            "-C",
            input.name.trim(),
            "-f",
        ])
        .arg(&path)
        .output()
        .map_err(|e| {
            crate::errors::LumaError::SshUnavailable(format!("could not start ssh-keygen: {e}"))
        })?;
    if !output.status.success() {
        return Err(crate::errors::LumaError::InvalidInput(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let public_path = PathBuf::from(format!("{}.pub", path.to_string_lossy()));
    let public_key = std::fs::read_to_string(&public_path).ok();
    let passphrase = input.passphrase.clone();
    let created = key_references::create_metadata(
        &state.pool,
        KeyReferenceInput {
            name: input.name,
            public_key,
            storage_mode: "local-path".into(),
            local_path: Some(path.to_string_lossy().into_owned()),
            fingerprint: None,
            certificate: input.certificate,
            private_key: None,
            passphrase: None,
        },
    )
    .await?;
    if !passphrase.is_empty() {
        vault::store(
            &state.pool,
            &vault_state,
            "key",
            &created.id,
            "passphrase",
            &passphrase,
        )
        .await?;
    }
    Ok(created)
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
