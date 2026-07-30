//! Desktop-only `mosh_spawn`, structured like `ssh_spawn`. Bootstraps a
//! mosh-server over the host's embedded SSH configuration, then spawns the
//! local mosh-client through the normal PTY infrastructure. The session key
//! travels exclusively via the child's environment: never returned to the
//! frontend, never logged.

use std::collections::HashMap;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::commands::ssh::{SshSpawnRequest, SshSpawnResponse};
use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::mosh;
use crate::ssh::{self, SshExit};
use crate::storage::hosts;
use crate::terminal::{PtyManager, ResolvedShell};
use crate::AppState;

#[tauri::command]
pub async fn mosh_spawn(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    pty: State<'_, PtyManager>,
    request: SshSpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<SshExit>,
) -> Result<SshSpawnResponse> {
    ssh::validate_host_id(&request.host_id)?;
    if request.cols == 0 || request.rows == 0 {
        return Err(LumaError::InvalidInput(
            "terminal dimensions must be greater than zero".into(),
        ));
    }
    let host = hosts::get(&state.pool, &request.host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;

    // Fail fast on the local prerequisite before any network work.
    let client_path = mosh::find_mosh_client().ok_or_else(mosh::missing_client_error)?;
    let command = mosh::bootstrap_command(
        host.mosh_server_path.as_deref(),
        host.mosh_port_range.as_deref(),
    )?;

    // Bootstrap over the same embedded SSH machinery ssh_spawn uses (host-key
    // verification, identities, proxy jumps). The exec channel must not run the
    // host's startup command.
    let (mut config, title) =
        ssh::connection_config(&state.pool, &keystore_state, &request.host_id).await?;
    config.startup_command = None;
    let connection = ssh::authenticated_handle(&config).await?;
    let bootstrap = mosh::bootstrap(&connection, &command).await;
    // The SSH session only carries the bootstrap; Mosh itself is direct UDP.
    let _ = connection
        .disconnect(
            russh::Disconnect::ByApplication,
            "mosh bootstrap complete",
            "en",
        )
        .await;
    let bootstrap = bootstrap?;

    let target = mosh::resolve_target(&config.hostname, host.port).await;
    let mut environment = HashMap::new();
    // The session key: environment-only. PtyManager logs the binary path, not
    // the environment, so the key never reaches the logs.
    environment.insert("MOSH_KEY".to_string(), bootstrap.key);
    // mosh-client requires a UTF-8 locale; match the bootstrap's -l flag.
    environment.insert("LANG".to_string(), "en_US.UTF-8".to_string());
    let shell = ResolvedShell {
        path: client_path.to_string_lossy().into_owned(),
        args: vec![target, bootstrap.udp_port.to_string()],
        working_directory: None,
        environment,
    };
    let session_id = pty.spawn(
        shell,
        request.cols,
        request.rows,
        move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes.to_vec()));
        },
        move |code| {
            let _ = on_exit.send(SshExit {
                code,
                error_category: None,
                error_message: None,
            });
        },
    )?;

    if let Err(error) = hosts::record_recent_connection(&state.pool, &request.host_id).await {
        let _ = pty.kill(&session_id);
        return Err(error);
    }

    tracing::info!(host_id = %request.host_id, "spawned mosh session");
    Ok(SshSpawnResponse { session_id, title })
}
