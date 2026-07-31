use tauri::State;

use crate::errors::Result;
use crate::storage::voice_history::{self, VoiceHistoryEntry, VoiceSource};
use crate::AppState;

/*
 * Voice composer draft history. Device-local, recorded only on an explicit send.
 * Draft contents are user data and never reach the log — these wrappers pass
 * them straight through to the storage layer.
 */

/// Record one sent draft. Returns the stored entry, or `null` when the draft was
/// empty or oversized.
#[tauri::command]
pub async fn voice_history_add(
    state: State<'_, AppState>,
    draft: String,
    source: Option<VoiceSource>,
) -> Result<Option<VoiceHistoryEntry>> {
    voice_history::add(&state.pool, &draft, source.unwrap_or(VoiceSource::Typed)).await
}

/// Most recent drafts first.
#[tauri::command]
pub async fn voice_history_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<VoiceHistoryEntry>> {
    voice_history::list(&state.pool, limit.unwrap_or(50)).await
}

/// Remove one entry. Returns whether a row was deleted.
#[tauri::command]
pub async fn voice_history_delete(state: State<'_, AppState>, id: i64) -> Result<bool> {
    voice_history::delete(&state.pool, id).await
}

/// Remove every entry. Returns how many rows were removed.
#[tauri::command]
pub async fn voice_history_clear(state: State<'_, AppState>) -> Result<u64> {
    voice_history::clear(&state.pool).await
}
