use tauri::State;

use crate::docker::{
    DockerAction, DockerActionResult, DockerInspect, DockerList, DockerLogs, DockerManager,
    DockerStat,
};
use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::AppState;

/// Docker containers on an SSH host, grouped by Compose project. Read-only.
/// A host without docker is not an error — `available` is false and
/// `unavailableReason` says why.
#[tauri::command]
pub async fn docker_list(
    state: State<'_, AppState>,
    manager: State<'_, DockerManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<DockerList> {
    manager.list(&state.pool, &keystore_state, &host_id).await
}

/// Live CPU/memory sample. Separate from `docker_list` because
/// `docker stats --no-stream` takes seconds, so the UI asks on demand.
#[tauri::command]
pub async fn docker_stats(
    state: State<'_, AppState>,
    manager: State<'_, DockerManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<Vec<DockerStat>> {
    manager.stats(&state.pool, &keystore_state, &host_id).await
}

#[tauri::command]
pub async fn docker_logs(
    state: State<'_, AppState>,
    manager: State<'_, DockerManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    container: String,
    tail: u32,
) -> Result<DockerLogs> {
    manager
        .logs(&state.pool, &keystore_state, &host_id, &container, tail)
        .await
}

/// Container configuration. Environment values whose key looks like a
/// credential are replaced in Rust before serialisation, so the real secret
/// never reaches the frontend.
#[tauri::command]
pub async fn docker_inspect(
    state: State<'_, AppState>,
    manager: State<'_, DockerManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    container: String,
) -> Result<DockerInspect> {
    manager
        .inspect(&state.pool, &keystore_state, &host_id, &container)
        .await
}

/// The only mutating docker command Luma exposes, and deliberately the smallest
/// useful set: `start`, `stop` and `restart` are each undone by another action
/// in the same dialog. Removal, recreation and Compose lifecycle commands are
/// NOT offered — they destroy state or need project-directory discovery, and the
/// backlog item asks for read-only first with mutations added only where the
/// safety story is unambiguous. Anything outside the three is rejected here
/// before a subcommand is ever built.
#[tauri::command]
pub async fn docker_action(
    state: State<'_, AppState>,
    manager: State<'_, DockerManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    container: String,
    action: String,
) -> Result<DockerActionResult> {
    let action = DockerAction::parse(&action)?;
    manager
        .action(&state.pool, &keystore_state, &host_id, &container, action)
        .await
}

/// Drop the cached SSH connection this host's docker views were using.
#[tauri::command]
pub async fn docker_close(manager: State<'_, DockerManager>, host_id: String) -> Result<()> {
    manager.close(&host_id).await
}
