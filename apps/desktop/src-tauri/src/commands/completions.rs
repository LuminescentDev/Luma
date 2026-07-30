use tauri::State;

use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::shell_completions::ShellCompletionsManager;
use crate::storage::command_history::{self, CommandHistoryEntry};
use crate::AppState;

/// Record one executed command line for a scope. Filtered lines (leading space,
/// secret-bearing, empty, oversized) return `false` and store nothing.
#[tauri::command]
pub async fn command_history_record(
    state: State<'_, AppState>,
    scope_key: String,
    command: String,
) -> Result<bool> {
    command_history::record(&state.pool, &scope_key, &command).await
}

/// Prefix-matched history for a scope, most-used first.
#[tauri::command]
pub async fn command_history_query(
    state: State<'_, AppState>,
    scope_key: String,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<CommandHistoryEntry>> {
    command_history::query(&state.pool, &scope_key, &prefix, limit.unwrap_or(20)).await
}

/// Names on the remote host's `$PATH`, for first-token completion (SSH only).
#[tauri::command]
pub async fn shell_completions_executables(
    state: State<'_, AppState>,
    manager: State<'_, ShellCompletionsManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<Vec<String>> {
    manager
        .executables(&state.pool, &keystore_state, &host_id)
        .await
}

/// Entries of one remote directory, for path-token completion (SSH only).
/// Directory entries carry a trailing `/`.
#[tauri::command]
pub async fn shell_completions_paths(
    state: State<'_, AppState>,
    manager: State<'_, ShellCompletionsManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    dir: String,
) -> Result<Vec<String>> {
    manager
        .paths(&state.pool, &keystore_state, &host_id, &dir)
        .await
}
