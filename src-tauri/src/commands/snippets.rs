use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::errors::Result;
use crate::snippet_runs::{self, SnippetRunEvent, SnippetRunManager, SnippetRunStartResponse};
use crate::storage::snippets::{self, Snippet, SnippetInput};
use crate::AppState;

#[tauri::command]
pub async fn snippets_list(state: State<'_, AppState>) -> Result<Vec<Snippet>> {
    snippets::list(&state.pool).await
}

#[tauri::command]
pub async fn snippet_create(state: State<'_, AppState>, input: SnippetInput) -> Result<Snippet> {
    snippets::create(&state.pool, input).await
}

#[tauri::command]
pub async fn snippet_update(
    state: State<'_, AppState>,
    id: String,
    input: SnippetInput,
) -> Result<Snippet> {
    snippets::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn snippet_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    snippets::delete(&state.pool, &id).await
}

#[tauri::command]
pub async fn snippet_run_hosts(
    app: AppHandle,
    manager: State<'_, SnippetRunManager>,
    snippet_command: String,
    host_ids: Vec<String>,
    timeout_secs: Option<u64>,
    on_event: Channel<SnippetRunEvent>,
) -> Result<SnippetRunStartResponse> {
    snippet_runs::start(
        app,
        &manager,
        snippet_command,
        host_ids,
        timeout_secs,
        on_event,
    )
    .await
}

#[tauri::command]
pub fn snippet_run_cancel(manager: State<'_, SnippetRunManager>, run_id: String) -> Result<()> {
    manager.cancel(&run_id)
}
