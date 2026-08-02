use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::sftp::{
    self, DirectoryListing, SftpConnectResponse, SftpManager, SftpSessionInfo, TransferProgress,
    TransferStartResponse,
};
use crate::ssh;
use crate::AppState;

#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, AppState>,
    manager: State<'_, SftpManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<SftpConnectResponse> {
    manager
        .connect(&state.pool, &keystore_state, &host_id)
        .await
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
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_list(path: Option<String>) -> Result<DirectoryListing> {
    sftp::local_list(path).await
}

#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_mkdir(path: String) -> Result<()> {
    sftp::local_mkdir(path).await
}

#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_rename(state: State<'_, AppState>, from: String, to: String) -> Result<()> {
    sftp::local_rename(from, to, state.app_data_dir.clone()).await
}

#[tauri::command]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
pub async fn sftp_copy(
    manager: State<'_, SftpManager>,
    source_session_id: String,
    source_path: String,
    dest_session_id: String,
    dest_path: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    sftp::sftp_copy(
        &manager,
        &source_session_id,
        &source_path,
        &dest_session_id,
        &dest_path,
        on_progress,
    )
    .await
}

#[tauri::command]
pub async fn sftp_cancel(manager: State<'_, SftpManager>, transfer_id: String) -> Result<()> {
    manager.cancel_transfer(&transfer_id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachUploadResponse {
    pub remote_path: String,
}

/// Upload a local file to a private staging directory on an SSH host so the
/// terminal UI can insert the returned remote path at the prompt.
///
/// Reuses an SFTP session the user already has open for the host — a second
/// authenticated connection per attachment costs a full handshake and can put
/// an interactive or 2FA prompt in the middle of attaching a file. Only a
/// session this command opened itself is closed afterwards.
#[tauri::command]
pub async fn terminal_attach_upload(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    manager: State<'_, SftpManager>,
    host_id: String,
    local_path: String,
    file_name: Option<String>,
) -> Result<TerminalAttachUploadResponse> {
    ssh::validate_host_id(&host_id)?;
    // Reading the home directory doubles as the liveness check: a session that
    // has since died falls through to opening a dedicated one.
    let reusable = match manager.session_for_host(&host_id) {
        Some(session_id) => match manager.home_directory(&session_id).await {
            Ok(home) => Some((session_id, home)),
            Err(error) => {
                tracing::debug!(%error, "reusable SFTP session was unusable; opening a new one");
                None
            }
        },
        None => None,
    };
    let (session_id, home, opened_here) = match reusable {
        Some((session_id, home)) => (session_id, home, false),
        None => {
            let session = manager
                .connect(&state.pool, &keystore_state, &host_id)
                .await?;
            (session.sftp_session_id, session.initial_path, true)
        }
    };
    let upload_result = sftp::upload_attachment(
        &manager,
        &session_id,
        &home,
        &local_path,
        file_name.as_deref(),
    )
    .await;
    // Never close a session the user opened; only the one this command made.
    if opened_here {
        if let Err(error) = manager.disconnect(&session_id).await {
            tracing::warn!(%error, "failed to close SFTP session after attachment upload");
        }
    }
    upload_result.map(|remote_path| TerminalAttachUploadResponse { remote_path })
}

#[tauri::command]
pub async fn sftp_retry(
    manager: State<'_, SftpManager>,
    transfer_id: String,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    sftp::sftp_retry(&manager, &transfer_id, on_progress).await
}
