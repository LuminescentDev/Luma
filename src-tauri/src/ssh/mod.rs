mod config;
mod tunnels;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::storage::hosts::{self, Host};
use crate::storage::identities;
use crate::storage::key_references;
use crate::terminal::{home_dir, PtyManager, ResolvedShell};

pub use config::{
    import_config, preview_config, SshConfigCandidate, SshConfigImportRequest,
    SshConfigImportResult,
};
pub use tunnels::{
    tunnel_connection_config, TunnelExit, TunnelInfo, TunnelManager, TunnelStartResponse,
};

const CAPTURE_LIMIT_BYTES: usize = 16 * 1024;
const MAX_PROXY_JUMP_DEPTH: usize = 8;

type DataCallback = Box<dyn FnMut(&[u8]) + Send + 'static>;
type ExitCallback = Box<dyn FnOnce(SshExit) + Send + 'static>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshDetection {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshExit {
    pub code: Option<u32>,
    pub error_category: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProxyTarget {
    hostname: String,
    port: u16,
    username: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct SshConnectionConfig {
    executable: String,
    hostname: String,
    port: u16,
    username: Option<String>,
    identity_file: Option<String>,
    proxy_jumps: Vec<ProxyTarget>,
    startup_command: Option<String>,
    askpass_identity_id: Option<String>,
}

#[allow(dead_code)]
pub trait SshEngine {
    fn connect(
        &self,
        config: SshConnectionConfig,
        cols: u16,
        rows: u16,
        on_data: DataCallback,
        on_exit: ExitCallback,
    ) -> Result<String>;

    fn disconnect(&self, session_id: &str) -> Result<()>;
    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()>;
    fn write(&self, session_id: &str, data: &str) -> Result<()>;
}

pub struct OpenSshEngine<'a> {
    pty: &'a PtyManager,
}

impl<'a> OpenSshEngine<'a> {
    pub fn new(pty: &'a PtyManager) -> Self {
        Self { pty }
    }
}

impl SshEngine for OpenSshEngine<'_> {
    fn connect(
        &self,
        config: SshConnectionConfig,
        cols: u16,
        rows: u16,
        mut on_data: DataCallback,
        on_exit: ExitCallback,
    ) -> Result<String> {
        let arguments = build_arguments(&config);
        let captured = Arc::new(Mutex::new(Vec::with_capacity(CAPTURE_LIMIT_BYTES)));
        let captured_for_data = Arc::clone(&captured);
        let captured_for_exit = Arc::clone(&captured);

        let mut environment = HashMap::new();
        if let Some(identity_id) = &config.askpass_identity_id {
            let executable = std::env::current_exe().map_err(|e| {
                LumaError::SshUnavailable(format!("could not configure password helper: {e}"))
            })?;
            environment.insert(
                "SSH_ASKPASS".into(),
                executable.to_string_lossy().into_owned(),
            );
            environment.insert("SSH_ASKPASS_REQUIRE".into(), "force".into());
            environment.insert("DISPLAY".into(), "luma:0".into());
            environment.insert("LUMA_ASKPASS_ID".into(), identity_id.clone());
        }
        self.pty
            .spawn(
                ResolvedShell {
                    path: config.executable,
                    args: arguments,
                    working_directory: None,
                    environment,
                },
                cols,
                rows,
                move |bytes| {
                    let mut captured = captured_for_data.lock().unwrap();
                    if captured.len() < CAPTURE_LIMIT_BYTES {
                        let remaining = CAPTURE_LIMIT_BYTES - captured.len();
                        captured.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                    }
                    drop(captured);
                    on_data(bytes);
                },
                move |code| {
                    let (error_category, error_message) = if code == Some(0) {
                        (None, None)
                    } else {
                        let captured = captured_for_exit.lock().unwrap();
                        let output = String::from_utf8_lossy(&captured);
                        let classified = classify_error_output(&output);
                        match classified {
                            Some((category, message)) => {
                                (Some(category.to_string()), Some(message.to_string()))
                            }
                            None => (
                                Some("ssh-error".into()),
                                Some("SSH process exited before the session was established or completed".into()),
                            ),
                        }
                    };
                    on_exit(SshExit {
                        code,
                        error_category,
                        error_message,
                    });
                },
            )
            .map_err(|error| {
                LumaError::SshUnavailable(format!("failed to start system OpenSSH: {error}"))
            })
    }

    fn disconnect(&self, session_id: &str) -> Result<()> {
        self.pty.kill(session_id)
    }

    fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        self.pty.resize(session_id, cols, rows)
    }

    fn write(&self, session_id: &str, data: &str) -> Result<()> {
        self.pty.write(session_id, data)
    }
}

