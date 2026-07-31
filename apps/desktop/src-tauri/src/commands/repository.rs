use tauri::State;

use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::repository::{RepoDiff, RepoFile, RepoStatus, RepositoryManager};
use crate::AppState;

/// Repository context for the working directory a terminal session reported
/// through OSC 7. Read-only: nothing here stages, commits or writes.
#[tauri::command]
pub async fn repo_status(
    state: State<'_, AppState>,
    manager: State<'_, RepositoryManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    cwd: String,
) -> Result<RepoStatus> {
    manager
        .status(&state.pool, &keystore_state, &host_id, &cwd)
        .await
}

#[tauri::command]
pub async fn repo_diff(
    state: State<'_, AppState>,
    manager: State<'_, RepositoryManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    cwd: String,
    path: String,
    staged: bool,
) -> Result<RepoDiff> {
    manager
        .diff(&state.pool, &keystore_state, &host_id, &cwd, &path, staged)
        .await
}

#[tauri::command]
pub async fn repo_file(
    state: State<'_, AppState>,
    manager: State<'_, RepositoryManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    cwd: String,
    path: String,
    rev: Option<String>,
) -> Result<RepoFile> {
    manager
        .file(
            &state.pool,
            &keystore_state,
            &host_id,
            &cwd,
            &path,
            rev.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn repo_close(manager: State<'_, RepositoryManager>, host_id: String) -> Result<()> {
    manager.close(&host_id).await
}
