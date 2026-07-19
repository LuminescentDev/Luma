use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Pty};
use tokio::sync::{mpsc, oneshot};

use super::{
    DataCallback, ExitCallback, RemoteOsCallback, SshConnectionConfig, SshExit,
    SSH_AUTHENTICATED_MARKER,
};
use crate::errors::{LumaError, Result};
use crate::terminal::logging::SessionLogManager;
use crate::terminal::{SessionLogMode, SessionLogStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SshBackend {
    Embedded,
    OpenSsh,
}

pub(crate) fn select_backend(config: &SshConnectionConfig) -> SshBackend {
    if !config.proxy_jumps.is_empty() || config.username.is_none() {
        return SshBackend::OpenSsh;
    }
    if config.identity_file.is_some()
        || (config.askpass_identity_id.is_some()
            && config.askpass_prompt.as_deref() == Some("password"))
    {
        return SshBackend::Embedded;
    }
    // Agent, hardware-token, and fully interactive authentication still need
    // the system client because russh cannot access the user's SSH agent here.
    SshBackend::OpenSsh
}

enum PingFailure {
    Timeout,
    ConnectionLost(String),
    SshError(String),
}

enum Control {
    Write(Vec<u8>),
    Resize(u16, u16),
    Ping(oneshot::Sender<std::result::Result<u64, PingFailure>>),
    Disconnect,
}

#[derive(Default)]
pub struct EmbeddedSshManager {
    sessions: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Control>>>>,
    logs: SessionLogManager,
}

#[derive(Clone)]
pub(crate) struct Client {
    trusted_keys: Arc<Vec<PublicKey>>,
    key_mismatch: Arc<AtomicBool>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        let trusted = self.trusted_keys.iter().any(|candidate| candidate == key);
        if !trusted {
            self.key_mismatch.store(true, Ordering::Release);
        }
        Ok(trusted)
    }
}

fn notify_frontend_authenticated(on_data: &mut DataCallback) {
    on_data(SSH_AUTHENTICATED_MARKER);
}

impl EmbeddedSshManager {
    pub async fn connect(
        &self,
        config: SshConnectionConfig,
        cols: u16,
        rows: u16,
        mut on_data: DataCallback,
        on_exit: ExitCallback,
        on_remote_os: RemoteOsCallback,
    ) -> Result<String> {
        let handle = Arc::new(authenticated_handle(&config).await?);

        let remote_os = detect_remote_os(&handle).await;
        let mut channel = handle.channel_open_session().await.map_err(connect_error)?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                u32::from(cols),
                u32::from(rows),
                0,
                0,
                &[(Pty::ECHO, 1)],
            )
            .await
            .map_err(connect_error)?;
        if let Some(command) = config.startup_command.as_deref() {
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(connect_error)?;
        } else {
            channel.request_shell(true).await.map_err(connect_error)?;
        }

        // Input is already serialized and coalesced by the frontend. An
        // unbounded control lane makes command submission synchronous and
        // avoids holding a Tauri invoke open while a busy SSH transport drains.
        let (control_tx, mut control_rx) = mpsc::unbounded_channel();
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(id.clone(), control_tx);
        self.logs.register(&id, cols, rows);
        let sessions = Arc::clone(&self.sessions);
        let logs = self.logs.clone();
        let task_id = id.clone();
        let _identity = config.ephemeral_identity_file.clone();
        let _credential = config.ephemeral_credential.clone();
        // System OpenSSH reports this marker through LocalCommand once auth is
        // complete. Embedded SSH has already authenticated by this point, so
        // emit the same internal signal before terminal output starts. The
        // frontend consumes it behind the connection overlay, marks the
        // session connected, and can then replace the host icon with the
        // distro metadata emitted immediately below.
        notify_frontend_authenticated(&mut on_data);
        on_remote_os(remote_os);

