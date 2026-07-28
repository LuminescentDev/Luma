use crate::errors::Result;
use crate::{
    keystore::{self, KeystoreState, KeystoreStatus},
    AppState,
};
use serde::Deserialize;
use tauri::State;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeystoreSetupInput {
    password: String,
    remember_device: bool,
}
#[tauri::command]
pub async fn keystore_status(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
) -> Result<KeystoreStatus> {
    keystore::status(&state.pool, &keystore_state).await
}
#[tauri::command]
pub async fn keystore_setup(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    input: KeystoreSetupInput,
) -> Result<()> {
    keystore::setup(
        &state.pool,
        &keystore_state,
        &input.password,
        input.remember_device,
    )
    .await
}
#[tauri::command]
pub async fn keystore_unlock(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    password: String,
) -> Result<()> {
    keystore::unlock(&state.pool, &keystore_state, &password).await
}
#[tauri::command]
pub fn keystore_lock(keystore_state: State<'_, KeystoreState>) {
    keystore::lock(&keystore_state)
}
#[tauri::command]
pub async fn keystore_set_policy(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    remember_device: bool,
) -> Result<()> {
    keystore::set_policy(&state.pool, &keystore_state, remember_device).await
}
