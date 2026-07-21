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
use crate::session_logging::{SessionLogManager, SessionLogMode, SessionLogStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SshBackend {
    Embedded,
    OpenSsh,
}

pub(crate) fn select_backend(config: &SshConnectionConfig) -> Result<SshBackend> {
    select_backend_for(config, cfg!(any(target_os = "android", target_os = "ios")))
}

fn select_backend_for(config: &SshConnectionConfig, mobile: bool) -> Result<SshBackend> {
    if mobile {
        if !config.proxy_jumps.is_empty() {
            return Err(LumaError::CapabilityUnavailable {
                feature: "systemSsh",
                message: "ProxyJump requires system OpenSSH, which is unavailable on mobile".into(),
            });
        }
        if config.username.is_none() {
            return Err(LumaError::InvalidInput("SSH username is required".into()));
        }
        if config.identity_file.is_some() || config.password.is_some() {
            return Ok(SshBackend::Embedded);
        }
        return Err(LumaError::CapabilityUnavailable {
            feature: "systemSsh",
            message: "SSH agent and interactive authentication require system OpenSSH, which is unavailable on mobile".into(),
        });
    }

    if !config.proxy_jumps.is_empty() || config.username.is_none() {
        return Ok(SshBackend::OpenSsh);
    }
    if config.identity_file.is_some()
        || config.password.is_some()
        || (config.askpass_identity_id.is_some()
            && config.askpass_prompt.as_deref() == Some("password"))
    {
        return Ok(SshBackend::Embedded);
    }
    // Agent, hardware-token, and fully interactive authentication still need
    // the system client because russh cannot access the user's SSH agent here.
    Ok(SshBackend::OpenSsh)
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
        let mut channel =
            tokio::time::timeout(Duration::from_secs(15), handle.channel_open_session())
                .await
                .map_err(|_| LumaError::SshConnection {
                    category: "timeout",
                    message: "SSH channel open timed out".into(),
                })?
                .map_err(connect_error)?;
        tokio::time::timeout(
            Duration::from_secs(15),
            channel.request_pty(
                true,
                "xterm-256color",
                u32::from(cols),
                u32::from(rows),
                0,
                0,
                &[(Pty::ECHO, 1)],
            ),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH PTY request timed out".into(),
        })?
        .map_err(connect_error)?;
        if let Some(command) = config.startup_command.as_deref() {
            tokio::time::timeout(
                Duration::from_secs(15),
                channel.exec(true, command.as_bytes()),
            )
            .await
            .map_err(|_| LumaError::SshConnection {
                category: "timeout",
                message: "SSH startup command request timed out".into(),
            })?
            .map_err(connect_error)?;
        } else {
            tokio::time::timeout(Duration::from_secs(15), channel.request_shell(true))
                .await
                .map_err(|_| LumaError::SshConnection {
                    category: "timeout",
                    message: "SSH shell request timed out".into(),
                })?
                .map_err(connect_error)?;
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
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
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
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
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
    let direct = match prompt {
        "password" => config.password.as_deref(),
        "passphrase" => config.key_passphrase.as_deref(),
        _ => None,
    };
    if let Some(secret) = direct {
        return Ok(Some(secret.to_string()));
    }
    if config.askpass_prompt.as_deref() != Some(prompt) {
        return Ok(None);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    Ok(None)
}

fn fallback_password_secret(config: &SshConnectionConfig) -> Result<Option<String>> {
    if let Some(secret) = config.fallback_password.as_deref() {
        return Ok(Some(secret.to_string()));
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
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
    #[cfg(any(target_os = "android", target_os = "ios"))]
    Ok(None)
}

#[derive(Clone, Copy)]
struct EmbeddedSshTimeouts {
    connect: Duration,
    signature_negotiation: Duration,
    authentication: Duration,
}

impl Default for EmbeddedSshTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            signature_negotiation: Duration::from_secs(5),
            authentication: Duration::from_secs(15),
        }
    }
}

