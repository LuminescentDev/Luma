use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::errors::Result;
use crate::ssh::{
    self, OpenSshEngine, SshConfigCandidate, SshConfigImportRequest, SshConfigImportResult,
    SshDetection, SshEngine, SshExit,
};
use crate::storage::hosts;
use crate::terminal::PtyManager;
use crate::vault::VaultState;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnRequest {
    pub host_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnResponse {
    pub session_id: String,
    pub title: String,
}

#[tauri::command]
pub async fn ssh_detect() -> Result<SshDetection> {
    Ok(ssh::detect())
}

#[tauri::command]
pub async fn ssh_spawn(
    state: State<'_, AppState>,
    pty: State<'_, PtyManager>,
    vault_state: State<'_, VaultState>,
    request: SshSpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<SshExit>,
) -> Result<SshSpawnResponse> {
    let (config, title) =
        ssh::connection_config(&state.pool, &vault_state, &request.host_id).await?;
    let engine = OpenSshEngine::new(&pty);
    let session_id = engine.connect(
        config,
        request.cols,
        request.rows,
        Box::new(move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes.to_vec()));
        }),
        Box::new(move |exit| {
            let _ = on_exit.send(exit);
        }),
    )?;

    if let Err(error) = hosts::record_recent_connection(&state.pool, &request.host_id).await {
        let _ = engine.disconnect(&session_id);
        return Err(error);
    }

    Ok(SshSpawnResponse { session_id, title })
}

#[tauri::command]
pub async fn ssh_config_preview(state: State<'_, AppState>) -> Result<Vec<SshConfigCandidate>> {
    ssh::preview_config(&state.pool).await
}

#[tauri::command]
pub async fn ssh_config_import(
    state: State<'_, AppState>,
    request: SshConfigImportRequest,
) -> Result<SshConfigImportResult> {
    ssh::import_config(&state.pool, request).await
}
