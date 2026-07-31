use tauri::State;

use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::ssh::TunnelManager;
use crate::web_preview::{WebPreview, WebPreviewDiscovery, WebPreviewManager};
use crate::AppState;

#[tauri::command]
pub async fn web_preview_discover(
    state: State<'_, AppState>,
    manager: State<'_, WebPreviewManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<WebPreviewDiscovery> {
    manager
        .discover(&state.pool, &keystore_state, &host_id)
        .await
}

#[tauri::command]
pub async fn web_preview_open(
    state: State<'_, AppState>,
    manager: State<'_, WebPreviewManager>,
    tunnels: State<'_, TunnelManager>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
    port: u16,
    remote_bind: Option<String>,
) -> Result<WebPreview> {
    manager
        .open(
            &state.pool,
            &keystore_state,
            &tunnels,
            &host_id,
            port,
            remote_bind,
        )
        .await
}

#[tauri::command]
pub async fn web_preview_close(
    manager: State<'_, WebPreviewManager>,
    tunnels: State<'_, TunnelManager>,
    tunnel_id: String,
) -> Result<()> {
    manager.close(&tunnels, &tunnel_id).await
}

#[tauri::command]
pub async fn web_previews_list(manager: State<'_, WebPreviewManager>) -> Result<Vec<WebPreview>> {
    Ok(manager.list())
}
