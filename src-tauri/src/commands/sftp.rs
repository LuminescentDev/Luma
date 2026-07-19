use tauri::ipc::Channel;
use tauri::State;

use crate::errors::Result;
use crate::sftp::{
    self, DirectoryListing, SftpConnectResponse, SftpManager, SftpSessionInfo, TransferProgress,
    TransferStartResponse,
};
use crate::vault::VaultState;
use crate::AppState;

#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, AppState>,
    manager: State<'_, SftpManager>,
    vault_state: State<'_, VaultState>,
    host_id: String,
) -> Result<SftpConnectResponse> {
    manager.connect(&state.pool, &vault_state, &host_id).await
}

#[tauri::command]
pub async fn sftp_disconnect(
    manager: State<'_, SftpManager>,
    sftp_session_id: String,
) -> Result<()> {
    manager.disconnect(&sftp_session_id).await
}

#[tauri::command]
pub async fn sftp_sessions(manager: State<'_, SftpManager>) -> Result<Vec<SftpSessionInfo>> {
    Ok(manager.list())
}

#[tauri::command]
pub async fn sftp_list(
    manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<DirectoryListing> {
    sftp::list(&manager, &session_id, &path).await
}

#[tauri::command]
pub async fn sftp_mkdir(
    manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
) -> Result<()> {
    sftp::mkdir(&manager, &session_id, &path).await
}

#[tauri::command]
pub async fn sftp_rename(
    manager: State<'_, SftpManager>,
    session_id: String,
    from: String,
    to: String,
) -> Result<()> {
    sftp::rename(&manager, &session_id, &from, &to).await
}

#[tauri::command]
pub async fn sftp_delete(
    manager: State<'_, SftpManager>,
    session_id: String,
    path: String,
    recursive: bool,
) -> Result<()> {
    sftp::delete(&manager, &session_id, &path, recursive).await
}

#[tauri::command]
pub async fn local_list(path: Option<String>) -> Result<DirectoryListing> {
    sftp::local_list(path).await
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<()> {
    sftp::local_mkdir(path).await
}

#[tauri::command]
pub async fn local_rename(state: State<'_, AppState>, from: String, to: String) -> Result<()> {
    sftp::local_rename(from, to, state.app_data_dir.clone()).await
}

#[tauri::command]
pub async fn local_delete(state: State<'_, AppState>, path: String, recursive: bool) -> Result<()> {
    sftp::local_delete(path, recursive, state.app_data_dir.clone()).await
}

#[tauri::command]
pub async fn sftp_upload(
    manager: State<'_, SftpManager>,
    session_id: String,
    local_path: String,
    remote_path: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    sftp::sftp_upload(
        &manager,
        &session_id,
        &local_path,
        &remote_path,
        on_progress,
    )
    .await
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    manager: State<'_, SftpManager>,
    session_id: String,
    remote_path: String,
    local_path: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    sftp::sftp_download(
        &manager,
        &session_id,
        &remote_path,
        &local_path,
        &state.app_data_dir,
        on_progress,
    )
    .await
}

#[tauri::command]
pub async fn sftp_cancel(manager: State<'_, SftpManager>, transfer_id: String) -> Result<()> {
    manager.cancel_transfer(&transfer_id)
}

#[tauri::command]
pub async fn sftp_retry(
    manager: State<'_, SftpManager>,
    transfer_id: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    sftp::sftp_retry(&manager, &transfer_id, on_progress).await
}
