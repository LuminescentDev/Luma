use std::collections::HashMap;

use serde_json::Value;
use tauri::State;

use crate::errors::Result;
use crate::storage::settings;
use crate::AppState;

#[tauri::command]
pub async fn settings_get_all(state: State<'_, AppState>) -> Result<HashMap<String, Value>> {
    settings::all(&state.pool).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: Value) -> Result<()> {
    settings::set(&state.pool, &key, &value).await
}

#[tauri::command]
pub async fn settings_delete(state: State<'_, AppState>, key: String) -> Result<()> {
    settings::delete(&state.pool, &key).await
}