pub fn detect() -> SshDetection {
    let Some(path) = find_ssh_executable() else {
        return SshDetection {
            available: false,
            path: None,
            version: None,
        };
    };

    let version = Command::new(&path)
        .arg("-V")
        .output()
        .ok()
        .and_then(|output| {
            let text = if output.stderr.is_empty() {
                String::from_utf8_lossy(&output.stdout).into_owned()
            } else {
                String::from_utf8_lossy(&output.stderr).into_owned()
            };
            let text = text.trim();
            (!text.is_empty()).then(|| text.to_string())
        });

    SshDetection {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
    }
}

fn find_in_path(executable: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file())
}

fn find_ssh_executable() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(path) = find_in_path("ssh.exe") {
            return Some(path);
        }
        let system_root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let bundled = system_root.join(r"System32\OpenSSH\ssh.exe");
        bundled.is_file().then_some(bundled)
    }

    #[cfg(not(windows))]
    {
        find_in_path("ssh")
    }
}

fn proxy_destination(target: &ProxyTarget) -> String {
    let hostname = if target.hostname.contains(':') && !target.hostname.starts_with('[') {
        format!("[{}]", target.hostname)
    } else {
        target.hostname.clone()
    };
    let user = target
        .username
        .as_ref()
        .map(|username| format!("{username}@"))
        .unwrap_or_default();
    format!("{user}{hostname}:{}", target.port)
}

fn build_connection_options(
    config: &SshConnectionConfig,
    disable_password_prompts: bool,
) -> Vec<String> {
    let mut arguments = vec!["-p".into(), config.port.to_string()];
    if let Some(username) = &config.username {
        arguments.push("-l".into());
        arguments.push(username.clone());
    }
    if let Some(identity_file) = &config.identity_file {
        arguments.push("-i".into());
        arguments.push(identity_file.clone());
        arguments.push("-o".into());
        arguments.push("IdentitiesOnly=yes".into());
    }
    arguments.push("-o".into());
    arguments.push("BatchMode=no".into());
    if disable_password_prompts {
        arguments.push("-o".into());
        arguments.push("NumberOfPasswordPrompts=0".into());
    }
    if !config.proxy_jumps.is_empty() {
        arguments.push("-J".into());
        arguments.push(
            config
                .proxy_jumps
                .iter()
                .map(proxy_destination)
                .collect::<Vec<_>>()
                .join(","),
        );
    }
    arguments
}

pub(crate) fn build_arguments(config: &SshConnectionConfig) -> Vec<String> {
    let mut arguments = build_connection_options(config, false);
    if config.startup_command.is_some() {
        arguments.push("-t".into());
    }
    arguments.push(config.hostname.clone());
    if let Some(command) = &config.startup_command {
        arguments.push(command.clone());
    }
    arguments
}

fn resolve_identity_path(path: &str) -> PathBuf {
    let path = path.trim();
    if path == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(path));
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = home_dir() {
            return home.join(rest);
        }
    }
    let path = PathBuf::from(path);
    if path.is_relative() {
        if let Some(home) = home_dir() {
            return home.join(".ssh").join(path);
        }
    }
    path
}

