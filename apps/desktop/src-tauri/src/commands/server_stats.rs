use tauri::State;

use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::server_stats::{ServerStatsManager, ServerStatsSnapshot};
use crate::AppState;

#[tauri::command]
pub async fn server_stats_fetch(
    state: State<'_, AppState>,
    manager: State<'_, ServerStatsManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<ServerStatsSnapshot> {
    manager.fetch(&state.pool, &keystore_state, &host_id).await
}

#[tauri::command]
pub async fn server_stats_close(
    manager: State<'_, ServerStatsManager>,
    host_id: String,
) -> Result<()> {
    manager.close(&host_id).await
}
