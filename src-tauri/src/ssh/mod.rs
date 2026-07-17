mod config;
mod known_hosts;
mod remote_os;
mod tunnels;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::errors::{LumaError, Result};
use crate::storage::hosts::{self, Host};
use crate::storage::identities;
use crate::storage::key_references;
use crate::terminal::{home_dir, PtyManager, ResolvedShell};
use crate::vault::{self, VaultState};

pub use config::{
    import_config, preview_config, SshConfigCandidate, SshConfigImportRequest,
    SshConfigImportResult,
};
pub use known_hosts::{
    file_path as known_hosts_file_path, status as host_key_status, trust as trust_host_key,
    validate_host_id, SshHostKeyStatus,
};
pub use remote_os::SshRemoteOs;
use remote_os::{detect_remote_os, prepare_multiplex_control, MultiplexControl, RemoteOsTarget};
pub use tunnels::{
    tunnel_connection_config, TunnelExit, TunnelInfo, TunnelManager, TunnelStartResponse,
};

pub(crate) const CAPTURE_LIMIT_BYTES: usize = 16 * 1024;
const MAX_PROXY_JUMP_DEPTH: usize = 8;

type DataCallback = Box<dyn FnMut(&[u8]) + Send + 'static>;
type ExitCallback = Box<dyn FnOnce(SshExit) + Send + 'static>;
type RemoteOsCallback = Box<dyn FnOnce(SshRemoteOs) + Send + 'static>;

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
    pub(crate) executable: String,
    pub(crate) hostname: String,
    port: u16,
    known_hosts_file: PathBuf,
    username: Option<String>,
    identity_file: Option<String>,
    proxy_jumps: Vec<ProxyTarget>,
    pub(crate) startup_command: Option<String>,
    askpass_identity_id: Option<String>,
    askpass_service: Option<String>,
    askpass_prompt: Option<String>,
    ephemeral_credential: Option<Arc<EphemeralCredential>>,
    ephemeral_identity_file: Option<Arc<EphemeralIdentityFile>>,
}

#[derive(Debug)]
struct EphemeralIdentityFile(PathBuf);

#[derive(Debug)]
struct EphemeralCredential {
    service: String,
    account: String,
}

impl Drop for EphemeralCredential {
    fn drop(&mut self) {
        if let Ok(entry) = keyring::Entry::new(&self.service, &self.account) {
            let _ = entry.delete_credential();
        }
    }
}

impl Drop for EphemeralIdentityFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
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
        on_remote_os: RemoteOsCallback,
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

#[derive(Default)]
struct AuthenticationObserver {
    tail: Vec<u8>,
}

impl AuthenticationObserver {
    fn observe(&mut self, bytes: &[u8]) -> bool {
        const MARKERS: [&[u8]; 2] = [b"Authenticated to ", b"Entering interactive session."];
        const MAX_TAIL_BYTES: usize = 128;

        self.tail.extend_from_slice(bytes);
        let authenticated = MARKERS.iter().any(|marker| {
            self.tail
                .windows(marker.len())
                .any(|window| window == *marker)
        });
        if self.tail.len() > MAX_TAIL_BYTES {
            self.tail.drain(..self.tail.len() - MAX_TAIL_BYTES);
        }
        authenticated
    }
}

pub(crate) fn askpass_environment(config: &SshConnectionConfig) -> Result<HashMap<String, String>> {
    let mut environment = HashMap::new();
    if let Some(identity_id) = &config.askpass_identity_id {
        let executable = std::env::current_exe().map_err(|error| {
            LumaError::SshUnavailable(format!("could not configure password helper: {error}"))
        })?;
        environment.insert(
            "SSH_ASKPASS".into(),
            executable.to_string_lossy().into_owned(),
        );
        environment.insert("SSH_ASKPASS_REQUIRE".into(), "force".into());
        environment.insert("DISPLAY".into(), "luma:0".into());
        environment.insert("LUMA_ASKPASS_ID".into(), identity_id.clone());
        if let Some(service) = &config.askpass_service {
            environment.insert("LUMA_ASKPASS_SERVICE".into(), service.clone());
        }
        if let Some(prompt) = &config.askpass_prompt {
            environment.insert("LUMA_ASKPASS_PROMPT".into(), prompt.clone());
        }
    }
    Ok(environment)
}