async fn identity_file(pool: &SqlitePool, host: &Host) -> Result<Option<String>> {
    if host.authentication_type != "key" {
        return Ok(None);
    }
    let key_id = host
        .key_id
        .as_deref()
        .ok_or_else(|| LumaError::KeyUnavailable("host has no key reference".into()))?;
    let key = key_references::get(pool, key_id)
        .await?
        .ok_or_else(|| LumaError::KeyUnavailable("key reference no longer exists".into()))?;
    if key.storage_mode != "local-path" {
        return Err(LumaError::KeyUnavailable(
            "key authentication requires a local-path key reference".into(),
        ));
    }
    let local_path = key
        .local_path
        .as_deref()
        .ok_or_else(|| LumaError::KeyUnavailable("key reference has no local path".into()))?;
    let resolved = resolve_identity_path(local_path);
    if !resolved.is_file() {
        return Err(LumaError::KeyUnavailable(
            "the configured private key file is unavailable on this device".into(),
        ));
    }
    Ok(Some(resolved.to_string_lossy().into_owned()))
}

pub async fn connection_config(
    pool: &SqlitePool,
    host_id: &str,
) -> Result<(SshConnectionConfig, String)> {
    let mut host = hosts::get(pool, host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    let mut askpass_identity_id = None;
    if let Some(identity_id) = &host.identity_id {
        let identity = identities::get(pool, identity_id)
            .await?
            .ok_or_else(|| LumaError::InvalidInput("selected identity no longer exists".into()))?;
        host.username = Some(identity.username);
        if let Some(key_id) = identity.key_id {
            host.authentication_type = "key".into();
            host.key_id = Some(key_id);
        } else if identity.has_password {
            host.authentication_type = "password".into();
            askpass_identity_id = Some(identity_id.clone());
        }
    }
    let detection = detect();
    let executable = detection.path.ok_or_else(|| {
        LumaError::SshUnavailable("system OpenSSH executable was not found".into())
    })?;
    let identity_file = identity_file(pool, &host).await?;

    let mut proxy_jumps = Vec::new();
    let mut next = host.proxy_jump_host_id.clone();
    let mut seen = HashSet::from([host.id.clone()]);
    while let Some(proxy_id) = next {
        if !seen.insert(proxy_id.clone()) {
            return Err(LumaError::InvalidInput(
                "proxy jump chain contains a cycle".into(),
            ));
        }
        if proxy_jumps.len() >= MAX_PROXY_JUMP_DEPTH {
            return Err(LumaError::InvalidInput(format!(
                "proxy jump chain may contain at most {MAX_PROXY_JUMP_DEPTH} hosts"
            )));
        }
        let proxy = hosts::get(pool, &proxy_id)
            .await?
            .ok_or_else(|| LumaError::InvalidInput("proxy jump host no longer exists".into()))?;
        proxy_jumps.push(ProxyTarget {
            hostname: proxy.hostname,
            port: proxy.port,
            username: proxy.username,
        });
        next = proxy.proxy_jump_host_id;
    }
    proxy_jumps.reverse();

    Ok((
        SshConnectionConfig {
            executable,
            hostname: host.hostname,
            port: host.port,
            username: host.username,
            identity_file,
            proxy_jumps,
            startup_command: host.startup_command,
            askpass_identity_id,
        },
        host.name,
    ))
}

pub(crate) fn classify_error_output(output: &str) -> Option<(&'static str, &'static str)> {
    let lower = output.to_ascii_lowercase();
    if lower.contains("remote host identification has changed") {
        Some((
            "host-key-changed",
            "The remote host key has changed. Verify the server identity and update known_hosts before reconnecting.",
        ))
    } else if lower.contains("host key verification failed") {
        Some((
            "host-key-rejected",
            "Host key verification was rejected or could not be completed.",
        ))
    } else if lower.contains("permission denied") {
        Some((
            "auth-failed",
            "SSH authentication failed. Check the username, key, agent, or password.",
        ))
    } else if lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname provided")
    {
        Some(("dns-failed", "The SSH hostname could not be resolved."))
    } else if lower.contains("connection refused")
        || lower.contains("no route to host")
        || lower.contains("network is unreachable")
    {
        Some((
            "host-unreachable",
            "The SSH host is unreachable or refused the connection.",
        ))
    } else if lower.contains("connection timed out")
        || lower.contains("operation timed out")
        || lower.contains("timed out")
    {
        Some(("timeout", "The SSH connection timed out."))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> SshConnectionConfig {
        SshConnectionConfig {
            executable: "/usr/bin/ssh".into(),
            hostname: "server.example.com".into(),
            port: 2222,
            username: Some("alice".into()),
            identity_file: None,
            proxy_jumps: vec![],
            startup_command: None,
            askpass_identity_id: None,
        }
    }

    #[test]
    fn builds_agent_password_and_interactive_arguments() {
        // Agent, password, and explicitly interactive authentication all rely on
        // OpenSSH's PTY prompts and therefore resolve to the same safe argv.
        for authentication_type in ["agent", "password", "interactive"] {
            let arguments = build_arguments(&base_config());
            assert_eq!(
                arguments,
                vec![
                    "-p",
                    "2222",
                    "-l",
                    "alice",
                    "-o",
                    "BatchMode=no",
                    "server.example.com"
                ],
                "unexpected arguments for {authentication_type} authentication"
            );
            assert!(!arguments.iter().any(|argument| argument == "-tt"));
        }
    }

    #[test]
    fn builds_key_proxy_jump_and_startup_command_arguments() {
        let mut config = base_config();
        config.identity_file = Some("/home/alice/.ssh/id_ed25519".into());
        config.proxy_jumps = vec![
            ProxyTarget {
                hostname: "edge.example.com".into(),
                port: 22,
                username: Some("jump".into()),
            },
            ProxyTarget {
                hostname: "2001:db8::1".into(),
                port: 2200,
                username: None,
            },
        ];
        config.startup_command = Some("cd /srv && exec bash -l".into());

        assert_eq!(
            build_arguments(&config),
            vec![
                "-p",
                "2222",
                "-l",
                "alice",
                "-i",
                "/home/alice/.ssh/id_ed25519",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "BatchMode=no",
                "-J",
                "jump@edge.example.com:22,[2001:db8::1]:2200",
                "-t",
                "server.example.com",
                "cd /srv && exec bash -l"
            ]
        );
    }

    #[test]
    fn classifies_common_ssh_failures() {
        let cases = [
            (
                "WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
                "host-key-changed",
            ),
            ("Host key verification failed.", "host-key-rejected"),
            ("Permission denied (publickey,password).", "auth-failed"),
            (
                "ssh: Could not resolve hostname missing: Name or service not known",
                "dns-failed",
            ),
            (
                "connect to host x port 22: Connection refused",
                "host-unreachable",
            ),
            (
                "ssh: connect to host x port 22: Connection timed out",
                "timeout",
            ),
        ];
        for (output, expected) in cases {
            assert_eq!(classify_error_output(output).unwrap().0, expected);
        }
        assert!(classify_error_output("unrecognized failure").is_none());
    }

    #[test]
    fn trait_wraps_existing_pty_session_operations() {
        fn assert_engine<T: SshEngine>() {}
        assert_engine::<OpenSshEngine<'_>>();
    }

    #[test]
    fn identity_resolution_preserves_absolute_paths() {
        let path = std::env::current_exe().unwrap();
        assert_eq!(resolve_identity_path(path.to_string_lossy().as_ref()), path);
        assert!(
            std::path::Path::new(&resolve_identity_path("relative-key"))
                .ends_with(".ssh/relative-key")
                || std::path::Path::new(&resolve_identity_path("relative-key"))
                    .ends_with(".ssh\\relative-key")
        );
    }
}
