use tauri::State;

use crate::collaboration::CollaborationRuntimeState;
use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::storage::vaults::{self, Vault, VaultInput};
use crate::sync::managed::{ManagedClient, VaultInvite};
use crate::sync::{self, SyncRuntimeState};
use crate::AppState;

#[tauri::command]
pub async fn vaults_list(state: State<'_, AppState>) -> Result<Vec<Vault>> {
    vaults::list(&state.pool).await
}

#[tauri::command]
pub async fn vault_get(state: State<'_, AppState>, id: String) -> Result<Option<Vault>> {
    vaults::get(&state.pool, &id).await
}

#[tauri::command]
pub async fn vault_create(state: State<'_, AppState>, input: VaultInput) -> Result<Vault> {
    vaults::create(&state.pool, input).await
}

#[tauri::command]
pub async fn vault_update(
    state: State<'_, AppState>,
    id: String,
    input: VaultInput,
) -> Result<Vault> {
    vaults::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn vault_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    vaults::delete(&state.pool, &id).await
}

/// Create a vault whose key Luma Cloud distributes to member devices. The
/// content key is minted, sealed and cached here — it never reaches the
/// frontend.
#[tauri::command]
pub async fn vault_create_managed(
    state: State<'_, AppState>,
    sync_state: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    collab_state: State<'_, CollaborationRuntimeState>,
    name: String,
    cloud_url: String,
    share_secrets: bool,
) -> Result<Vault> {
    let (vault, secret) = sync::managed::create(
        &state.pool,
        &collab_state,
        &keystore_state,
        &cloud_url,
        &name,
        share_secrets,
    )
    .await?;
    sync::cache_vault_secret(&sync_state, &vault.id, secret);
    Ok(vault)
}

#[tauri::command]
pub async fn vault_join_managed(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    collab_state: State<'_, CollaborationRuntimeState>,
    name: String,
    cloud_url: String,
    invite_secret: String,
) -> Result<Vault> {
    sync::managed::join(
        &state.pool,
        &collab_state,
        &keystore_state,
        &cloud_url,
        &name,
        &invite_secret,
    )
    .await
}

#[tauri::command]
pub async fn vault_create_invite(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    collab_state: State<'_, CollaborationRuntimeState>,
    id: String,
    cloud_url: String,
    role: String,
) -> Result<VaultInvite> {
    let remote_vault_id = managed_remote_id(&state.pool, &id).await?;
    let client =
        ManagedClient::connect(&state.pool, &collab_state, &keystore_state, &cloud_url).await?;
    client.create_invite(&remote_vault_id, &role).await
}

/// Remove a member, then rotate the key so nothing written afterwards is
/// readable by them. What they already hold cannot be retracted, and the UI
/// says so.
#[tauri::command]
pub async fn vault_remove_member(
    state: State<'_, AppState>,
    sync_state: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    collab_state: State<'_, CollaborationRuntimeState>,
    id: String,
    cloud_url: String,
    subject: String,
) -> Result<()> {
    let remote_vault_id = managed_remote_id(&state.pool, &id).await?;
    let client =
        ManagedClient::connect(&state.pool, &collab_state, &keystore_state, &cloud_url).await?;
    client.remove_member(&remote_vault_id, &subject).await?;

    let vault = vaults::get(&state.pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown vault".into()))?;
    let secret = sync::managed::rotate_key(
        &state.pool,
        &collab_state,
        &keystore_state,
        &cloud_url,
        &vault,
    )
    .await?;
    sync::cache_vault_secret(&sync_state, &id, secret);
    Ok(())
}

async fn managed_remote_id(pool: &sqlx::SqlitePool, id: &str) -> Result<String> {
    vaults::get(pool, id)
        .await?
        .and_then(|vault| vault.remote_vault_id)
        .ok_or_else(|| {
            LumaError::InvalidInput("this vault is not shared through Luma Cloud".into())
        })
}
