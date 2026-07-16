use tauri::State;

use crate::errors::Result;
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
