use tauri::State;

use crate::collaboration::CollaborationRuntimeState;
use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::storage::vaults::default_id;
use crate::sync::{
    self, ConflictResolution, ExportSummary, ImportPreview, ImportSummary, SyncConfig,
    SyncConfigureInput, SyncReport, SyncRuntimeState,
};
use crate::AppState;

#[tauri::command]
pub async fn export_encrypted(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
    path: String,
    passphrase: String,
) -> Result<ExportSummary> {
    sync::export_encrypted(
        &state.pool,
        &keystore_state,
        &state.app_data_dir,
        &vault_id.unwrap_or_else(default_id),
        &path,
        &passphrase,
    )
    .await
}

#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    vault_id: Option<String>,
    path: String,
    passphrase: String,
) -> Result<ImportPreview> {
    sync::import_preview(
        &state.pool,
        &state.app_data_dir,
        &vault_id.unwrap_or_else(default_id),
        &path,
        &passphrase,
    )
    .await
}

#[tauri::command]
pub async fn import_apply(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
    path: String,
    passphrase: String,
    resolutions: Vec<ConflictResolution>,
) -> Result<ImportSummary> {
    sync::import_apply(
        &state.pool,
        &keystore_state,
        &state.app_data_dir,
        &vault_id.unwrap_or_else(default_id),
        &path,
        &passphrase,
        &resolutions,
    )
    .await
}

#[tauri::command]
pub async fn sync_get_config(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
) -> Result<SyncConfig> {
    sync::get_config(
        &state.pool,
        &runtime,
        &keystore_state,
        &vault_id.unwrap_or_else(default_id),
    )
    .await
}

#[tauri::command]
pub async fn sync_list_configs(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
) -> Result<Vec<SyncConfig>> {
    sync::list_configs(&state.pool, &runtime, &keystore_state).await
}

#[tauri::command]
pub async fn sync_configure(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
    input: SyncConfigureInput,
) -> Result<()> {
    sync::configure(
        &state.pool,
        &runtime,
        &keystore_state,
        &state.app_data_dir,
        &vault_id.unwrap_or_else(default_id),
        input,
    )
    .await
}

#[tauri::command]
pub async fn sync_set_passphrase(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
    passphrase: String,
    remember: bool,
) -> Result<()> {
    sync::set_passphrase(
        &state.pool,
        &runtime,
        &keystore_state,
        &vault_id.unwrap_or_else(default_id),
        passphrase,
        remember,
    )
    .await
}

#[tauri::command]
pub async fn sync_disable(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    vault_id: Option<String>,
) -> Result<()> {
    sync::disable(
        &state.pool,
        &runtime,
        &keystore_state,
        &vault_id.unwrap_or_else(default_id),
    )
    .await
}

#[tauri::command]
pub async fn sync_now(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    collab_runtime: State<'_, CollaborationRuntimeState>,
    vault_id: Option<String>,
) -> Result<SyncReport> {
    sync::sync_now(
        &state.pool,
        &runtime,
        &keystore_state,
        &collab_runtime,
        &state.app_data_dir,
        &vault_id.unwrap_or_else(default_id),
    )
    .await
}

#[tauri::command]
pub async fn sync_resolve(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    keystore_state: State<'_, KeystoreState>,
    collab_runtime: State<'_, CollaborationRuntimeState>,
    vault_id: Option<String>,
    resolutions: Vec<ConflictResolution>,
) -> Result<SyncReport> {
    sync::sync_resolve(
        &state.pool,
        &runtime,
        &keystore_state,
        &collab_runtime,
        &state.app_data_dir,
        &vault_id.unwrap_or_else(default_id),
        &resolutions,
    )
    .await
}
