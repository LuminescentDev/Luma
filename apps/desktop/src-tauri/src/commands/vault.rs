use crate::errors::Result;
use crate::{
    vault::{self, VaultState, VaultStatus},
    AppState,
};
use serde::Deserialize;
use tauri::State;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSetupInput {
    password: String,
    remember_device: bool,
}
#[tauri::command]
pub async fn vault_status(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
) -> Result<VaultStatus> {
    vault::status(&state.pool, &vault_state).await
}
#[tauri::command]
pub async fn vault_setup(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    input: VaultSetupInput,
) -> Result<()> {
    vault::setup(
        &state.pool,
        &vault_state,
        &input.password,
        input.remember_device,
    )
    .await
}
#[tauri::command]
pub async fn vault_unlock(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    password: String,
) -> Result<()> {
    vault::unlock(&state.pool, &vault_state, &password).await
}
#[tauri::command]
pub fn vault_lock(vault_state: State<'_, VaultState>) {
    vault::lock(&vault_state)
}
#[tauri::command]
pub async fn vault_set_policy(
    state: State<'_, AppState>,
    vault_state: State<'_, VaultState>,
    remember_device: bool,
) -> Result<()> {
    vault::set_policy(&state.pool, &vault_state, remember_device).await
}
