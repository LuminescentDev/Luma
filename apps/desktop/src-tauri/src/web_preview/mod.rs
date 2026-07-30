//! Automatic web-server discovery and preview.
//!
//! Discovery runs a single batched `sh -c` script over an SSH exec channel
//! (same convention as `server_stats`) to enumerate listening TCP sockets, then
//! filters them down to plausible HTTP services. Preview opens a normal local
//! SSH forward through `TunnelManager`, bound to 127.0.0.1 on an OS-assigned
//! port, so previews ride the existing tunnel lifecycle (including the
//! `kill_all` on application exit).

mod parse;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::ssh::{
    connection_config, tunnel_connection_config, validate_host_id, AuthenticatedConnection,
    TunnelManager,
};
use crate::storage::port_forwards::PortForward;

pub use parse::WebPreviewDiscovery;

/// Discovery is three cheap reads; a slow answer means a wedged connection.
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// `/proc/net/tcp` on a busy host is the only section that can grow; the cap
/// truncates rather than erroring.
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

/// Synthetic `port_forward_id` prefix for preview tunnels. Previews show up in
/// `tunnels_list` like any other tunnel; the frontend keys off this prefix to
/// label them "preview" instead of hiding them.
pub const PREVIEW_FORWARD_PREFIX: &str = "web-preview:";

/// Device side is always loopback: a preview must never be reachable from the
/// local network.
const DEVICE_BIND_ADDRESS: &str = "127.0.0.1";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebPreview {
    pub tunnel_id: String,
    pub host_id: String,
    /// Device-side port actually bound on 127.0.0.1.
    pub local_port: u16,
    /// Remote port being previewed.
    pub port: u16,
    /// Remote-side address the forward connects to (loopback unless the
    /// discovered listener was bound to a specific non-wildcard address).
    pub remote_bind: String,
}

/// Tracks preview tunnels so an already-open (host, port) pair returns the
/// existing preview instead of opening a second forward. Entries are dropped
/// on explicit close and when the underlying tunnel exits.
#[derive(Default)]
pub struct WebPreviewManager {
    previews: Mutex<HashMap<String, WebPreview>>,
}

