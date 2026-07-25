use tauri::State;

use crate::errors::Result;
use crate::import::{self, ImportHostsRequest, ImportedHostCandidate, ImportedHostsResult};
use crate::AppState;

#[tauri::command]
pub async fn import_hosts_preview(
    state: State<'_, AppState>,
    source: String,
    path: String,
) -> Result<Vec<ImportedHostCandidate>> {
    import::preview_hosts(&state.pool, source, path).await
}

#[tauri::command]
pub async fn import_hosts_apply(
    state: State<'_, AppState>,
    source: String,
    path: String,
    request: ImportHostsRequest,
) -> Result<ImportedHostsResult> {
    import::apply_hosts(&state.pool, source, path, request).await
}
