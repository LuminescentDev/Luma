use tauri::State;

use crate::errors::Result;
use crate::sync::{
    self, ConflictResolution, ExportSummary, ImportPreview, ImportSummary, SyncConfig,
    SyncConfigureInput, SyncReport, SyncRuntimeState,
};
use crate::AppState;

#[tauri::command]
pub async fn export_encrypted(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<ExportSummary> {
    sync::export_encrypted(&state.pool, &state.app_data_dir, &path, &passphrase).await
}

#[tauri::command]
pub async fn import_preview(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<ImportPreview> {
    sync::import_preview(&state.pool, &state.app_data_dir, &path, &passphrase).await
}

#[tauri::command]
pub async fn import_apply(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    resolutions: Vec<ConflictResolution>,
) -> Result<ImportSummary> {
    sync::import_apply(
        &state.pool,
        &state.app_data_dir,
        &path,
        &passphrase,
        &resolutions,
    )
    .await
}

#[tauri::command]
pub async fn sync_get_config(state: State<'_, AppState>) -> Result<SyncConfig> {
    sync::get_config(&state.pool).await
}

#[tauri::command]
pub async fn sync_configure(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    input: SyncConfigureInput,
) -> Result<()> {
    sync::configure(&state.pool, &runtime, &state.app_data_dir, input).await
}

#[tauri::command]
pub fn sync_set_passphrase(
    runtime: State<'_, SyncRuntimeState>,
    passphrase: String,
    remember: bool,
) -> Result<()> {
    sync::set_passphrase(&runtime, passphrase, remember)
}

#[tauri::command]
pub async fn sync_disable(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
) -> Result<()> {
    sync::disable(&state.pool, &runtime).await
}

#[tauri::command]
pub async fn sync_now(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
) -> Result<SyncReport> {
    sync::sync_now(&state.pool, &runtime, &state.app_data_dir).await
}

#[tauri::command]
pub async fn sync_resolve(
    state: State<'_, AppState>,
    runtime: State<'_, SyncRuntimeState>,
    resolutions: Vec<ConflictResolution>,
) -> Result<SyncReport> {
    sync::sync_resolve(&state.pool, &runtime, &state.app_data_dir, &resolutions).await
}