impl SshEngine for OpenSshEngine<'_> {
    fn connect(
        &self,
        config: SshConnectionConfig,
        cols: u16,
        rows: u16,
        mut on_data: DataCallback,
        on_exit: ExitCallback,
        on_remote_os: RemoteOsCallback,
    ) -> Result<String> {
        let multiplex_control = prepare_multiplex_control();
        let arguments = build_interactive_arguments(&config, multiplex_control.as_deref());
        let remote_os_target = RemoteOsTarget::new(
            config.executable.clone(),
            config.hostname.clone(),
            config.port,
            config.username.clone(),
        );
        let ephemeral_identity_file = config.ephemeral_identity_file.clone();
        let captured = Arc::new(Mutex::new(Vec::with_capacity(CAPTURE_LIMIT_BYTES)));
        let captured_for_data = Arc::clone(&captured);
        let captured_for_exit = Arc::clone(&captured);
        let control_for_exit = multiplex_control.clone();
        let mut pending_target = Some(remote_os_target);
        let mut pending_control = Some(multiplex_control);
        let mut pending_remote_os_callback = Some(on_remote_os);
        let mut authentication_observer = AuthenticationObserver::default();

        let environment = askpass_environment(&config)?;
        let ephemeral_credential = config.ephemeral_credential.clone();
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

                    if authentication_observer.observe(bytes) {
                        if let (Some(target), Some(control), Some(callback)) = (
                            pending_target.take(),
                            pending_control.take(),
                            pending_remote_os_callback.take(),
                        ) {
                            tauri::async_runtime::spawn(async move {
                                callback(detect_remote_os(target, control).await);
                            });
                        }
                    }

                    on_data(bytes);
                },
                move |code| {
                    let _ephemeral_identity_file = ephemeral_identity_file;
                    let _ephemeral_credential = ephemeral_credential;
                    let _control = control_for_exit;
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

struct ConnectionOptionPolicy<'a> {
    batch_mode: bool,
    known_hosts_file: &'a Path,
    strict_host_key_checking: &'static str,
    disable_password_prompts: bool,
    connect_timeout_seconds: Option<u64>,
    probe_safety_options: bool,
}

