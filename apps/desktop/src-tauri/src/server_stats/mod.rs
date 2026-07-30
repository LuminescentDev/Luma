//! Agentless server dashboard: gathers CPU, memory, disk, network, process and
//! docker information over the host's existing SSH configuration by running a
//! single batched shell script through an exec channel. No remote agent, no
//! root access — commands only read /proc and use POSIX tools, degrading
//! per-section on hosts where something is unavailable.

mod parse;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh::ChannelMsg;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::ssh::{
    connection_config, validate_host_id, AuthenticatedConnection, SshConnectionConfig,
};

pub use parse::ServerStatsSnapshot;
// Shared with web_preview: both run the same `===LUMA:<name>===` batched-script
// convention over an exec channel.
pub(crate) use parse::split_sections;

/// Whole-script budget: the batch is cheap (`cat`s plus `ps`/`df`), so a slow
/// answer means a wedged connection rather than a busy server.
const EXEC_TIMEOUT: Duration = Duration::from_secs(30);
/// Generous cap; `ps aux` dominates and stays well under this in practice.
/// Output beyond the cap is truncated, never an error.
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

struct CachedConnection {
    connection: AuthenticatedConnection,
    // Keeps any ephemeral identity file alive for the lifetime of the
    // connection, mirroring SftpManager.
    _config: SshConnectionConfig,
}

/// Holds one authenticated SSH connection per host so dashboard refreshes
/// reuse a session instead of re-handshaking. Connections are opened lazily on
/// the first fetch and dropped on explicit close, fetch failure, or shutdown.
#[derive(Default)]
pub struct ServerStatsManager {
    connections: Mutex<HashMap<String, Arc<CachedConnection>>>,
}

impl ServerStatsManager {
    pub async fn fetch(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<ServerStatsSnapshot> {
        validate_host_id(host_id)?;
        let (cached, was_cached) = self.get_or_connect(pool, keystore_state, host_id).await?;
        match run_stats_script(&cached.connection).await {
            Ok(output) => Ok(parse::parse_snapshot(&output, now_ms())),
            Err(error) => {
                // The cached session may have died since the last refresh;
                // reconnect once before giving up.
                self.remove(host_id);
                if !was_cached {
                    return Err(error);
                }
                let (fresh, _) = self.get_or_connect(pool, keystore_state, host_id).await?;
                match run_stats_script(&fresh.connection).await {
                    Ok(output) => Ok(parse::parse_snapshot(&output, now_ms())),
                    Err(retry_error) => {
                        self.remove(host_id);
                        Err(retry_error)
                    }
                }
            }
        }
    }

    pub async fn close(&self, host_id: &str) -> Result<()> {
        validate_host_id(host_id)?;
        if let Some(cached) = self.remove(host_id) {
            let _ = cached
                .connection
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "server stats closed",
                    "en",
                )
                .await;
            tracing::info!(host_id = %host_id, "closed server stats connection");
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let count = {
            let mut connections = self.connections.lock().unwrap();
            let count = connections.len();
            connections.clear();
            count
        };
        if count > 0 {
            tracing::info!(count, "dropped server stats connections on shutdown");
        }
    }

    async fn get_or_connect(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<(Arc<CachedConnection>, bool)> {
        if let Some(cached) = self.connections.lock().unwrap().get(host_id) {
            return Ok((Arc::clone(cached), true));
        }
        let (mut config, _) = connection_config(pool, keystore_state, host_id).await?;
        config.startup_command = None;
        let connection = crate::ssh::authenticated_handle(&config).await?;
        let cached = Arc::new(CachedConnection {
            connection,
            _config: config,
        });
        let mut connections = self.connections.lock().unwrap();
        // A concurrent fetch may have connected first; keep the existing one.
        let entry = connections
            .entry(host_id.to_string())
            .or_insert_with(|| Arc::clone(&cached));
        let entry = Arc::clone(entry);
        drop(connections);
        tracing::info!(host_id = %host_id, "opened server stats connection");
        Ok((entry, false))
    }

    fn remove(&self, host_id: &str) -> Option<Arc<CachedConnection>> {
        self.connections.lock().unwrap().remove(host_id)
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

/// Builds the batched stats script. Every section is prefixed with a
/// `===LUMA:<name>===` marker line so the parser can split the combined
/// output; stderr is silenced globally so missing tools degrade to empty
/// sections. The whole body is one line (joined with `;`) wrapped in
/// `sh -c '...'` so it behaves identically under any remote login shell,
/// and it contains no single quotes.
fn stats_script() -> String {
    const SECTIONS: &[(&str, &str)] = &[
        (
            "system",
            r#"printf "os=%s\n" "$(uname -s)"; printf "kernel=%s\n" "$(uname -r)"; printf "arch=%s\n" "$(uname -m)"; printf "hostname=%s\n" "$(hostname)""#,
        ),
        ("osrelease", "cat /etc/os-release"),
        ("uptime", "cat /proc/uptime"),
        ("uptimecmd", "uptime"),
        ("loadavg", "cat /proc/loadavg"),
        ("stat", "cat /proc/stat"),
        ("meminfo", "cat /proc/meminfo"),
        ("df", "df -P -k"),
        ("netdev", "cat /proc/net/dev"),
        ("ps", "ps aux"),
        (
            "docker",
            r#"if LUMA_DOCKER=$(docker ps -a --format "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}"); then printf "@ok\n%s\n" "$LUMA_DOCKER"; fi"#,
        ),
    ];
    let mut body = String::from("exec 2>/dev/null");
    for (name, command) in SECTIONS {
        body.push_str(&format!(r#"; printf "\n===LUMA:{name}===\n"; "#));
        body.push_str(command);
    }
    debug_assert!(!body.contains('\''));
    format!("sh -c '{body}'")
}

async fn run_stats_script(connection: &AuthenticatedConnection) -> Result<String> {
    let operation = async {
        let mut channel = connection
            .channel_open_session()
            .await
            .map_err(exec_error)?;
        channel
            .exec(true, stats_script().as_bytes())
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
            message: "server stats collection timed out".into(),
        })?
}

fn exec_error(error: russh::Error) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("server stats exec failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_is_single_line_and_single_quote_free() {
        let script = stats_script();
        assert!(script.starts_with("sh -c '"));
        assert!(script.ends_with('\''));
        // Multi-line quoted strings break under csh-style login shells; the
        // inner body must also never terminate the outer quoting early.
        assert!(!script.contains('\n'));
        let body = &script["sh -c '".len()..script.len() - 1];
        assert!(!body.contains('\''));
        for section in [
            "system",
            "osrelease",
            "uptime",
            "uptimecmd",
            "loadavg",
            "stat",
            "meminfo",
            "df",
            "netdev",
            "ps",
            "docker",
        ] {
            assert!(
                script.contains(&format!("===LUMA:{section}===")),
                "{section}"
            );
        }
    }
}
