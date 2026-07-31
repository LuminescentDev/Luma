use tauri::State;

use crate::errors::Result;
use crate::keystore::KeystoreState;
use crate::multiplexer::MultiplexerDiscovery;
use crate::AppState;

/// Enumerate tmux/zellij workspaces on a host. Read-only: attaching happens
/// through `ssh_spawn`'s multiplexer request, never from here.
#[tauri::command]
pub async fn multiplexer_list(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    host_id: String,
) -> Result<MultiplexerDiscovery> {
    crate::multiplexer::list(&state.pool, &keystore_state, &host_id).await
}
