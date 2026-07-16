use tauri::ipc::Channel;
use tauri::State;

use crate::errors::{LumaError, Result};
use crate::ssh::{self, TunnelExit, TunnelInfo, TunnelManager, TunnelStartResponse};
use crate::storage::port_forwards::{self, PortForward, PortForwardInput};
use crate::terminal::PtyManager;
use crate::AppState;

#[tauri::command]
pub async fn port_forwards_list(
    state: State<'_, AppState>,
    host_id: Option<String>,
) -> Result<Vec<PortForward>> {
    let host_id = host_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    port_forwards::list(&state.pool, host_id).await
}

#[tauri::command]
pub async fn port_forward_create(
    state: State<'_, AppState>,
    input: PortForwardInput,
) -> Result<PortForward> {
    port_forwards::create(&state.pool, input).await
}

#[tauri::command]
pub async fn port_forward_update(
    state: State<'_, AppState>,
    id: String,
    input: PortForwardInput,
) -> Result<PortForward> {
    port_forwards::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn port_forward_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    port_forwards::delete(&state.pool, &id).await
}

#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    pty: State<'_, PtyManager>,
    tunnels: State<'_, TunnelManager>,
    port_forward_id: String,
    on_exit: Channel<TunnelExit>,
) -> Result<TunnelStartResponse> {
    let port_forward = port_forwards::get(&state.pool, &port_forward_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown port forward".into()))?;
    let config = ssh::tunnel_connection_config(&state.pool, &port_forward.host_id).await?;
    let tunnel_id = tunnels.start(&pty, config, port_forward, move |exit| {
        let _ = on_exit.send(exit);
    })?;
    Ok(TunnelStartResponse { tunnel_id })
}

#[tauri::command]
pub async fn tunnel_stop(
    pty: State<'_, PtyManager>,
    tunnels: State<'_, TunnelManager>,
    tunnel_id: String,
) -> Result<()> {
    tunnels.stop(&pty, &tunnel_id)
}

#[tauri::command]
pub async fn tunnels_list(tunnels: State<'_, TunnelManager>) -> Result<Vec<TunnelInfo>> {
    Ok(tunnels.list())
}