        tauri::async_runtime::spawn(async move {
            let handle = handle;
            let _identity = _identity;
            let _credential = _credential;
            let mut exit_code = None;
            let mut failure = None;
            let mut channel_disappeared = false;
            loop {
                tokio::select! {
                    control = control_rx.recv() => match control {
                        Some(Control::Write(data)) => {
                            if let Err(error) = channel.data_bytes(data).await {
                                failure = Some(error.to_string());
                                break;
                            }
                        }
                        Some(Control::Resize(cols, rows)) => {
                            if let Err(error) = channel.window_change(u32::from(cols), u32::from(rows), 0, 0).await {
                                failure = Some(error.to_string());
                                break;
                            }
                        }
                        Some(Control::Ping(reply)) => {
                            let handle = Arc::clone(&handle);
                            tauri::async_runtime::spawn(async move {
                                let started = Instant::now();
                                let result = match tokio::time::timeout(
                                    Duration::from_secs(5),
                                    handle.channel_open_session(),
                                )
                                .await
                                {
                                    Ok(Ok(channel)) => {
                                        let _ = channel.close().await;
                                        Ok(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
                                    }
                                    Ok(Err(error)) if handle.is_closed() => {
                                        Err(PingFailure::ConnectionLost(error.to_string()))
                                    }
                                    Ok(Err(error)) => Err(PingFailure::SshError(error.to_string())),
                                    Err(_) => Err(PingFailure::Timeout),
                                };
                                let _ = reply.send(result);
                            });
                        }
                        Some(Control::Disconnect) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            break;
                        }
                    },
                    message = channel.wait() => match message {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                            logs.write(&task_id, &data);
                            on_data(&data);
                        }
                        Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                        None => {
                            channel_disappeared = true;
                            break;
                        }
                        _ => {}
                    }
                }
            }
            sessions.lock().unwrap().remove(&task_id);
            logs.unregister(&task_id);
            let (error_category, error_message) = if let Some(message) = failure {
                (Some("connection-lost".into()), Some(message))
            } else if channel_disappeared && handle.is_closed() {
                (
                    Some("connection-lost".into()),
                    Some("The SSH transport closed unexpectedly".into()),
                )
            } else if exit_code.is_some_and(|code| code != 0) {
                (
                    Some("ssh-error".into()),
                    Some("The remote SSH session exited with a non-zero status".into()),
                )
            } else {
                (None, None)
            };
            on_exit(SshExit {
                code: exit_code,
                error_category,
                error_message,
            });
        });
        Ok(id)
    }

    pub fn write(&self, session_id: &str, data: String) -> Result<bool> {
        self.send(session_id, Control::Write(data.into_bytes()))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<bool> {
        let sent = self.send(session_id, Control::Resize(cols, rows))?;
        if sent {
            self.logs.update_dimensions(session_id, cols, rows);
        }
        Ok(sent)
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.logs.contains(session_id)
    }

    pub fn log_start(
        &self,
        session_id: &str,
        mode: SessionLogMode,
        path: Option<&str>,
        app_data_dir: &Path,
    ) -> Result<PathBuf> {
        self.logs.start(session_id, mode, path, app_data_dir)
    }

    pub fn log_stop(&self, session_id: &str) -> Result<()> {
        self.logs.stop(session_id)
    }

    pub fn log_status(&self, session_id: &str) -> Result<SessionLogStatus> {
        self.logs.status(session_id)
    }

    pub async fn ping(&self, session_id: &str) -> Result<Option<u64>> {
        let sender = self.sessions.lock().unwrap().get(session_id).cloned();
        let Some(sender) = sender else {
            return Ok(None);
        };
        let (reply, receiver) = oneshot::channel();
        sender
            .send(Control::Ping(reply))
            .map_err(|_| LumaError::SshConnection {
                category: "connection-lost",
                message: "SSH session is no longer available".into(),
            })?;
        let latency = tokio::time::timeout(Duration::from_secs(6), receiver)
            .await
            .map_err(|_| LumaError::SshConnection {
                category: "timeout",
                message: "SSH ping timed out".into(),
            })?
            .map_err(|_| LumaError::SshConnection {
                category: "connection-lost",
                message: "SSH session closed during ping".into(),
            })?
            .map_err(|failure| match failure {
                PingFailure::Timeout => LumaError::SshConnection {
                    category: "timeout",
                    message: "SSH ping timed out".into(),
                },
                PingFailure::ConnectionLost(message) => LumaError::SshConnection {
                    category: "connection-lost",
                    message: format!("SSH ping failed because the transport closed: {message}"),
                },
                PingFailure::SshError(message) => LumaError::SshConnection {
                    category: "ssh-error",
                    message: format!("SSH ping request failed: {message}"),
                },
            })?;
        Ok(Some(latency))
    }

    pub fn disconnect(&self, session_id: &str) -> Result<bool> {
        self.send(session_id, Control::Disconnect)
    }

    fn send(&self, session_id: &str, control: Control) -> Result<bool> {
        let sender = self.sessions.lock().unwrap().get(session_id).cloned();
        let Some(sender) = sender else {
            return Ok(false);
        };
        sender
            .send(control)
            .map_err(|_| LumaError::Pty("SSH session is no longer available".into()))?;
        Ok(true)
    }

    pub fn kill_all(&self) {
        let senders: Vec<_> = self
            .sessions
            .lock()
            .unwrap()
            .drain()
            .map(|(_, tx)| tx)
            .collect();
        for sender in senders {
            let _ = sender.send(Control::Disconnect);
        }
    }
}