pub(crate) async fn authenticated_handle(
    config: &SshConnectionConfig,
) -> Result<client::Handle<Client>> {
    authenticated_handle_with_timeouts(config, EmbeddedSshTimeouts::default()).await
}

async fn authenticated_handle_with_timeouts(
    config: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
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
    let addresses = tokio::time::timeout(
        timeouts.connect,
        tokio::net::lookup_host((config.hostname.as_str(), config.port)),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: "Embedded SSH DNS resolution timed out".into(),
    })?
    .map_err(|error| LumaError::SshConnection {
        category: "dns-failed",
        message: format!("Embedded SSH hostname resolution failed: {error}"),
    })?
    .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(LumaError::SshConnection {
            category: "dns-failed",
            message: "Embedded SSH hostname resolution returned no addresses".into(),
        });
    }
    let socket = tokio::time::timeout(
        timeouts.connect,
        tokio::net::TcpStream::connect(&addresses[..]),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: "Embedded SSH TCP connection timed out".into(),
    })?
    .map_err(|error| connect_io_error("Embedded SSH TCP connection failed", error))?;
    let client_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    });
    let mut handle = tokio::time::timeout(
        timeouts.connect,
        client::connect_stream(
            client_config,
            socket,
            Client {
                trusted_keys,
                key_mismatch: Arc::clone(&key_mismatch),
            },
        ),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: "Embedded SSH protocol handshake timed out".into(),
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
        let hash = tokio::time::timeout(
            timeouts.signature_negotiation,
            handle.best_supported_rsa_hash(),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH signature negotiation timed out".into(),
        })?
        .map_err(connect_error)?
        .flatten();
        let key_authenticated = tokio::time::timeout(
            timeouts.authentication,
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
                timeouts.authentication,
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
            timeouts.authentication,
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

fn connect_io_error(context: &str, error: std::io::Error) -> LumaError {
    let category = if error.kind() == std::io::ErrorKind::TimedOut {
        "timeout"
    } else if matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionRefused
            | std::io::ErrorKind::HostUnreachable
            | std::io::ErrorKind::NetworkUnreachable
    ) {
        "host-unreachable"
    } else {
        "ssh-error"
    };
    LumaError::SshConnection {
        category,
        message: format!("{context}: {error}"),
    }
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

    use rand::rngs::OsRng;
    use russh::server::{self, Msg, Session};
    use russh::{Channel, ChannelId, Disconnect};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    const TEST_USERNAME: &str = "luma-test";
    const TEST_PASSWORD: &str = "correct horse battery staple";

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum ServerEvent {
        SessionOpened,
        PtyRequested(u32, u32),
        ShellRequested,
        Data(Vec<u8>),
        Resized(u32, u32),
        Eof,
        Closed,
    }

    #[derive(Clone)]
    struct TestServerHandler {
        allowed_public_key: Option<(String, String)>,
        events: Arc<Mutex<Vec<ServerEvent>>>,
    }

    impl server::Handler for TestServerHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> std::result::Result<server::Auth, Self::Error> {
            Ok(if user == TEST_USERNAME && password == TEST_PASSWORD {
                server::Auth::Accept
            } else {
                server::Auth::reject()
            })
        }

        async fn auth_publickey(
            &mut self,
            user: &str,
            public_key: &russh::keys::PublicKey,
        ) -> std::result::Result<server::Auth, Self::Error> {
            let offered = public_key.to_openssh().ok().and_then(|encoded| {
                let mut fields = encoded.split_whitespace();
                Some((fields.next()?.to_string(), fields.next()?.to_string()))
            });
            Ok(
                if user == TEST_USERNAME && offered == self.allowed_public_key {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            )
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events.lock().unwrap().push(ServerEvent::SessionOpened);
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _term: &str,
            col_width: u32,
            row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(Pty, u32)],
            session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events
                .lock()
                .unwrap()
                .push(ServerEvent::PtyRequested(col_width, row_height));
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events
                .lock()
                .unwrap()
                .push(ServerEvent::ShellRequested);
            session.channel_success(channel)?;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: ChannelId,
            command: &[u8],
            session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            session.channel_success(channel)?;
            if command == b"cat /etc/os-release" {
                session.data(
                    channel,
                    b"ID=alpine\nPRETTY_NAME=\"Luma Test Server\"\n".to_vec(),
                )?;
            }
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
            Ok(())
        }

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events
                .lock()
                .unwrap()
                .push(ServerEvent::Data(data.to_vec()));
            session.data(channel, data.to_vec())?;
            Ok(())
        }

        async fn window_change_request(
            &mut self,
            _channel: ChannelId,
            col_width: u32,
            row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events
                .lock()
                .unwrap()
                .push(ServerEvent::Resized(col_width, row_height));
            Ok(())
        }

        async fn channel_eof(
            &mut self,
            _channel: ChannelId,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events.lock().unwrap().push(ServerEvent::Eof);
            Ok(())
        }

        async fn channel_close(
            &mut self,
            _channel: ChannelId,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.events.lock().unwrap().push(ServerEvent::Closed);
            Ok(())
        }
    }

    struct TestSshServer {
        address: std::net::SocketAddr,
        host_key: russh::keys::PrivateKey,
        events: Arc<Mutex<Vec<ServerEvent>>>,
        shutdown: Option<oneshot::Sender<()>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl TestSshServer {
        async fn start(
            port: u16,
            host_key: russh::keys::PrivateKey,
            allowed_public_key: Option<(String, String)>,
        ) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let handler = TestServerHandler {
                allowed_public_key,
                events: Arc::clone(&events),
            };
            let config = Arc::new(server::Config {
                auth_rejection_time: Duration::ZERO,
                auth_rejection_time_initial: Some(Duration::ZERO),
                keys: vec![host_key.clone()],
                ..Default::default()
            });
            let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
            let task = tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = &mut shutdown_rx => break,
                        accepted = listener.accept() => {
                            let Ok((socket, _)) = accepted else {
                                break;
                            };
                            let config = Arc::clone(&config);
                            let handler = handler.clone();
                            let _session_task = tokio::spawn(async move {
                                if let Ok(session) = server::run_stream(config, socket, handler).await {
                                    let _ = session.await;
                                }
                            });
                        }
                    }
                }
            });
            Self {
                address,
                host_key,
                events,
                shutdown: Some(shutdown_tx),
                task,
            }
        }

        async fn stop(mut self) {
            if let Some(shutdown) = self.shutdown.take() {
                let _ = shutdown.send(());
            }
            tokio::time::timeout(Duration::from_secs(2), self.task)
                .await
                .expect("test SSH server did not stop")
                .expect("test SSH accept task panicked");
        }
    }

    struct TestFiles(PathBuf);

    impl TestFiles {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "luma-embedded-ssh-test-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for TestFiles {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn generate_ed25519_key() -> ssh_key::PrivateKey {
        ssh_key::PrivateKey::random(&mut OsRng, ssh_key::Algorithm::Ed25519).unwrap()
    }

    fn as_russh_private_key(key: &ssh_key::PrivateKey) -> russh::keys::PrivateKey {
        let encoded = key.to_openssh(ssh_key::LineEnding::LF).unwrap();
        russh::keys::PrivateKey::from_openssh(encoded.as_bytes()).unwrap()
    }

    fn public_key_identity(encoded: &str) -> (String, String) {
        let mut fields = encoded.split_whitespace();
        (
            fields.next().unwrap().to_string(),
            fields.next().unwrap().to_string(),
        )
    }

    fn write_known_host(path: &Path, address: std::net::SocketAddr, key: &russh::keys::PrivateKey) {
        let encoded = key.public_key().to_openssh().unwrap();
        let (algorithm, key_data) = public_key_identity(&encoded);
        std::fs::write(
            path,
            format!(
                "[{}]:{} {algorithm} {key_data}\n",
                address.ip(),
                address.port()
            ),
        )
        .unwrap();
    }

    fn write_private_key(path: &Path, key: &ssh_key::PrivateKey) {
        let encoded = key.to_openssh(ssh_key::LineEnding::LF).unwrap();
        std::fs::write(path, encoded.as_bytes()).unwrap();
    }

    fn test_config(
        address: std::net::SocketAddr,
        known_hosts_file: PathBuf,
    ) -> SshConnectionConfig {
        SshConnectionConfig {
            executable: String::new(),
            hostname: address.ip().to_string(),
            port: address.port(),
            known_hosts_file,
            username: Some(TEST_USERNAME.into()),
            identity_file: None,
            proxy_jumps: Vec::new(),
            startup_command: None,
            askpass_identity_id: None,
            askpass_service: None,
            askpass_prompt: None,
            fallback_password_identity_id: None,
            password: Some(Arc::new(zeroize::Zeroizing::new(TEST_PASSWORD.into()))),
            key_passphrase: None,
            fallback_password: None,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            ephemeral_credential: None,
            ephemeral_identity_file: None,
        }
    }

    async fn disconnect_handle(handle: &client::Handle<Client>) {
        handle
            .disconnect(Disconnect::ByApplication, "test complete", "")
            .await
            .unwrap();
    }

    fn expect_connect_error(result: Result<client::Handle<Client>>) -> LumaError {
        match result {
            Ok(_) => panic!("embedded SSH connection unexpectedly succeeded"),
            Err(error) => error,
        }
    }

    async fn wait_for_event(events: &Arc<Mutex<Vec<ServerEvent>>>, expected: ServerEvent) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if events.lock().unwrap().contains(&expected) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("server did not observe {expected:?}"));
    }

    async fn wait_for_output(
        receiver: &mut mpsc::UnboundedReceiver<Vec<u8>>,
        expected: &[u8],
    ) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut output = Vec::new();
            while !output
                .windows(expected.len())
                .any(|window| window == expected)
            {
                output.extend(
                    receiver
                        .recv()
                        .await
                        .expect("embedded SSH output channel closed"),
                );
            }
            output
        })
        .await
        .expect("timed out waiting for embedded SSH output")
    }

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

    #[tokio::test]
    async fn password_authentication_succeeds_and_rejects_wrong_password() {
        let files = TestFiles::new();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server = TestSshServer::start(0, host_key, None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);

        let success_config = test_config(server.address, known_hosts.clone());
        let handle = authenticated_handle(&success_config).await.unwrap();
        disconnect_handle(&handle).await;

        let mut failure_config = test_config(server.address, known_hosts);
        failure_config.password = Some(Arc::new(zeroize::Zeroizing::new("wrong password".into())));
        let error = expect_connect_error(authenticated_handle(&failure_config).await);
        assert_eq!(error.category(), "auth-failed");

        server.stop().await;
    }

    #[tokio::test]
    async fn ed25519_and_encrypted_private_key_authentication_use_real_key_loading() {
        let files = TestFiles::new();
        let client_key = generate_ed25519_key();
        let client_public_key = client_key.public_key().to_openssh().unwrap();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server =
            TestSshServer::start(0, host_key, Some(public_key_identity(&client_public_key))).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);

        let plain_key_path = files.path("id_ed25519");
        write_private_key(&plain_key_path, &client_key);
        let mut plain_config = test_config(server.address, known_hosts.clone());
        plain_config.password = None;
        plain_config.identity_file = Some(plain_key_path.to_string_lossy().into_owned());
        let handle = authenticated_handle(&plain_config).await.unwrap();
        disconnect_handle(&handle).await;

        let passphrase = "test encrypted key passphrase";
        let encrypted_key = client_key.encrypt(&mut OsRng, passphrase).unwrap();
        let encrypted_key_path = files.path("id_ed25519_encrypted");
        write_private_key(&encrypted_key_path, &encrypted_key);

        let mut wrong_passphrase = test_config(server.address, known_hosts.clone());
        wrong_passphrase.password = None;
        wrong_passphrase.identity_file = Some(encrypted_key_path.to_string_lossy().into_owned());
        wrong_passphrase.key_passphrase = Some(Arc::new(zeroize::Zeroizing::new("wrong".into())));
        let error = expect_connect_error(authenticated_handle(&wrong_passphrase).await);
        assert_eq!(error.category(), "key-unavailable");

        let mut correct_passphrase = test_config(server.address, known_hosts);
        correct_passphrase.password = None;
        correct_passphrase.identity_file = Some(encrypted_key_path.to_string_lossy().into_owned());
        correct_passphrase.key_passphrase =
            Some(Arc::new(zeroize::Zeroizing::new(passphrase.to_string())));
        let handle = authenticated_handle(&correct_passphrase).await.unwrap();
        disconnect_handle(&handle).await;

        server.stop().await;
    }

    #[tokio::test]
    async fn interactive_session_opens_pty_echoes_resizes_and_disconnects_cleanly() {
        let files = TestFiles::new();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server = TestSshServer::start(0, host_key, None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);
        let config = test_config(server.address, known_hosts);
        let manager = EmbeddedSshManager::default();
        let (data_tx, mut data_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();
        let (remote_os_tx, remote_os_rx) = oneshot::channel();

        let session_id = manager
            .connect(
                config,
                80,
                24,
                Box::new(move |data| {
                    let _ = data_tx.send(data.to_vec());
                }),
                Box::new(move |exit| {
                    let _ = exit_tx.send(exit);
                }),
                Box::new(move |remote_os| {
                    let _ = remote_os_tx.send(remote_os);
                }),
            )
            .await
            .unwrap();

        let remote_os = tokio::time::timeout(Duration::from_secs(2), remote_os_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(remote_os.os_id, "alpine");
        let authenticated_output = wait_for_output(&mut data_rx, SSH_AUTHENTICATED_MARKER).await;
        assert!(authenticated_output
            .windows(SSH_AUTHENTICATED_MARKER.len())
            .any(|window| window == SSH_AUTHENTICATED_MARKER));
        wait_for_event(&server.events, ServerEvent::PtyRequested(80, 24)).await;
        wait_for_event(&server.events, ServerEvent::ShellRequested).await;

        assert!(manager.write(&session_id, "hello, SSH\n".into()).unwrap());
        let echoed = wait_for_output(&mut data_rx, b"hello, SSH\n").await;
        assert!(echoed
            .windows(b"hello, SSH\n".len())
            .any(|window| window == b"hello, SSH\n"));
        wait_for_event(&server.events, ServerEvent::Data(b"hello, SSH\n".to_vec())).await;

        assert!(manager.resize(&session_id, 132, 44).unwrap());
        wait_for_event(&server.events, ServerEvent::Resized(132, 44)).await;
        assert!(manager.disconnect(&session_id).unwrap());

        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            exit,
            SshExit {
                code: None,
                error_category: None,
                error_message: None,
            }
        );
        assert!(!manager.contains(&session_id));
        wait_for_event(&server.events, ServerEvent::Eof).await;

        server.stop().await;
    }

    #[tokio::test]
    async fn unknown_and_changed_host_keys_enter_confirmation_and_rejection_flows() {
        let files = TestFiles::new();
        let original_host_key = as_russh_private_key(&generate_ed25519_key());
        let original_server = TestSshServer::start(0, original_host_key, None).await;
        let port = original_server.address.port();
        let known_hosts = files.path("known_hosts");
        std::fs::write(&known_hosts, "").unwrap();
        let config = test_config(original_server.address, known_hosts.clone());

        let unknown = crate::ssh::known_hosts::status(
            &format!("unknown-{}", uuid::Uuid::new_v4()),
            &config,
            &known_hosts,
        )
        .await
        .unwrap();
        assert_eq!(
            unknown.status,
            crate::ssh::known_hosts::HostKeyStatusKind::Unknown
        );

        write_known_host(
            &known_hosts,
            original_server.address,
            &original_server.host_key,
        );
        let handle = authenticated_handle(&config).await.unwrap();
        disconnect_handle(&handle).await;
        original_server.stop().await;

        let changed_host_key = as_russh_private_key(&generate_ed25519_key());
        let changed_server = TestSshServer::start(port, changed_host_key, None).await;
        let changed_config = test_config(changed_server.address, known_hosts.clone());
        let changed = crate::ssh::known_hosts::status(
            &format!("changed-{}", uuid::Uuid::new_v4()),
            &changed_config,
            &known_hosts,
        )
        .await
        .unwrap();
        assert_eq!(
            changed.status,
            crate::ssh::known_hosts::HostKeyStatusKind::Changed
        );
        assert!(!changed.scanned_keys.is_empty());
        assert!(!changed.known_keys.is_empty());

        let error = expect_connect_error(authenticated_handle(&changed_config).await);
        assert_eq!(error.category(), "host-key-changed");

        changed_server.stop().await;
    }

    #[tokio::test]
    async fn non_responding_server_respects_short_connect_timeout() {
        let files = TestFiles::new();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, address, &host_key);
        let silent_task = tokio::spawn(async move {
            if let Ok((_socket, _)) = listener.accept().await {
                std::future::pending::<()>().await;
            }
        });
        let config = test_config(address, known_hosts);
        let short = Duration::from_millis(150);
        let started = Instant::now();

        let error = expect_connect_error(
            authenticated_handle_with_timeouts(
                &config,
                EmbeddedSshTimeouts {
                    connect: short,
                    signature_negotiation: short,
                    authentication: short,
                },
            )
            .await,
        );

        assert_eq!(error.category(), "timeout");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "short timeout took {:?}",
            started.elapsed()
        );
        silent_task.abort();
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
            password: None,
            key_passphrase: None,
            fallback_password: None,
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            ephemeral_credential: None,
            ephemeral_identity_file: None,
        }
    }

    #[test]
    fn uses_embedded_backend_for_direct_private_key_hosts() {
        assert_eq!(select_backend(&config()).unwrap(), SshBackend::Embedded);
    }

    #[test]
    fn embedded_auth_reads_password_and_key_passphrase_from_in_memory_config() {
        let mut value = config();
        value.password = Some(Arc::new(zeroize::Zeroizing::new("password secret".into())));
        value.key_passphrase = Some(Arc::new(zeroize::Zeroizing::new("key secret".into())));
        value.fallback_password = Some(Arc::new(zeroize::Zeroizing::new("fallback secret".into())));

        assert_eq!(
            credential_secret(&value, "password").unwrap().as_deref(),
            Some("password secret")
        );
        assert_eq!(
            credential_secret(&value, "passphrase").unwrap().as_deref(),
            Some("key secret")
        );
        assert_eq!(
            fallback_password_secret(&value).unwrap().as_deref(),
            Some("fallback secret")
        );
    }

    #[test]
    fn falls_back_for_proxy_jump() {
        let mut value = config();
        value.proxy_jumps.push(super::super::ProxyTarget {
            hostname: "jump".into(),
            port: 22,
            username: None,
        });
        assert_eq!(select_backend(&value).unwrap(), SshBackend::OpenSsh);
    }

    #[test]
    fn mobile_rejects_proxy_jump_with_typed_capability_error() {
        let mut value = config();
        value.proxy_jumps.push(super::super::ProxyTarget {
            hostname: "jump".into(),
            port: 22,
            username: None,
        });
        let error = select_backend_for(&value, true).unwrap_err();
        assert_eq!(error.category(), "capability-unavailable");
        assert_eq!(
            error.to_string(),
            "ProxyJump requires system OpenSSH, which is unavailable on mobile"
        );
    }

    #[test]
    fn mobile_rejects_agent_authentication_with_typed_capability_error() {
        let mut value = config();
        value.identity_file = None;
        let error = select_backend_for(&value, true).unwrap_err();
        assert_eq!(error.category(), "capability-unavailable");
        assert_eq!(
            error.to_string(),
            "SSH agent and interactive authentication require system OpenSSH, which is unavailable on mobile"
        );
    }
}
