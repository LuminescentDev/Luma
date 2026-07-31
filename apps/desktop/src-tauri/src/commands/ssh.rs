use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::multiplexer::MultiplexerAttach;
use crate::sftp::{self, SftpManager};
use crate::ssh::{self, EmbeddedSshManager, SshExit, SshHostKeyStatus, SshRemoteOs};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::ssh::{SshConfigCandidate, SshConfigImportRequest, SshConfigImportResult};
use crate::storage::{hosts, key_references};
use crate::AppState;

pub const SSH_REMOTE_OS_EVENT_NAME: &str = "ssh-remote-os";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnRequest {
    pub host_id: String,
    pub cols: u16,
    pub rows: u16,
    /// Optional multiplexer workspace to land in. The frontend names a
    /// multiplexer and a session, never a command: `attach_command` builds the
    /// actual `tmux`/`zellij` invocation from a validated name, so this cannot
    /// become an arbitrary-command channel.
    #[serde(default)]
    pub multiplexer: Option<MultiplexerAttach>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSpawnResponse {
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshLatencyResponse {
    pub latency_ms: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SshKeyInstallStatus {
    Installed,
    AlreadyPresent,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInstallResponse {
    pub status: SshKeyInstallStatus,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostKeyRequest {
    pub host_id: String,
}

/// Emitted once for an authenticated SSH session after best-effort remote OS
/// detection. `os_id` is always one of the fixed identifiers documented by
/// the `ssh-remote-os` frontend contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRemoteOsEvent {
    pub session_id: String,
    pub host_id: String,
    pub os_id: String,
    pub pretty_name: Option<String>,
}

#[derive(Default)]
struct PendingRemoteOsEvent {
    session_id: Option<String>,
    host_id: String,
    ready: bool,
    metadata: Option<SshRemoteOs>,
}

fn take_remote_os_event(state: &Arc<Mutex<PendingRemoteOsEvent>>) -> Option<SshRemoteOsEvent> {
    let mut state = state.lock().unwrap();
    if !state.ready {
        return None;
    }
    let session_id = state.session_id.clone()?;
    let metadata = state.metadata.take()?;
    Some(SshRemoteOsEvent {
        session_id,
        host_id: state.host_id.clone(),
        os_id: metadata.os_id,
        pretty_name: metadata.pretty_name,
    })
}

#[tauri::command]
pub async fn quick_connect_prepare(
    state: State<'_, AppState>,
    input: String,
) -> Result<crate::storage::hosts::Host> {
    hosts::create_ephemeral(&state.pool, &input).await
}

#[tauri::command]
pub async fn quick_connect_save(
    state: State<'_, AppState>,
    host_id: String,
    name: Option<String>,
    vault_id: Option<String>,
) -> Result<crate::storage::hosts::Host> {
    ssh::validate_host_id(&host_id)?;
    hosts::save_ephemeral(&state.pool, &host_id, name.as_deref(), vault_id.as_deref()).await
}

#[tauri::command]
pub async fn ssh_ping(
    embedded: State<'_, EmbeddedSshManager>,
    session_id: String,
) -> Result<SshLatencyResponse> {
    embedded
        .ping(&session_id)
        .await?
        .map(|latency_ms| SshLatencyResponse { latency_ms })
        .ok_or_else(|| LumaError::InvalidInput("unknown SSH session".into()))
}

#[tauri::command]
pub fn ssh_write(
    embedded: State<'_, EmbeddedSshManager>,
    session_id: String,
    data: String,
) -> Result<()> {
    if embedded.write(&session_id, data)? {
        Ok(())
    } else {
        Err(LumaError::InvalidInput("unknown SSH session".into()))
    }
}

#[tauri::command]
pub fn ssh_resize(
    embedded: State<'_, EmbeddedSshManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    if cols == 0 || rows == 0 {
        return Err(LumaError::InvalidInput(
            "terminal dimensions must be greater than zero".into(),
        ));
    }
    if embedded.resize(&session_id, cols, rows)? {
        Ok(())
    } else {
        Err(LumaError::InvalidInput("unknown SSH session".into()))
    }
}

#[tauri::command]
pub fn ssh_disconnect(embedded: State<'_, EmbeddedSshManager>, session_id: String) -> Result<()> {
    if embedded.disconnect(&session_id)? {
        Ok(())
    } else {
        Err(LumaError::InvalidInput("unknown SSH session".into()))
    }
}

/// Enables forwarding for one already-authenticated session. The frontend
/// exposes this only behind a warning/confirmation, and there is deliberately
/// no global or persisted toggle.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn ssh_agent_forward_enable(
    embedded: State<'_, EmbeddedSshManager>,
    session_id: String,
) -> Result<()> {
    if embedded.enable_agent_forwarding(&session_id).await? {
        Ok(())
    } else {
        Err(LumaError::InvalidInput("unknown SSH session".into()))
    }
}

#[tauri::command]
pub async fn ssh_probe(state: State<'_, AppState>, host_id: String) -> Result<SshLatencyResponse> {
    ssh::validate_host_id(&host_id)?;
    let host = hosts::get(&state.pool, &host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    let started = Instant::now();
    tokio::time::timeout(
        Duration::from_secs(5),
        tokio::net::TcpStream::connect((host.hostname.as_str(), host.port)),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: "SSH TCP probe timed out".into(),
    })?
    .map_err(probe_error)?;
    Ok(SshLatencyResponse {
        latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    })
}

fn probe_error(error: std::io::Error) -> LumaError {
    let lower = error.to_string().to_ascii_lowercase();
    let category = if matches!(error.kind(), std::io::ErrorKind::TimedOut) {
        "timeout"
    } else if matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::HostUnreachable
            | std::io::ErrorKind::NetworkUnreachable
    ) {
        "host-unreachable"
    } else if lower.contains("name")
        && (lower.contains("resolve") || lower.contains("known") || lower.contains("getaddrinfo"))
    {
        "dns-failed"
    } else {
        "host-unreachable"
    };
    LumaError::SshConnection {
        category,
        message: format!("SSH TCP probe failed: {error}"),
    }
}

#[tauri::command]
pub async fn ssh_key_install(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    sftp_manager: State<'_, SftpManager>,
    host_id: String,
    key_reference_id: String,
) -> Result<SshKeyInstallResponse> {
    ssh::validate_host_id(&host_id)?;
    let key = key_references::get(&state.pool, &key_reference_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown key reference".into()))?;
    let public_key = key
        .public_key
        .ok_or_else(|| LumaError::KeyUnavailable("key reference has no public key".into()))?;
    let public_key = ssh_key::PublicKey::from_openssh(&public_key)
        .and_then(|key| key.to_openssh())
        .map_err(|_| LumaError::InvalidInput("stored public key is invalid".into()))?;

    let session = sftp_manager
        .connect(&state.pool, &keystore_state, &host_id)
        .await?;
    let install_result = sftp::install_authorized_key(
        &sftp_manager,
        &session.sftp_session_id,
        &session.initial_path,
        &public_key,
    )
    .await;
    let disconnect_result = sftp_manager.disconnect(&session.sftp_session_id).await;
    match install_result {
        Ok(installed) => {
            disconnect_result?;
            Ok(SshKeyInstallResponse {
                status: if installed {
                    SshKeyInstallStatus::Installed
                } else {
                    SshKeyInstallStatus::AlreadyPresent
                },
            })
        }
        Err(error) => {
            if let Err(disconnect_error) = disconnect_result {
                tracing::warn!(host_id = %host_id, %disconnect_error, "could not close key-install SFTP session");
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn ssh_host_key_status(
    state: State<'_, AppState>,
    keystore_state: State<'_, KeystoreState>,
    request: SshHostKeyRequest,
) -> Result<SshHostKeyStatus> {
    ssh::validate_host_id(&request.host_id)?;
    let known_hosts_file = ssh::known_hosts_file_path(&state.app_data_dir);
    let config = ssh::host_key_connection_config(
        &state.pool,
        &keystore_state,
        &request.host_id,
        known_hosts_file.clone(),
    )
    .await?;
    ssh::host_key_status(&request.host_id, &config, &known_hosts_file).await
}

#[tauri::command]
pub async fn ssh_host_key_trust(
    state: State<'_, AppState>,
    request: SshHostKeyRequest,
) -> Result<SshHostKeyStatus> {
    ssh::validate_host_id(&request.host_id)?;
    let host = hosts::get(&state.pool, &request.host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    let known_hosts_file = ssh::known_hosts_file_path(&state.app_data_dir);
    ssh::trust_host_key(&request.host_id, &host, &known_hosts_file)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ssh_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    embedded: State<'_, EmbeddedSshManager>,
    keystore_state: State<'_, KeystoreState>,
    request: SshSpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<SshExit>,
) -> Result<SshSpawnResponse> {
    ssh_spawn_impl(
        app,
        state,
        embedded,
        keystore_state,
        request,
        on_data,
        on_exit,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn ssh_spawn_impl(
    app: AppHandle,
    state: State<'_, AppState>,
    embedded: State<'_, EmbeddedSshManager>,
    keystore_state: State<'_, KeystoreState>,
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
    let (mut config, title) =
        ssh::connection_config(&state.pool, &keystore_state, &request.host_id).await?;
    // A multiplexer attach replaces the host's own startup command for this
    // spawn only; the built command is validated here, never supplied verbatim.
    if let Some(attach) = &request.multiplexer {
        config.startup_command = Some(crate::multiplexer::attach_command(attach)?);
    }
    let pending_remote_os = Arc::new(Mutex::new(PendingRemoteOsEvent {
        host_id: request.host_id.clone(),
        ..PendingRemoteOsEvent::default()
    }));
    let pending_remote_os_callback = Arc::clone(&pending_remote_os);
    let app_for_remote_os = app.clone();
    let pool_for_remote_os = state.pool.clone();
    let host_id_for_remote_os = request.host_id.clone();
    let agent_sink = crate::agent_events::AgentEventSink::new(app.clone());
    let agent_sink_for_data = agent_sink.clone();
    let mut agent_scanner = crate::agent_events::AgentEventScanner::new();
    let data_callback = Box::new(move |bytes: &[u8]| {
        agent_sink_for_data.publish(agent_scanner.scan(bytes));
        let _ = on_data.send(InvokeResponseBody::Raw(bytes.to_vec()));
    });
    let exit_callback = Box::new(move |exit| {
        let _ = on_exit.send(exit);
    });
    let remote_os_callback = Box::new(move |metadata: SshRemoteOs| {
        let stored_metadata = metadata.clone();
        let pool = pool_for_remote_os.clone();
        let host_id = host_id_for_remote_os.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = hosts::record_remote_os(
                &pool,
                &host_id,
                &stored_metadata.os_id,
                stored_metadata.pretty_name.as_deref(),
            )
            .await
            {
                tracing::warn!(host_id = %host_id, %error, "could not retain remote OS metadata");
            }
        });
        pending_remote_os_callback.lock().unwrap().metadata = Some(metadata);
        if let Some(event) = take_remote_os_event(&pending_remote_os_callback) {
            let _ = app_for_remote_os.emit_to("main", SSH_REMOTE_OS_EVENT_NAME, event);
        }
    });
    let session_id = embedded
        .connect(
            config,
            request.cols,
            request.rows,
            data_callback,
            exit_callback,
            remote_os_callback,
        )
        .await?;

    agent_sink.attach(&session_id);

    {
        pending_remote_os.lock().unwrap().session_id = Some(session_id.clone());
    }

    if let Err(error) = hosts::record_recent_connection(&state.pool, &request.host_id).await {
        let _ = embedded.disconnect(&session_id);
        return Err(error);
    }

    {
        pending_remote_os.lock().unwrap().ready = true;
    }
    if let Some(event) = take_remote_os_event(&pending_remote_os) {
        let _ = app.emit_to("main", SSH_REMOTE_OS_EVENT_NAME, event);
    }

    Ok(SshSpawnResponse { session_id, title })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn ssh_config_preview(
    state: State<'_, AppState>,
    vault_id: Option<String>,
) -> Result<Vec<SshConfigCandidate>> {
    ssh::preview_config(
        &state.pool,
        vault_id
            .as_deref()
            .unwrap_or(crate::storage::vaults::PERSONAL_VAULT_ID),
    )
    .await
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
pub async fn ssh_config_import(
    state: State<'_, AppState>,
    request: SshConfigImportRequest,
) -> Result<SshConfigImportResult> {
    ssh::import_config(&state.pool, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_os_event_is_consumed_exactly_once() {
        let state = Arc::new(Mutex::new(PendingRemoteOsEvent {
            session_id: Some("session-1".into()),
            host_id: "host-1".into(),
            ready: true,
            metadata: Some(SshRemoteOs {
                os_id: "ubuntu".into(),
                pretty_name: Some("Ubuntu 24.04 LTS".into()),
            }),
        }));

        let event = take_remote_os_event(&state).expect("event should be ready");
        assert_eq!(event.session_id, "session-1");
        assert_eq!(event.host_id, "host-1");
        assert_eq!(event.os_id, "ubuntu");
        assert_eq!(event.pretty_name.as_deref(), Some("Ubuntu 24.04 LTS"));
        assert!(take_remote_os_event(&state).is_none());
    }
}