fn credential_secret(config: &SshConnectionConfig, prompt: &str) -> Result<Option<String>> {
    if config.askpass_prompt.as_deref() != Some(prompt) {
        return Ok(None);
    }
    let (Some(service), Some(account)) = (&config.askpass_service, &config.askpass_identity_id)
    else {
        return Ok(None);
    };
    keyring::Entry::new(service, account)
        .and_then(|entry| entry.get_password())
        .map(Some)
        .map_err(|error| {
            LumaError::KeyUnavailable(format!("credential store unavailable: {error}"))
        })
}

fn fallback_password_secret(config: &SshConnectionConfig) -> Result<Option<String>> {
    let Some(account) = &config.fallback_password_identity_id else {
        return Ok(None);
    };
    keyring::Entry::new("luma.ssh.identity", account)
        .and_then(|entry| entry.get_password())
        .map(Some)
        .map_err(|error| {
            LumaError::KeyUnavailable(format!("credential store unavailable: {error}"))
        })
}

pub(crate) async fn authenticated_handle(
    config: &SshConnectionConfig,
) -> Result<client::Handle<Client>> {
    tracing::debug!(host = %config.hostname, port = config.port, "embedded SSH: opening transport");
    let username = config
        .username
        .clone()
        .ok_or_else(|| LumaError::InvalidInput("SSH username is required".into()))?;
    let trusted_keys = Arc::new(load_trusted_keys(config)?);
    if trusted_keys.is_empty() {
        return Err(LumaError::SshConnection {
            category: "host-key-rejected",
            message: "No trusted host key was found for this server".into(),
        });
    }
    let key_mismatch = Arc::new(AtomicBool::new(false));
    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(
            Arc::new(client::Config {
                inactivity_timeout: Some(Duration::from_secs(30)),
                keepalive_interval: Some(Duration::from_secs(15)),
                keepalive_max: 3,
                ..Default::default()
            }),
            (config.hostname.as_str(), config.port),
            Client {
                trusted_keys,
                key_mismatch: Arc::clone(&key_mismatch),
            },
        ),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: "Embedded SSH transport timed out".into(),
    })?
    .map_err(|error| {
        if key_mismatch.load(Ordering::Acquire) {
            LumaError::SshConnection {
                category: "host-key-changed",
                message: "The remote host key no longer matches the trusted key".into(),
            }
        } else {
            connect_error(error)
        }
    })?;
    tracing::debug!(host = %config.hostname, "embedded SSH: transport established");
    let authenticated = if let Some(identity_file) = &config.identity_file {
        let passphrase = credential_secret(config, "passphrase")?;
        let key = load_secret_key(identity_file, passphrase.as_deref()).map_err(|error| {
            LumaError::KeyUnavailable(format!("could not load private key: {error}"))
        })?;
        tracing::debug!(host = %config.hostname, "embedded SSH: authenticating with private key");
        let hash = tokio::time::timeout(Duration::from_secs(5), handle.best_supported_rsa_hash())
            .await
            .map_err(|_| LumaError::SshConnection {
                category: "timeout",
                message: "SSH signature negotiation timed out".into(),
            })?
            .map_err(connect_error)?
            .flatten();
        let key_authenticated = tokio::time::timeout(
            Duration::from_secs(15),
            handle.authenticate_publickey(
                username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            ),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH key authentication timed out".into(),
        })?
        .map_err(connect_error)?
        .success();
        if key_authenticated {
            true
        } else if let Some(password) = fallback_password_secret(config)? {
            tracing::debug!(host = %config.hostname, "embedded SSH: public key rejected, trying saved fallback password");
            tokio::time::timeout(
                Duration::from_secs(15),
                handle.authenticate_password(username, password),
            )
            .await
            .map_err(|_| LumaError::SshConnection {
                category: "timeout",
                message: "SSH fallback password authentication timed out".into(),
            })?
            .map_err(connect_error)?
            .success()
        } else {
            false
        }
    } else {
        let password =
            credential_secret(config, "password")?.ok_or_else(|| LumaError::SshConnection {
                category: "auth-failed",
                message: "Saved SSH password was unavailable".into(),
            })?;
        tracing::debug!(host = %config.hostname, "embedded SSH: authenticating with saved password");
        tokio::time::timeout(
            Duration::from_secs(15),
            handle.authenticate_password(username, password),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH password authentication timed out".into(),
        })?
        .map_err(connect_error)?
        .success()
    };
    if !authenticated {
        return Err(LumaError::SshConnection {
            category: "auth-failed",
            message: "SSH authentication failed".into(),
        });
    }
    tracing::debug!(host = %config.hostname, "embedded SSH: authentication succeeded");
    Ok(handle)
}