impl WebPreviewManager {
    pub async fn discover(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<WebPreviewDiscovery> {
        validate_host_id(host_id)?;
        let (mut config, _) = connection_config(pool, keystore_state, host_id).await?;
        config.startup_command = None;
        let connection = crate::ssh::authenticated_handle(&config).await?;
        let output = run_discovery_script(&connection).await;
        let _ = connection
            .disconnect(
                russh::Disconnect::ByApplication,
                "web preview discovery done",
                "en",
            )
            .await;
        Ok(parse::parse_discovery(&output?))
    }

    pub async fn open(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        tunnels: &TunnelManager,
        host_id: &str,
        port: u16,
        remote_bind: Option<String>,
    ) -> Result<WebPreview> {
        validate_host_id(host_id)?;
        if port == 0 {
            return Err(LumaError::InvalidInput("port must be non-zero".into()));
        }
        let remote_bind = normalize_remote_bind(remote_bind)?;
        if let Some(existing) = self.find(host_id, port) {
            return Ok(existing);
        }

        let config = tunnel_connection_config(pool, keystore_state, host_id).await?;
        let port_forward = PortForward {
            id: preview_forward_id(host_id, port),
            host_id: host_id.to_string(),
            name: format!("Web preview :{port}"),
            forward_type: "local".into(),
            bind_address: DEVICE_BIND_ADDRESS.into(),
            // 0 asks the OS for a free port; the tunnel reports what it bound.
            local_port: Some(0),
            destination_host: Some(remote_bind.clone()),
            destination_port: Some(port),
            remote_port: None,
        };

        let started = match tunnels.start(config, port_forward, |_exit| {}).await {
            Ok(started) => started,
            Err(error) => {
                // A concurrent open may have won the race inside TunnelManager;
                // prefer returning that tunnel over surfacing the conflict.
                if let Some(existing) = self.find(host_id, port) {
                    return Ok(existing);
                }
                return Err(error);
            }
        };
        let Some(local_port) = started.local_port else {
            let _ = tunnels.stop(&started.tunnel_id).await;
            return Err(LumaError::SshConnection {
                category: "host-unreachable",
                message: "Could not determine the local preview port".into(),
            });
        };

        let preview = WebPreview {
            tunnel_id: started.tunnel_id,
            host_id: host_id.to_string(),
            local_port,
            port,
            remote_bind,
        };
        self.previews
            .lock()
            .unwrap()
            .insert(preview.tunnel_id.clone(), preview.clone());
        tracing::info!(
            host_id = %host_id,
            remote_port = port,
            local_port,
            "opened web preview tunnel"
        );
        Ok(preview)
    }

    pub async fn close(&self, tunnels: &TunnelManager, tunnel_id: &str) -> Result<()> {
        let known = self.previews.lock().unwrap().remove(tunnel_id).is_some();
        match tunnels.stop(tunnel_id).await {
            Ok(()) => Ok(()),
            // The tunnel may already have exited on its own; closing a preview
            // that is gone is a no-op rather than an error.
            Err(_) if known => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn list(&self) -> Vec<WebPreview> {
        let mut previews = self
            .previews
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        previews.sort_by(|left, right| {
            left.host_id
                .cmp(&right.host_id)
                .then_with(|| left.port.cmp(&right.port))
        });
        previews
    }

    fn find(&self, host_id: &str, port: u16) -> Option<WebPreview> {
        self.previews
            .lock()
            .unwrap()
            .values()
            .find(|preview| preview.host_id == host_id && preview.port == port)
            .cloned()
    }
}

fn preview_forward_id(host_id: &str, port: u16) -> String {
    format!("{PREVIEW_FORWARD_PREFIX}{host_id}:{port}")
}

/// Remote-side address for the forward. Wildcard binds are rewritten to
/// loopback (the server resolves the destination, so loopback is both valid
/// and the least surprising); anything unparseable is rejected rather than
/// being spliced into a channel-open request.
fn normalize_remote_bind(remote_bind: Option<String>) -> Result<String> {
    let Some(candidate) = remote_bind else {
        return Ok(DEVICE_BIND_ADDRESS.to_string());
    };
    let candidate = candidate.trim();
    if candidate.is_empty() || candidate == "0.0.0.0" || candidate == "*" {
        return Ok(DEVICE_BIND_ADDRESS.to_string());
    }
    if candidate == "::" {
        return Ok("::1".to_string());
    }
    if candidate.len() > 255
        || !candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_'))
    {
        return Err(LumaError::InvalidInput(
            "invalid remote bind address".into(),
        ));
    }
    Ok(candidate.to_string())
}

/// Builds the batched discovery script. Sections are marked with
/// `===LUMA:<name>===`; stderr is silenced so a missing tool degrades to an
/// empty section. Single line, no single quotes, so it survives any remote
/// login shell inside `sh -c '...'`.
fn discovery_script() -> String {
    const SECTIONS: &[(&str, &str)] = &[
        ("ss", "ss -tlnp"),
        ("netstat", "netstat -tlnp"),
        ("proctcp", "cat /proc/net/tcp /proc/net/tcp6"),
    ];
    let mut body = String::from("exec 2>/dev/null");
    for (name, command) in SECTIONS {
        body.push_str(&format!(r#"; printf "\n===LUMA:{name}===\n"; "#));
        body.push_str(command);
    }
    debug_assert!(!body.contains('\''));
    format!("sh -c '{body}'")
}

async fn run_discovery_script(connection: &AuthenticatedConnection) -> Result<String> {
    let operation = async {
        let mut channel = connection
            .channel_open_session()
            .await
            .map_err(exec_error)?;
        channel
            .exec(true, discovery_script().as_bytes())
            .await
            .map_err(exec_error)?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
                    output.extend_from_slice(&data[..data.len().min(remaining)]);
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    };
    tokio::time::timeout(EXEC_TIMEOUT, operation)
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "web server discovery timed out".into(),
        })?
}

fn exec_error(error: russh::Error) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("web preview discovery exec failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_is_single_line_and_single_quote_free() {
        let script = discovery_script();
        assert!(script.starts_with("sh -c '"));
        assert!(script.ends_with('\''));
        assert!(!script.contains('\n'));
        let body = &script["sh -c '".len()..script.len() - 1];
        assert!(!body.contains('\''));
        for section in ["ss", "netstat", "proctcp"] {
            assert!(
                script.contains(&format!("===LUMA:{section}===")),
                "{section}"
            );
        }
    }

    #[test]
    fn remote_bind_defaults_to_loopback() {
        assert_eq!(normalize_remote_bind(None).unwrap(), "127.0.0.1");
        assert_eq!(
            normalize_remote_bind(Some("0.0.0.0".into())).unwrap(),
            "127.0.0.1"
        );
        assert_eq!(
            normalize_remote_bind(Some("  ".into())).unwrap(),
            "127.0.0.1"
        );
        assert_eq!(normalize_remote_bind(Some("::".into())).unwrap(), "::1");
        assert_eq!(
            normalize_remote_bind(Some("10.0.0.5".into())).unwrap(),
            "10.0.0.5"
        );
        assert!(normalize_remote_bind(Some("bad host".into())).is_err());
        assert!(normalize_remote_bind(Some("a;rm -rf /".into())).is_err());
    }

    #[test]
    fn preview_forward_ids_are_stable_per_host_and_port() {
        assert_eq!(
            preview_forward_id("host-a", 5173),
            "web-preview:host-a:5173"
        );
        assert!(preview_forward_id("host-a", 5173).starts_with(PREVIEW_FORWARD_PREFIX));
        assert_ne!(
            preview_forward_id("host-a", 5173),
            preview_forward_id("host-b", 5173)
        );
    }

    #[test]
    fn list_reports_registered_previews_sorted() {
        let manager = WebPreviewManager::default();
        for (tunnel_id, host_id, port) in [
            ("t2", "host-b", 3000u16),
            ("t1", "host-a", 8080),
            ("t3", "host-a", 3000),
        ] {
            manager.previews.lock().unwrap().insert(
                tunnel_id.into(),
                WebPreview {
                    tunnel_id: tunnel_id.into(),
                    host_id: host_id.into(),
                    local_port: 40000 + port,
                    port,
                    remote_bind: "127.0.0.1".into(),
                },
            );
        }
        let previews = manager.list();
        assert_eq!(previews.len(), 3);
        assert_eq!(previews[0].tunnel_id, "t3");
        assert_eq!(previews[1].tunnel_id, "t1");
        assert_eq!(previews[2].tunnel_id, "t2");
        assert_eq!(manager.find("host-a", 8080).unwrap().tunnel_id, "t1");
        assert!(manager.find("host-a", 9999).is_none());
    }

    #[test]
    fn device_side_binds_loopback_only() {
        assert_eq!(DEVICE_BIND_ADDRESS, "127.0.0.1");
    }
}