fn build_connection_options_with_policy(
    config: &SshConnectionConfig,
    policy: ConnectionOptionPolicy<'_>,
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
    arguments.push(format!(
        "BatchMode={}",
        if policy.batch_mode { "yes" } else { "no" }
    ));
    arguments.push("-o".into());
    arguments.push(format!(
        "UserKnownHostsFile={}",
        policy.known_hosts_file.to_string_lossy()
    ));
    arguments.push("-o".into());
    arguments.push("GlobalKnownHostsFile=none".into());
    arguments.push("-o".into());
    arguments.push(format!(
        "StrictHostKeyChecking={}",
        policy.strict_host_key_checking
    ));
    arguments.push("-o".into());
    arguments.push("UpdateHostKeys=no".into());
    if policy.disable_password_prompts {
        arguments.push("-o".into());
        arguments.push("NumberOfPasswordPrompts=0".into());
    }
    if let Some(seconds) = policy.connect_timeout_seconds {
        arguments.push("-o".into());
        arguments.push(format!("ConnectTimeout={seconds}"));
        arguments.push("-o".into());
        arguments.push("ConnectionAttempts=1".into());
    }
    if policy.probe_safety_options {
        for option in [
            "ClearAllForwardings=yes",
            "RemoteCommand=none",
            "ControlMaster=no",
            "ControlPath=none",
        ] {
            arguments.push("-o".into());
            arguments.push(option.into());
        }
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

fn build_connection_options(
    config: &SshConnectionConfig,
    disable_password_prompts: bool,
) -> Vec<String> {
    build_connection_options_with_policy(
        config,
        ConnectionOptionPolicy {
            batch_mode: false,
            known_hosts_file: &config.known_hosts_file,
            strict_host_key_checking: "yes",
            disable_password_prompts,
            connect_timeout_seconds: None,
            probe_safety_options: false,
        },
    )
}

pub(crate) fn build_host_key_probe_arguments(
    config: &SshConnectionConfig,
    temporary_known_hosts_file: &Path,
    connect_timeout_seconds: u64,
) -> Vec<String> {
    let mut arguments = build_connection_options_with_policy(
        config,
        ConnectionOptionPolicy {
            batch_mode: true,
            known_hosts_file: temporary_known_hosts_file,
            strict_host_key_checking: "accept-new",
            disable_password_prompts: false,
            connect_timeout_seconds: Some(connect_timeout_seconds),
            probe_safety_options: true,
        },
    );
    arguments.insert(0, "-T".into());
    arguments.push(config.hostname.clone());
    arguments.push("exit".into());
    arguments
}

fn build_interactive_arguments(
    config: &SshConnectionConfig,
    multiplex_control: Option<&MultiplexControl>,
) -> Vec<String> {
    let mut arguments = build_connection_options(config, false);
    arguments.insert(0, "-v".into());
    if let Some(control) = multiplex_control {
        arguments.extend(control.master_arguments());
    }
    if config.startup_command.is_some() {
        arguments.push("-t".into());
    }
    arguments.push(config.hostname.clone());
    if let Some(command) = &config.startup_command {
        arguments.push(command.clone());
    }
    arguments
}

#[cfg(test)]
pub(crate) fn build_arguments(config: &SshConnectionConfig) -> Vec<String> {
    build_interactive_arguments(config, None)
}

pub(crate) fn build_sftp_arguments(config: &SshConnectionConfig) -> Vec<String> {
    let mut arguments = build_connection_options(config, false);
    arguments.push("-s".into());
    arguments.push(config.hostname.clone());
    arguments.push("sftp".into());
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

fn normalize_private_key(value: &str) -> String {
    let value = value.trim_start_matches('\u{feff}').trim();
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = if !normalized.contains('\n') && normalized.contains("\\n") {
        normalized.replace("\\n", "\n")
    } else {
        normalized
    };
    format!("{}\n", normalized.trim_end())
}

async fn identity_file(
    pool: &SqlitePool,
    vault_state: &VaultState,
    host: &Host,
) -> Result<(Option<String>, Option<Arc<EphemeralIdentityFile>>)> {
    if host.authentication_type != "key" {
        return Ok((None, None));
    }
    let key_id = host
        .key_id
        .as_deref()
        .ok_or_else(|| LumaError::KeyUnavailable("host has no key reference".into()))?;
    let key = key_references::get(pool, key_id)
        .await?
        .ok_or_else(|| LumaError::KeyUnavailable("key reference no longer exists".into()))?;
    if key.storage_mode == "encrypted-vault" {
        let private_key = Zeroizing::new(
            vault::load(pool, vault_state, "key", key_id, "private-key")
                .await?
                .ok_or_else(|| LumaError::KeyUnavailable("vault key has no private key".into()))?,
        );
        let path = std::env::temp_dir().join(format!("luma-ssh-{}.key", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        use std::io::Write;
        let mut file = options.open(&path).map_err(|error| {
            LumaError::KeyUnavailable(format!("could not prepare vault key: {error}"))
        })?;
        let normalized_private_key = Zeroizing::new(normalize_private_key(&private_key));
        let write_result = file.write_all(normalized_private_key.as_bytes());
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&path);
            return Err(LumaError::KeyUnavailable(format!(
                "could not prepare vault key: {error}"
            )));
        }
        drop(file);
        let guard = Arc::new(EphemeralIdentityFile(path.clone()));
        return Ok((Some(path.to_string_lossy().into_owned()), Some(guard)));
    }
    if key.storage_mode == "ssh-agent" {
        return Ok((None, None));
    }
    if key.storage_mode != "local-path" {
        return Err(LumaError::KeyUnavailable(
            "unsupported key storage mode".into(),
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
    Ok((Some(resolved.to_string_lossy().into_owned()), None))
}

struct ResolvedConnectionRoute {
    host: Host,
    identity: Option<identities::Identity>,
    proxy_jumps: Vec<ProxyTarget>,
}

async fn resolve_connection_route(
    pool: &SqlitePool,
    host_id: &str,
) -> Result<ResolvedConnectionRoute> {
    let mut host = hosts::get(pool, host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    let identity = if let Some(identity_id) = &host.identity_id {
        let identity = identities::get(pool, identity_id)
            .await?
            .ok_or_else(|| LumaError::InvalidInput("selected identity no longer exists".into()))?;
        host.username = Some(identity.username.clone());
        if let Some(key_id) = &identity.key_id {
            host.authentication_type = "key".into();
            host.key_id = Some(key_id.clone());
        } else if identity.has_password {
            host.authentication_type = "password".into();
        }
        Some(identity)
    } else {
        None
    };

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

    Ok(ResolvedConnectionRoute {
        host,
        identity,
        proxy_jumps,
    })
}

pub(crate) async fn host_key_connection_config(
    pool: &SqlitePool,
    host_id: &str,
    known_hosts_file: PathBuf,
) -> Result<SshConnectionConfig> {
    let route = resolve_connection_route(pool, host_id).await?;
    let executable = detect().path.ok_or_else(|| {
        LumaError::SshUnavailable("system OpenSSH executable was not found".into())
    })?;

    Ok(SshConnectionConfig {
        executable,
        hostname: route.host.hostname,
        port: route.host.port,
        known_hosts_file,
        username: route.host.username,
        identity_file: None,
        proxy_jumps: route.proxy_jumps,
        startup_command: None,
        askpass_identity_id: None,
        askpass_service: None,
        askpass_prompt: None,
        ephemeral_credential: None,
        ephemeral_identity_file: None,
    })
}

pub async fn connection_config(
    pool: &SqlitePool,
    vault_state: &VaultState,
    host_id: &str,
) -> Result<(SshConnectionConfig, String)> {
    let route = resolve_connection_route(pool, host_id).await?;
    let host = route.host;
    let mut askpass_identity_id = None;
    let mut askpass_service = None;
    let mut askpass_prompt = None;
    let mut ephemeral_credential = None;
    if let Some(identity) = &route.identity {
        if identity.key_id.is_none() && identity.has_password {
            askpass_identity_id = Some(identity.id.clone());
            askpass_service = Some("luma.ssh.identity".into());
            askpass_prompt = Some("password".into());
        }
    }
    let detection = detect();
    let executable = detection.path.ok_or_else(|| {
        LumaError::SshUnavailable("system OpenSSH executable was not found".into())
    })?;
    let known_hosts_file = known_hosts::file_path_for_pool(pool).await?;
    let (identity_file, ephemeral_identity_file) = identity_file(pool, vault_state, &host).await?;
    if host.authentication_type == "key" {
        if let Some(key_id) = host.key_id.as_deref() {
            let has_saved_passphrase = sqlx::query_scalar::<_, i64>(
                "SELECT EXISTS(SELECT 1 FROM vault_secrets WHERE owner_type='key' AND owner_id=?1 AND secret_type='passphrase')",
            )
            .bind(key_id)
            .fetch_one(pool)
            .await?
                != 0;
            if has_saved_passphrase {
                let passphrase = vault::load(pool, vault_state, "key", key_id, "passphrase")
                    .await?
                    .unwrap_or_default();
                if !passphrase.is_empty() {
                    let service = "luma.ssh.key-passphrase".to_string();
                    let account = uuid::Uuid::new_v4().to_string();
                    keyring::Entry::new(&service, &account)
                        .and_then(|entry| entry.set_password(&passphrase))
                        .map_err(|error| {
                            LumaError::KeyUnavailable(format!(
                                "could not prepare saved key passphrase: {error}"
                            ))
                        })?;
                    askpass_identity_id = Some(account.clone());
                    askpass_service = Some(service.clone());
                    askpass_prompt = Some("passphrase".into());
                    ephemeral_credential = Some(Arc::new(EphemeralCredential { service, account }));
                }
            }
        }
    }

    Ok((
        SshConnectionConfig {
            executable,
            hostname: host.hostname,
            port: host.port,
            known_hosts_file,
            username: host.username,
            identity_file,
            proxy_jumps: route.proxy_jumps,
            startup_command: host.startup_command,
            askpass_identity_id,
            askpass_service,
            askpass_prompt,
            ephemeral_credential,
            ephemeral_identity_file,
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
        || lower.contains("getaddrinfo")
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
            known_hosts_file: "/tmp/luma-known_hosts".into(),
            username: Some("alice".into()),
            identity_file: None,
            proxy_jumps: vec![],
            startup_command: None,
            askpass_identity_id: None,
            askpass_service: None,
            askpass_prompt: None,
            ephemeral_credential: None,
            ephemeral_identity_file: None,
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
                    "-v",
                    "-p",
                    "2222",
                    "-l",
                    "alice",
                    "-o",
                    "BatchMode=no",
                    "-o",
                    "UserKnownHostsFile=/tmp/luma-known_hosts",
                    "-o",
                    "GlobalKnownHostsFile=none",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "UpdateHostKeys=no",
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
                "-v",
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
                "-o",
                "UserKnownHostsFile=/tmp/luma-known_hosts",
                "-o",
                "GlobalKnownHostsFile=none",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "UpdateHostKeys=no",
                "-J",
                "jump@edge.example.com:22,[2001:db8::1]:2200",
                "-t",
                "server.example.com",
                "cd /srv && exec bash -l"
            ]
        );
    }

    #[test]
    fn builds_strict_host_key_probe_arguments_with_proxy_jump_and_user_config_enabled() {
        let mut config = base_config();
        config.hostname = "meow-meow-meow".into();
        config.proxy_jumps = vec![ProxyTarget {
            hostname: "relay.example.com".into(),
            port: 2200,
            username: Some("jump".into()),
        }];

        let arguments =
            build_host_key_probe_arguments(&config, Path::new("/tmp/luma-probe-known_hosts"), 10);
        assert_eq!(
            arguments,
            vec![
                "-T",
                "-p",
                "2222",
                "-l",
                "alice",
                "-o",
                "BatchMode=yes",
                "-o",
                "UserKnownHostsFile=/tmp/luma-probe-known_hosts",
                "-o",
                "GlobalKnownHostsFile=none",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "UpdateHostKeys=no",
                "-o",
                "ConnectTimeout=10",
                "-o",
                "ConnectionAttempts=1",
                "-o",
                "ClearAllForwardings=yes",
                "-o",
                "RemoteCommand=none",
                "-o",
                "ControlMaster=no",
                "-o",
                "ControlPath=none",
                "-J",
                "jump@relay.example.com:2200",
                "meow-meow-meow",
                "exit"
            ]
        );
        assert!(!arguments.iter().any(|argument| argument == "-F"));
    }

    #[test]
    fn builds_sftp_subsystem_arguments_without_pty_or_startup_command() {
        let mut config = base_config();
        config.startup_command = Some("must-not-run".into());
        let arguments = build_sftp_arguments(&config);

        assert_eq!(
            arguments,
            vec![
                "-p",
                "2222",
                "-l",
                "alice",
                "-o",
                "BatchMode=no",
                "-o",
                "UserKnownHostsFile=/tmp/luma-known_hosts",
                "-o",
                "GlobalKnownHostsFile=none",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "UpdateHostKeys=no",
                "-s",
                "server.example.com",
                "sftp"
            ]
        );
        assert!(!arguments.iter().any(|argument| argument == "-t"));
        assert!(!arguments.iter().any(|argument| argument == "must-not-run"));
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
    fn authentication_observer_handles_split_openssh_markers() {
        let mut observer = AuthenticationObserver::default();
        assert!(!observer.observe(b"debug1: Entering inter"));
        assert!(observer.observe(b"active session.\r\n"));
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

    #[test]
    fn normalizes_private_keys_for_openssh() {
        assert_eq!(
            normalize_private_key("\u{feff}-----BEGIN KEY-----\r\ndata\r\n-----END KEY-----"),
            "-----BEGIN KEY-----\ndata\n-----END KEY-----\n"
        );
        assert_eq!(
            normalize_private_key("-----BEGIN KEY-----\\ndata\\n-----END KEY-----"),
            "-----BEGIN KEY-----\ndata\n-----END KEY-----\n"
        );
    }
}
