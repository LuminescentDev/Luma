use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sqlx::SqlitePool;

use super::{
    build_connection_options, classify_error_output, connection_config, SshConnectionConfig,
    CAPTURE_LIMIT_BYTES,
};
use crate::errors::{LumaError, Result};
use crate::storage::hosts;
use crate::storage::port_forwards::PortForward;
use crate::terminal::{PtyManager, ResolvedShell};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStartResponse {
    pub tunnel_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelExit {
    pub code: Option<u32>,
    pub error_category: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub tunnel_id: String,
    pub port_forward_id: String,
    pub host_id: String,
    pub status: String,
}

struct ActiveTunnel {
    tunnel_id: String,
    port_forward_id: String,
    host_id: String,
    pty_session_id: Option<String>,
    stop_requested: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct TunnelManager {
    tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
}

impl TunnelManager {
    pub fn start(
        &self,
        pty: &PtyManager,
        config: SshConnectionConfig,
        port_forward: PortForward,
        on_exit: impl FnOnce(TunnelExit) + Send + 'static,
    ) -> Result<String> {
        let arguments = build_tunnel_arguments(&config, &port_forward)?;
        let tunnel_id = uuid::Uuid::new_v4().to_string();
        let stop_requested = Arc::new(AtomicBool::new(false));
        let captured = Arc::new(Mutex::new(Vec::with_capacity(CAPTURE_LIMIT_BYTES)));

        // Keep the state lock until the PTY session id is installed. An SSH
        // process can fail immediately; its exit callback will wait for this
        // critical section and cannot race a partially initialized record.
        let mut tunnels = self.tunnels.lock().unwrap();
        if tunnels
            .values()
            .any(|tunnel| tunnel.port_forward_id == port_forward.id)
        {
            return Err(LumaError::InvalidInput(
                "port forward already has a running tunnel".into(),
            ));
        }
        tunnels.insert(
            tunnel_id.clone(),
            ActiveTunnel {
                tunnel_id: tunnel_id.clone(),
                port_forward_id: port_forward.id.clone(),
                host_id: port_forward.host_id.clone(),
                pty_session_id: None,
                stop_requested: Arc::clone(&stop_requested),
            },
        );

        let tunnels_for_exit = Arc::clone(&self.tunnels);
        let tunnel_id_for_exit = tunnel_id.clone();
        let captured_for_data = Arc::clone(&captured);
        let captured_for_exit = Arc::clone(&captured);
        let stopped_for_exit = Arc::clone(&stop_requested);
        let spawn_result = pty.spawn(
            ResolvedShell {
                path: config.executable,
                args: arguments,
                working_directory: None,
                environment: HashMap::new(),
            },
            80,
            24,
            move |bytes| {
                let mut captured = captured_for_data.lock().unwrap();
                if captured.len() < CAPTURE_LIMIT_BYTES {
                    let remaining = CAPTURE_LIMIT_BYTES - captured.len();
                    captured.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                }
            },
            move |code| {
                tunnels_for_exit.lock().unwrap().remove(&tunnel_id_for_exit);
                let stopped = stopped_for_exit.load(Ordering::SeqCst);
                let (error_category, error_message) = if code == Some(0) || stopped {
                    (None, None)
                } else {
                    let captured = captured_for_exit.lock().unwrap();
                    let output = String::from_utf8_lossy(&captured);
                    match classify_error_output(&output) {
                        Some((category, message)) => {
                            (Some(category.to_string()), Some(message.to_string()))
                        }
                        None => (
                            Some("ssh-error".into()),
                            Some("SSH tunnel process exited before or while forwarding".into()),
                        ),
                    }
                };
                on_exit(TunnelExit {
                    code,
                    error_category,
                    error_message,
                });
            },
        );

        let pty_session_id = match spawn_result {
            Ok(session_id) => session_id,
            Err(error) => {
                tunnels.remove(&tunnel_id);
                return Err(LumaError::SshUnavailable(format!(
                    "failed to start system OpenSSH tunnel: {error}"
                )));
            }
        };
        tunnels
            .get_mut(&tunnel_id)
            .expect("new tunnel remains reserved while state lock is held")
            .pty_session_id = Some(pty_session_id.clone());
        drop(tunnels);

        // ConPTY uses INHERIT_CURSOR and waits for a cursor position response.
        // Tunnels have no visible xterm.js instance, so answer it internally.
        #[cfg(windows)]
        let _ = pty.write(&pty_session_id, "\x1b[1;1R");

        Ok(tunnel_id)
    }

    pub fn stop(&self, pty: &PtyManager, tunnel_id: &str) -> Result<()> {
        let tunnel = self
            .tunnels
            .lock()
            .unwrap()
            .remove(tunnel_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown tunnel".into()))?;
        tunnel.stop_requested.store(true, Ordering::SeqCst);
        if let Some(session_id) = tunnel.pty_session_id {
            // If the waiter removed the PTY between the state removal and this
            // call, the tunnel has already stopped and the requested outcome is
            // still satisfied.
            let _ = pty.kill(&session_id);
        }
        Ok(())
    }

    pub fn list(&self) -> Vec<TunnelInfo> {
        let mut tunnels = self
            .tunnels
            .lock()
            .unwrap()
            .values()
            .map(|tunnel| TunnelInfo {
                tunnel_id: tunnel.tunnel_id.clone(),
                port_forward_id: tunnel.port_forward_id.clone(),
                host_id: tunnel.host_id.clone(),
                status: "running".into(),
            })
            .collect::<Vec<_>>();
        tunnels.sort_by(|left, right| {
            left.port_forward_id
                .cmp(&right.port_forward_id)
                .then_with(|| left.tunnel_id.cmp(&right.tunnel_id))
        });
        tunnels
    }

    pub fn kill_all(&self, pty: &PtyManager) {
        let tunnels = self
            .tunnels
            .lock()
            .unwrap()
            .drain()
            .map(|(_, tunnel)| tunnel)
            .collect::<Vec<_>>();
        for tunnel in tunnels {
            tunnel.stop_requested.store(true, Ordering::SeqCst);
            if let Some(session_id) = tunnel.pty_session_id {
                let _ = pty.kill(&session_id);
            }
        }
    }
}

/// Tunnels cannot display interactive prompts in v0.1. Password and explicitly
/// interactive hosts are therefore rejected before process spawn; agent or key
/// authentication must complete without a password prompt.
pub async fn tunnel_connection_config(
    pool: &SqlitePool,
    host_id: &str,
) -> Result<SshConnectionConfig> {
    let host = hosts::get(pool, host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    if matches!(
        host.authentication_type.as_str(),
        "password" | "interactive"
    ) {
        return Err(LumaError::InvalidInput(
            "tunnels require key or agent authentication in this version because interactive authentication prompts cannot be displayed"
                .into(),
        ));
    }
    let (mut config, _) = connection_config(pool, host_id).await?;
    config.startup_command = None;
    Ok(config)
}

fn forwarding_address(address: &str) -> String {
    if address.contains(':') && !address.starts_with('[') {
        format!("[{address}]")
    } else {
        address.to_string()
    }
}

fn forwarding_spec(port_forward: &PortForward) -> Result<(String, String)> {
    let bind = forwarding_address(&port_forward.bind_address);
    match port_forward.forward_type.as_str() {
        "local" => {
            let local_port = port_forward
                .local_port
                .ok_or_else(|| LumaError::InvalidInput("localPort is required".into()))?;
            let destination_host = port_forward
                .destination_host
                .as_deref()
                .ok_or_else(|| LumaError::InvalidInput("destinationHost is required".into()))?;
            let destination_port = port_forward
                .destination_port
                .ok_or_else(|| LumaError::InvalidInput("destinationPort is required".into()))?;
            Ok((
                "-L".into(),
                format!(
                    "{bind}:{local_port}:{}:{destination_port}",
                    forwarding_address(destination_host)
                ),
            ))
        }
        "remote" => {
            let remote_port = port_forward
                .remote_port
                .ok_or_else(|| LumaError::InvalidInput("remotePort is required".into()))?;
            let destination_host = port_forward
                .destination_host
                .as_deref()
                .ok_or_else(|| LumaError::InvalidInput("destinationHost is required".into()))?;
            let destination_port = port_forward
                .destination_port
                .ok_or_else(|| LumaError::InvalidInput("destinationPort is required".into()))?;
            Ok((
                "-R".into(),
                format!(
                    "{bind}:{remote_port}:{}:{destination_port}",
                    forwarding_address(destination_host)
                ),
            ))
        }
        "dynamic" => {
            let local_port = port_forward
                .local_port
                .ok_or_else(|| LumaError::InvalidInput("localPort is required".into()))?;
            Ok(("-D".into(), format!("{bind}:{local_port}")))
        }
        _ => Err(LumaError::InvalidInput(
            "type must be 'local', 'remote', or 'dynamic'".into(),
        )),
    }
}

pub(crate) fn build_tunnel_arguments(
    config: &SshConnectionConfig,
    port_forward: &PortForward,
) -> Result<Vec<String>> {
    let (forwarding_flag, forwarding_value) = forwarding_spec(port_forward)?;
    let mut arguments = build_connection_options(config, true);
    arguments.push("-N".into());
    arguments.push(forwarding_flag);
    arguments.push(forwarding_value);
    arguments.push(config.hostname.clone());
    Ok(arguments)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::hosts::HostInput;

    fn config() -> SshConnectionConfig {
        SshConnectionConfig {
            executable: "/usr/bin/ssh".into(),
            hostname: "server.example.com".into(),
            port: 2222,
            username: Some("alice".into()),
            identity_file: None,
            proxy_jumps: vec![],
            startup_command: Some("must-not-run".into()),
            askpass_identity_id: None,
        }
    }

    fn port_forward(forward_type: &str) -> PortForward {
        PortForward {
            id: format!("{forward_type}-id"),
            host_id: "host-id".into(),
            name: "Forward".into(),
            forward_type: forward_type.into(),
            bind_address: "127.0.0.1".into(),
            local_port: (forward_type != "remote").then_some(8080),
            destination_host: (forward_type != "dynamic").then(|| "db.internal".into()),
            destination_port: (forward_type != "dynamic").then_some(5432),
            remote_port: (forward_type == "remote").then_some(15432),
        }
    }

    #[test]
    fn builds_local_remote_and_dynamic_tunnel_arguments() {
        assert_eq!(
            build_tunnel_arguments(&config(), &port_forward("local")).unwrap(),
            vec![
                "-p",
                "2222",
                "-l",
                "alice",
                "-o",
                "BatchMode=no",
                "-o",
                "NumberOfPasswordPrompts=0",
                "-N",
                "-L",
                "127.0.0.1:8080:db.internal:5432",
                "server.example.com"
            ]
        );
        assert_eq!(
            build_tunnel_arguments(&config(), &port_forward("remote")).unwrap(),
            vec![
                "-p",
                "2222",
                "-l",
                "alice",
                "-o",
                "BatchMode=no",
                "-o",
                "NumberOfPasswordPrompts=0",
                "-N",
                "-R",
                "127.0.0.1:15432:db.internal:5432",
                "server.example.com"
            ]
        );
        assert_eq!(
            build_tunnel_arguments(&config(), &port_forward("dynamic")).unwrap(),
            vec![
                "-p",
                "2222",
                "-l",
                "alice",
                "-o",
                "BatchMode=no",
                "-o",
                "NumberOfPasswordPrompts=0",
                "-N",
                "-D",
                "127.0.0.1:8080",
                "server.example.com"
            ]
        );
        let arguments = build_tunnel_arguments(&config(), &port_forward("local")).unwrap();
        assert!(!arguments.iter().any(|argument| argument == "must-not-run"));
        assert!(!arguments.iter().any(|argument| argument == "-t"));
    }

    #[test]
    fn brackets_ipv6_forwarding_addresses() {
        let mut forward = port_forward("local");
        forward.bind_address = "::1".into();
        forward.destination_host = Some("2001:db8::2".into());
        let arguments = build_tunnel_arguments(&config(), &forward).unwrap();
        assert!(arguments.contains(&"[::1]:8080:[2001:db8::2]:5432".into()));
    }

    #[tokio::test]
    async fn rejects_password_and_interactive_hosts_before_detection_or_spawn() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        for authentication_type in ["password", "interactive"] {
            let host = hosts::create(
                &pool,
                HostInput {
                    name: format!("{authentication_type} host"),
                    hostname: "server.example.com".into(),
                    port: 22,
                    username: Some("alice".into()),
                    group_id: None,
                    authentication_type: authentication_type.into(),
                    key_id: None,
                    identity_id: None,
                    proxy_jump_host_id: None,
                    startup_command: None,
                    working_directory: None,
                    environment: None,
                    tags: vec![],
                    favorite: false,
                },
            )
            .await
            .unwrap();
            let error = tunnel_connection_config(&pool, &host.id).await.unwrap_err();
            assert_eq!(error.category(), "invalid-input");
            assert!(error.to_string().contains("key or agent authentication"));
        }
    }

    #[test]
    fn tunnel_manager_tracks_independent_reservations() {
        let manager = TunnelManager::default();
        let stop_one = Arc::new(AtomicBool::new(false));
        let stop_two = Arc::new(AtomicBool::new(false));
        {
            let mut tunnels = manager.tunnels.lock().unwrap();
            tunnels.insert(
                "one".into(),
                ActiveTunnel {
                    tunnel_id: "one".into(),
                    port_forward_id: "forward-one".into(),
                    host_id: "host".into(),
                    pty_session_id: None,
                    stop_requested: stop_one,
                },
            );
            tunnels.insert(
                "two".into(),
                ActiveTunnel {
                    tunnel_id: "two".into(),
                    port_forward_id: "forward-two".into(),
                    host_id: "host".into(),
                    pty_session_id: None,
                    stop_requested: stop_two,
                },
            );
        }
        assert_eq!(manager.list().len(), 2);
        assert_eq!(manager.list()[0].status, "running");

        let mut duplicate_forward = port_forward("local");
        duplicate_forward.id = "forward-one".into();
        let error = manager
            .start(&PtyManager::default(), config(), duplicate_forward, |_| {})
            .unwrap_err();
        assert_eq!(error.category(), "invalid-input");

        manager.stop(&PtyManager::default(), "one").unwrap();
        let remaining = manager.list();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].tunnel_id, "two");
    }
}