fn load_trusted_keys(config: &SshConnectionConfig) -> Result<Vec<PublicKey>> {
    let text = std::fs::read_to_string(&config.known_hosts_file)?;
    let target = if config.port == 22 {
        config.hostname.clone()
    } else {
        format!("[{}]:{}", config.hostname, config.port)
    };
    Ok(text
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let hosts = fields.next()?;
            let algorithm = fields.next()?;
            let encoded = fields.next()?;
            hosts
                .split(',')
                .any(|host| host == target)
                .then(|| PublicKey::from_openssh(&format!("{algorithm} {encoded}")))
                .and_then(std::result::Result::ok)
        })
        .collect())
}

pub(crate) fn connect_error(error: russh::Error) -> LumaError {
    let category = match &error {
        russh::Error::UnknownKey
        | russh::Error::WrongServerSig
        | russh::Error::KeyChanged { .. } => "host-key-rejected",
        russh::Error::ConnectionTimeout
        | russh::Error::KeepaliveTimeout
        | russh::Error::InactivityTimeout
        | russh::Error::Elapsed(_) => "timeout",
        russh::Error::IO(error) if error.kind() == std::io::ErrorKind::TimedOut => "timeout",
        russh::Error::IO(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::HostUnreachable
                    | std::io::ErrorKind::NetworkUnreachable
            ) =>
        {
            "host-unreachable"
        }
        russh::Error::IO(error)
            if {
                let lower = error.to_string().to_ascii_lowercase();
                lower.contains("could not resolve")
                    || lower.contains("name or service not known")
                    || lower.contains("nodename nor servname")
                    || lower.contains("no such host")
                    || lower.contains("getaddrinfo")
            } =>
        {
            "dns-failed"
        }
        _ => "ssh-error",
    };
    LumaError::SshConnection {
        category,
        message: format!("embedded SSH connection failed: {error}"),
    }
}

async fn detect_remote_os(handle: &client::Handle<Client>) -> super::SshRemoteOs {
    let operation = async {
        let release = capture_remote_command(handle, b"cat /etc/os-release").await?;
        let detected = super::remote_os::parse_os_release(&String::from_utf8_lossy(&release));
        if detected.os_id != "unknown" {
            return Some(detected);
        }

        let uname = capture_remote_command(handle, b"uname -s").await?;
        let detected = super::remote_os::normalize_uname(&String::from_utf8_lossy(&uname));
        if detected.os_id != "unknown" {
            return Some(detected);
        }

        let version = capture_remote_command(handle, b"cmd /c ver").await?;
        Some(super::remote_os::normalize_uname(&String::from_utf8_lossy(
            &version,
        )))
    };
    tokio::time::timeout(Duration::from_secs(3), operation)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(super::SshRemoteOs::unknown)
}

async fn capture_remote_command(
    handle: &client::Handle<Client>,
    command: &[u8],
) -> Option<Vec<u8>> {
    const MAX_OUTPUT_BYTES: usize = 64 * 1024;
    let mut channel = handle.channel_open_session().await.ok()?;
    channel.exec(true, command).await.ok()?;
    let mut output = Vec::new();
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                if output.len() + data.len() > MAX_OUTPUT_BYTES {
                    return None;
                }
                output.extend_from_slice(&data);
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn reports_authentication_with_the_shared_frontend_marker() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let received_by_callback = Arc::clone(&received);
        let mut callback: DataCallback = Box::new(move |bytes| {
            received_by_callback
                .lock()
                .unwrap()
                .extend_from_slice(bytes);
        });

        notify_frontend_authenticated(&mut callback);

        assert_eq!(*received.lock().unwrap(), SSH_AUTHENTICATED_MARKER);
    }

    fn config() -> SshConnectionConfig {
        SshConnectionConfig {
            executable: "ssh".into(),
            hostname: "example.com".into(),
            port: 22,
            known_hosts_file: PathBuf::from("known_hosts"),
            username: Some("deploy".into()),
            identity_file: Some("id_ed25519".into()),
            proxy_jumps: Vec::new(),
            startup_command: None,
            askpass_identity_id: None,
            askpass_service: None,
            askpass_prompt: None,
            fallback_password_identity_id: None,
            ephemeral_credential: None,
            ephemeral_identity_file: None,
        }
    }

    #[test]
    fn uses_embedded_backend_for_direct_private_key_hosts() {
        assert_eq!(select_backend(&config()), SshBackend::Embedded);
    }

    #[test]
    fn falls_back_for_proxy_jump() {
        let mut value = config();
        value.proxy_jumps.push(super::super::ProxyTarget {
            hostname: "jump".into(),
            port: 22,
            username: None,
        });
        assert_eq!(select_backend(&value), SshBackend::OpenSsh);
    }
}
