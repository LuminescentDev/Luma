use tauri::State;

use crate::errors::Result;
use crate::storage::vaults::{self, Vault, VaultInput};
use crate::AppState;

#[tauri::command]
pub async fn vaults_list(state: State<'_, AppState>) -> Result<Vec<Vault>> {
    vaults::list(&state.pool).await
}

#[tauri::command]
pub async fn vault_get(state: State<'_, AppState>, id: String) -> Result<Option<Vault>> {
    vaults::get(&state.pool, &id).await
}

#[tauri::command]
pub async fn vault_create(state: State<'_, AppState>, input: VaultInput) -> Result<Vault> {
    vaults::create(&state.pool, input).await
}

#[tauri::command]
pub async fn vault_update(
    state: State<'_, AppState>,
    id: String,
    input: VaultInput,
) -> Result<Vault> {
    vaults::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn vault_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    vaults::delete(&state.pool, &id).await
}
