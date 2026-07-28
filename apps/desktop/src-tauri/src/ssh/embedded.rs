use std::collections::HashMap;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::client;
use russh::keys::PublicKey;
use russh::{ChannelMsg, Pty};
use tokio::sync::{mpsc, oneshot};

use super::embedded_auth::{
    authenticate_with_prompts, authenticate_without_prompts, AuthAbort, AuthDriver,
};
use super::{
    DataCallback, ExitCallback, RemoteOsCallback, SshConnectionConfig, SshExit,
    SSH_AUTHENTICATED_MARKER,
};
use crate::errors::{LumaError, Result};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::session_logging::{SessionLogManager, SessionLogMode, SessionLogStatus};

pub(super) enum PingFailure {
    Timeout,
    Authenticating,
    ConnectionLost(String),
    SshError(String),
}

pub(super) enum Control {
    Write(Vec<u8>),
    Resize(u16, u16),
    Ping(oneshot::Sender<std::result::Result<u64, PingFailure>>),
    Disconnect,
}

#[derive(Default)]
pub struct EmbeddedSshManager {
    sessions: Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Control>>>>,
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    logs: SessionLogManager,
}

pub(super) type SharedDataCallback = Arc<Mutex<DataCallback>>;

#[derive(Clone)]
pub(crate) struct Client {
    trusted_keys: Arc<Vec<PublicKey>>,
    key_mismatch: Arc<AtomicBool>,
    on_data: Option<SharedDataCallback>,
    forwarded_tcpip: Option<mpsc::UnboundedSender<ForwardedTcpip>>,
}

pub(crate) struct ForwardedTcpip {
    pub channel: russh::Channel<client::Msg>,
    pub reply: client::ChannelOpenHandle,
}

pub(crate) struct AuthenticatedConnection {
    handle: Arc<client::Handle<Client>>,
    _predecessors: Vec<client::Handle<Client>>,
    _route: Vec<SshConnectionConfig>,
}

impl AuthenticatedConnection {
    fn new(
        handle: client::Handle<Client>,
        predecessors: Vec<client::Handle<Client>>,
        route: Vec<SshConnectionConfig>,
    ) -> Self {
        Self {
            handle: Arc::new(handle),
            _predecessors: predecessors,
            _route: route,
        }
    }

    pub(crate) fn handle(&self) -> &Arc<client::Handle<Client>> {
        &self.handle
    }
}

impl std::ops::Deref for AuthenticatedConnection {
    type Target = client::Handle<Client>;

    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn auth_banner(
        &mut self,
        banner: &str,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        if let Some(on_data) = &self.on_data {
            (on_data.lock().unwrap())(banner.as_bytes());
        }
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        if let Some(sender) = &self.forwarded_tcpip {
            let _ = sender.send(ForwardedTcpip { channel, reply });
        }
        Ok(())
    }

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
        on_data: DataCallback,
        on_exit: ExitCallback,
        on_remote_os: RemoteOsCallback,
    ) -> Result<String> {
        if config.username.is_none() {
            return Err(LumaError::InvalidInput("SSH username is required".into()));
        }
        let on_data = Arc::new(Mutex::new(on_data));
        let route = route_configs(&config);
        let first = route
            .first()
            .ok_or_else(|| LumaError::InvalidInput("SSH route is empty".into()))?;
        let handle = connect_transport(
            first,
            EmbeddedSshTimeouts::default(),
            Some(Arc::clone(&on_data)),
            None,
        )
        .await?;

        let (control_tx, control_rx) = mpsc::unbounded_channel();
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(id.clone(), control_tx);
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        self.logs.register(&id, cols, rows);
        let sessions = Arc::clone(&self.sessions);
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let logs = self.logs.clone();
        let task_id = id.clone();

        tauri::async_runtime::spawn(async move {
            let mut driver = AuthDriver::new(control_rx, cols, rows);
            let auth_result = async {
                let mut handle = handle;
                let mut predecessors = Vec::with_capacity(route.len().saturating_sub(1));
                for (index, node) in route.iter().enumerate() {
                    authenticate_with_prompts(
                        &mut handle,
                        node,
                        &mut driver,
                        &on_data,
                        EmbeddedSshTimeouts::default(),
                    )
                    .await?;
                    if let Some(next) = route.get(index + 1) {
                        let next_handle = connect_through_proxy(
                            &handle,
                            next,
                            EmbeddedSshTimeouts::default(),
                            Some(Arc::clone(&on_data)),
                            None,
                        )
                        .await
                        .map_err(AuthAbort::Error)?;
                        predecessors.push(handle);
                        handle = next_handle;
                    }
                }
                Ok::<_, AuthAbort>(AuthenticatedConnection::new(handle, predecessors, route))
            }
            .await;
            let (mut control_rx, (cols, rows)) = driver.into_parts();

            let connection = match auth_result {
                Ok(connection) => connection,
                Err(AuthAbort::Disconnect) => {
                    finish_session(
                        &sessions,
                        #[cfg(not(any(target_os = "android", target_os = "ios")))]
                        &logs,
                        &task_id,
                        on_exit,
                        SshExit {
                            code: None,
                            error_category: None,
                            error_message: None,
                        },
                    );
                    return;
                }
                Err(AuthAbort::Error(error)) => {
                    let category = error.category().to_string();
                    let message = error.to_string();
                    finish_session(
                        &sessions,
                        #[cfg(not(any(target_os = "android", target_os = "ios")))]
                        &logs,
                        &task_id,
                        on_exit,
                        SshExit {
                            code: None,
                            error_category: Some(category),
                            error_message: Some(message),
                        },
                    );
                    return;
                }
            };

            tracing::debug!(host = %config.hostname, "embedded SSH: authentication succeeded");
            {
                let mut callback = on_data.lock().unwrap();
                notify_frontend_authenticated(&mut callback);
            }

            let handle = Arc::clone(connection.handle());
            let _connection = connection;
            let mut channel = match open_shell_channel(&handle, &config, cols, rows).await {
                Ok(channel) => channel,
                Err(error) => {
                    let category = error.category().to_string();
                    let message = error.to_string();
                    finish_session(
                        &sessions,
                        #[cfg(not(any(target_os = "android", target_os = "ios")))]
                        &logs,
                        &task_id,
                        on_exit,
                        SshExit {
                            code: None,
                            error_category: Some(category),
                            error_message: Some(message),
                        },
                    );
                    return;
                }
            };

            let remote_os_handle = Arc::clone(&handle);
            tauri::async_runtime::spawn(async move {
                on_remote_os(detect_remote_os(&remote_os_handle).await);
            });

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
                            #[cfg(not(any(target_os = "android", target_os = "ios")))]
                            logs.write(&task_id, &data);
                            (on_data.lock().unwrap())(&data);
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
            finish_session(
                &sessions,
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                &logs,
                &task_id,
                on_exit,
                SshExit {
                    code: exit_code,
                    error_category,
                    error_message,
                },
            );
        });
        Ok(id)
    }

    pub fn write(&self, session_id: &str, data: String) -> Result<bool> {
        self.send(session_id, Control::Write(data.into_bytes()))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<bool> {
        let sent = self.send(session_id, Control::Resize(cols, rows))?;
        if sent {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            self.logs.update_dimensions(session_id, cols, rows);
        }
        Ok(sent)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn contains(&self, session_id: &str) -> bool {
        self.logs.contains(session_id)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn log_start(
        &self,
        session_id: &str,
        mode: SessionLogMode,
        path: Option<&str>,
        app_data_dir: &Path,
    ) -> Result<PathBuf> {
        self.logs.start(session_id, mode, path, app_data_dir)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn log_stop(&self, session_id: &str) -> Result<()> {
        self.logs.stop(session_id)
    }

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
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
                PingFailure::Authenticating => LumaError::SshConnection {
                    category: "ssh-error",
                    message: "SSH session is still authenticating".into(),
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

fn finish_session(
    sessions: &Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Control>>>>,
    #[cfg(not(any(target_os = "android", target_os = "ios")))] logs: &SessionLogManager,
    session_id: &str,
    on_exit: ExitCallback,
    exit: SshExit,
) {
    sessions.lock().unwrap().remove(session_id);
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    logs.unregister(session_id);
    on_exit(exit);
}

async fn open_shell_channel(
    handle: &client::Handle<Client>,
    config: &SshConnectionConfig,
    cols: u16,
    rows: u16,
) -> Result<russh::Channel<client::Msg>> {
    let channel = tokio::time::timeout(Duration::from_secs(15), handle.channel_open_session())
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
    Ok(channel)
}

#[derive(Clone, Copy)]
pub(super) struct EmbeddedSshTimeouts {
    pub(super) connect: Duration,
    pub(super) signature_negotiation: Duration,
    pub(super) authentication: Duration,
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

fn route_configs(config: &SshConnectionConfig) -> Vec<SshConnectionConfig> {
    let mut route = config.proxy_jumps.to_vec();
    let mut target = config.clone();
    target.proxy_jumps.clear();
    route.push(target);
    route
}

pub(super) async fn connect_tcp_stream(
    config: &SshConnectionConfig,
    timeout: Duration,
) -> Result<tokio::net::TcpStream> {
    let target = display_target(config);
    let addresses = tokio::time::timeout(
        timeout,
        tokio::net::lookup_host((config.hostname.as_str(), config.port)),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: format!("SSH DNS resolution timed out for {target}"),
    })?
    .map_err(|error| LumaError::SshConnection {
        category: "dns-failed",
        message: format!("SSH hostname resolution failed for {target}: {error}"),
    })?
    .collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(LumaError::SshConnection {
            category: "dns-failed",
            message: format!("SSH hostname resolution returned no addresses for {target}"),
        });
    }
    tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addresses[..]))
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: format!("SSH TCP connection timed out for {target}"),
        })?
        .map_err(|error| {
            connect_io_error(&format!("SSH TCP connection failed for {target}"), error)
        })
}

pub(super) async fn open_proxy_stream<H>(
    handle: &client::Handle<H>,
    next: &SshConnectionConfig,
    timeout: Duration,
) -> Result<russh::ChannelStream<client::Msg>>
where
    H: client::Handler<Error = russh::Error>,
{
    let target = display_target(next);
    let channel = tokio::time::timeout(
        timeout,
        handle.channel_open_direct_tcpip(
            next.hostname.clone(),
            u32::from(next.port),
            "127.0.0.1",
            0,
        ),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: format!("SSH proxy channel open timed out for {target}"),
    })?
    .map_err(|error| LumaError::SshConnection {
        category: "host-unreachable",
        message: format!("Could not open an SSH proxy channel to {target}: {error}"),
    })?;
    Ok(channel.into_stream())
}

fn display_target(config: &SshConnectionConfig) -> String {
    match config.username.as_deref() {
        Some(username) => format!("{username}@{}", config.hostname),
        None => config.hostname.clone(),
    }
}

async fn connect_stream_transport<S>(
    config: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
    stream: S,
    on_data: Option<SharedDataCallback>,
    forwarded_tcpip: Option<mpsc::UnboundedSender<ForwardedTcpip>>,
) -> Result<client::Handle<Client>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let target = display_target(config);
    let trusted_keys = Arc::new(load_trusted_keys(config)?);
    if trusted_keys.is_empty() {
        return Err(LumaError::SshConnection {
            category: "host-key-rejected",
            message: format!("No trusted host key was found for {target}"),
        });
    }
    let key_mismatch = Arc::new(AtomicBool::new(false));
    let client_config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    });
    let handle = tokio::time::timeout(
        timeouts.connect,
        client::connect_stream(
            client_config,
            stream,
            Client {
                trusted_keys,
                key_mismatch: Arc::clone(&key_mismatch),
                on_data,
                forwarded_tcpip,
            },
        ),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: format!("SSH protocol handshake timed out for {target}"),
    })?
    .map_err(|error| {
        if key_mismatch.load(Ordering::Acquire) {
            LumaError::SshConnection {
                category: "host-key-changed",
                message: format!(
                    "The remote host key for {target} no longer matches the trusted key"
                ),
            }
        } else {
            let error = connect_error(error);
            LumaError::SshConnection {
                category: error.category(),
                message: format!("SSH connection to {target} failed: {error}"),
            }
        }
    })?;
    tracing::debug!(%target, "embedded SSH: transport established");
    Ok(handle)
}

async fn connect_transport(
    config: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
    on_data: Option<SharedDataCallback>,
    forwarded_tcpip: Option<mpsc::UnboundedSender<ForwardedTcpip>>,
) -> Result<client::Handle<Client>> {
    let target = display_target(config);
    tracing::debug!(%target, port = config.port, "embedded SSH: opening transport");
    let socket = connect_tcp_stream(config, timeouts.connect).await?;
    connect_stream_transport(config, timeouts, socket, on_data, forwarded_tcpip).await
}

async fn connect_through_proxy(
    handle: &client::Handle<Client>,
    next: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
    on_data: Option<SharedDataCallback>,
    forwarded_tcpip: Option<mpsc::UnboundedSender<ForwardedTcpip>>,
) -> Result<client::Handle<Client>> {
    let stream = open_proxy_stream(handle, next, timeouts.connect).await?;
    connect_stream_transport(next, timeouts, stream, on_data, forwarded_tcpip).await
}

pub(crate) async fn authenticated_handle(
    config: &SshConnectionConfig,
) -> Result<AuthenticatedConnection> {
    authenticated_handle_with_options(config, EmbeddedSshTimeouts::default(), None).await
}

pub(crate) async fn authenticated_handle_with_forwarding(
    config: &SshConnectionConfig,
    forwarded_tcpip: mpsc::UnboundedSender<ForwardedTcpip>,
) -> Result<AuthenticatedConnection> {
    authenticated_handle_with_options(
        config,
        EmbeddedSshTimeouts::default(),
        Some(forwarded_tcpip),
    )
    .await
}

#[cfg(test)]
async fn authenticated_handle_with_timeouts(
    config: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
) -> Result<AuthenticatedConnection> {
    authenticated_handle_with_options(config, timeouts, None).await
}

async fn authenticated_handle_with_options(
    config: &SshConnectionConfig,
    timeouts: EmbeddedSshTimeouts,
    forwarded_tcpip: Option<mpsc::UnboundedSender<ForwardedTcpip>>,
) -> Result<AuthenticatedConnection> {
    let route = route_configs(config);
    let first = route
        .first()
        .ok_or_else(|| LumaError::InvalidInput("SSH route is empty".into()))?;
    let first_forwarding = (route.len() == 1)
        .then(|| forwarded_tcpip.as_ref().cloned())
        .flatten();
    let mut handle = connect_transport(first, timeouts, None, first_forwarding).await?;
    let mut predecessors = Vec::with_capacity(route.len().saturating_sub(1));
    for (index, node) in route.iter().enumerate() {
        authenticate_without_prompts(&mut handle, node, timeouts).await?;
        if let Some(next) = route.get(index + 1) {
            let next_forwarding = (index + 2 == route.len())
                .then(|| forwarded_tcpip.as_ref().cloned())
                .flatten();
            let next_handle =
                connect_through_proxy(&handle, next, timeouts, None, next_forwarding).await?;
            predecessors.push(handle);
            handle = next_handle;
        }
    }
    tracing::debug!(host = %config.hostname, "embedded SSH: authentication chain succeeded");
    Ok(AuthenticatedConnection::new(handle, predecessors, route))
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    const TEST_USERNAME: &str = "luma-test";
    const TEST_INTERACTIVE_USERNAME: &str = "luma-interactive";
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
        forwards: Arc<tokio::sync::Mutex<HashMap<ChannelId, tokio::net::tcp::OwnedWriteHalf>>>,
    }

    impl server::Handler for TestServerHandler {
        type Error = russh::Error;

        async fn authentication_banner(
            &mut self,
        ) -> std::result::Result<Option<String>, Self::Error> {
            Ok(Some("Authorized test users only\r\n".into()))
        }

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

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            user: &str,
            _submethods: &str,
            response: Option<server::Response<'a>>,
        ) -> std::result::Result<server::Auth, Self::Error> {
            if user != TEST_INTERACTIVE_USERNAME {
                return Ok(server::Auth::reject());
            }
            let Some(mut response) = response else {
                return Ok(server::Auth::Partial {
                    name: std::borrow::Cow::Borrowed("Test challenge"),
                    instructions: std::borrow::Cow::Borrowed("Enter the interactive secret"),
                    prompts: std::borrow::Cow::Borrowed(&[(
                        std::borrow::Cow::Borrowed("Verification code:"),
                        false,
                    )]),
                });
            };
            Ok(
                if response.next().as_deref() == Some(TEST_PASSWORD.as_bytes()) {
                    server::Auth::Accept
                } else {
                    server::Auth::reject()
                },
            )
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

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: Channel<Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _originator_address: &str,
            _originator_port: u32,
            reply: server::ChannelOpenHandle,
            session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            match tokio::net::TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
                Ok(socket) => {
                    let channel_id = channel.id();
                    let (mut socket_reader, socket_writer) = socket.into_split();
                    self.forwards.lock().await.insert(channel_id, socket_writer);
                    let handle = session.handle();
                    reply.accept().await;
                    tokio::spawn(async move {
                        let mut buffer = [0_u8; 16 * 1024];
                        loop {
                            match socket_reader.read(&mut buffer).await {
                                Ok(0) | Err(_) => {
                                    let _ = handle.eof(channel_id).await;
                                    let _ = handle.close(channel_id).await;
                                    break;
                                }
                                Ok(read) => {
                                    if handle
                                        .data(channel_id, buffer[..read].to_vec())
                                        .await
                                        .is_err()
                                    {
                                        break;
                                    }
                                }
                            }
                        }
                    });
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
            Ok(())
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
            let mut forwards = self.forwards.lock().await;
            if let Some(writer) = forwards.get_mut(&channel) {
                writer.write_all(data).await?;
                return Ok(());
            }
            drop(forwards);
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
            channel: ChannelId,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            if let Some(mut writer) = self.forwards.lock().await.remove(&channel) {
                let _ = writer.shutdown().await;
            } else {
                self.events.lock().unwrap().push(ServerEvent::Eof);
            }
            Ok(())
        }

        async fn channel_close(
            &mut self,
            channel: ChannelId,
            _session: &mut Session,
        ) -> std::result::Result<(), Self::Error> {
            self.forwards.lock().await.remove(&channel);
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
                forwards: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
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
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        writeln!(
            file,
            "[{}]:{} {algorithm} {key_data}",
            address.ip(),
            address.port()
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
            hostname: address.ip().to_string(),
            port: address.port(),
            known_hosts_file,
            username: Some(TEST_USERNAME.into()),
            authentication_type: "password".into(),
            identity_file: None,
            proxy_jumps: Vec::new(),
            startup_command: None,
            password: Some(Arc::new(zeroize::Zeroizing::new(TEST_PASSWORD.into()))),
            key_passphrase: None,
            fallback_password: None,
            _ephemeral_identity_file: None,
        }
    }

    async fn disconnect_handle(handle: &client::Handle<Client>) {
        handle
            .disconnect(Disconnect::ByApplication, "test complete", "")
            .await
            .unwrap();
    }

    fn expect_connect_error(result: Result<AuthenticatedConnection>) -> LumaError {
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
    async fn two_hop_chain_retains_predecessor_transport_for_final_session() {
        let files = TestFiles::new();
        let target =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let jump =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, jump.address, &jump.host_key);
        write_known_host(&known_hosts, target.address, &target.host_key);
        let mut config = test_config(target.address, known_hosts.clone());
        let jump_config = test_config(jump.address, known_hosts);
        config.proxy_jumps.push(jump_config);

        let connection = authenticated_handle(&config).await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let channel = connection.channel_open_session().await.unwrap();
        channel.request_shell(true).await.unwrap();
        wait_for_event(&target.events, ServerEvent::ShellRequested).await;
        disconnect_handle(&connection).await;

        jump.stop().await;
        target.stop().await;
    }

    #[tokio::test]
    async fn proxy_preflight_returns_first_unknown_then_target_after_trust() {
        let files = TestFiles::new();
        let target =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let jump =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let known_hosts = files.path("known_hosts");
        std::fs::write(&known_hosts, "").unwrap();
        let mut config = test_config(target.address, known_hosts.clone());
        config
            .proxy_jumps
            .push(test_config(jump.address, known_hosts.clone()));
        let host_id = format!("chain-{}", uuid::Uuid::new_v4());
        let host = crate::storage::hosts::Host {
            id: host_id.clone(),
            vault_id: crate::storage::vaults::default_id(),
            name: "Chain target".into(),
            hostname: config.hostname.clone(),
            port: config.port,
            username: config.username.clone(),
            group_id: None,
            authentication_type: "password".into(),
            key_id: None,
            identity_id: None,
            proxy_jump_host_id: Some("jump".into()),
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: Vec::new(),
            favorite: false,
            tab_color: None,
            os_id: None,
            os_pretty_name: None,
            is_ephemeral: false,
        };

        let jump_status = crate::ssh::known_hosts::status(&host_id, &config, &known_hosts)
            .await
            .unwrap();
        assert_eq!(
            jump_status.status,
            crate::ssh::known_hosts::HostKeyStatusKind::Unknown
        );
        crate::ssh::known_hosts::trust(&host_id, &host, &known_hosts).unwrap();

        let target_status = crate::ssh::known_hosts::status(&host_id, &config, &known_hosts)
            .await
            .unwrap();
        assert_eq!(
            target_status.status,
            crate::ssh::known_hosts::HostKeyStatusKind::Unknown
        );
        assert_ne!(jump_status.scanned_keys, target_status.scanned_keys);
        crate::ssh::known_hosts::trust(&host_id, &host, &known_hosts).unwrap();

        let known = crate::ssh::known_hosts::status(&host_id, &config, &known_hosts)
            .await
            .unwrap();
        assert_eq!(
            known.status,
            crate::ssh::known_hosts::HostKeyStatusKind::Known
        );

        jump.stop().await;
        target.stop().await;
    }

    #[tokio::test]
    async fn proxy_preflight_requires_saved_credentials_for_known_prefix() {
        let files = TestFiles::new();
        let target =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let jump =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, jump.address, &jump.host_key);
        let mut jump_config = test_config(jump.address, known_hosts.clone());
        jump_config.password = None;
        jump_config.authentication_type = "password".into();
        let mut config = test_config(target.address, known_hosts.clone());
        config.proxy_jumps.push(jump_config);

        let error = crate::ssh::known_hosts::status(
            &format!("chain-auth-{}", uuid::Uuid::new_v4()),
            &config,
            &known_hosts,
        )
        .await
        .unwrap_err();
        assert_eq!(error.category(), "host-key-scan-requires-auth");
        assert!(error.to_string().contains("Saved credentials"));

        jump.stop().await;
        target.stop().await;
    }

    #[tokio::test]
    async fn changed_target_key_in_proxy_chain_identifies_target() {
        let files = TestFiles::new();
        let target =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let jump =
            TestSshServer::start(0, as_russh_private_key(&generate_ed25519_key()), None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, jump.address, &jump.host_key);
        let wrong_target_key = as_russh_private_key(&generate_ed25519_key());
        write_known_host(&known_hosts, target.address, &wrong_target_key);
        let mut config = test_config(target.address, known_hosts.clone());
        config
            .proxy_jumps
            .push(test_config(jump.address, known_hosts));

        let error = expect_connect_error(authenticated_handle(&config).await);
        assert_eq!(error.category(), "host-key-changed");
        assert!(error.to_string().contains(&config.hostname));

        jump.stop().await;
        target.stop().await;
    }

    #[tokio::test]
    async fn typed_password_uses_session_write_channel_during_async_authentication() {
        let files = TestFiles::new();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server = TestSshServer::start(0, host_key, None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);
        let mut config = test_config(server.address, known_hosts);
        config.password = None;
        config.authentication_type = "password".into();
        let manager = EmbeddedSshManager::default();
        let (data_tx, mut data_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();

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
                Box::new(|_| {}),
            )
            .await
            .unwrap();

        let prompt = wait_for_output(&mut data_rx, b"__LUMA_SSH_PROMPT__").await;
        assert!(String::from_utf8_lossy(&prompt).contains("\"target\":\"luma-test@"));
        let ping_error = manager.ping(&session_id).await.unwrap_err();
        assert_eq!(ping_error.category(), "ssh-error");
        assert!(manager.write(&session_id, "correct horse ".into()).unwrap());
        assert!(manager
            .write(&session_id, "battery staple\r\n".into())
            .unwrap());
        wait_for_output(&mut data_rx, SSH_AUTHENTICATED_MARKER).await;
        assert!(manager.disconnect(&session_id).unwrap());
        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit.error_category, None);

        server.stop().await;
    }

    #[tokio::test]
    async fn typed_password_failure_is_reported_through_async_exit() {
        let files = TestFiles::new();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server = TestSshServer::start(0, host_key, None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);
        let mut config = test_config(server.address, known_hosts);
        config.password = None;
        config.authentication_type = "password".into();
        let manager = EmbeddedSshManager::default();
        let (data_tx, mut data_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();

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
                Box::new(|_| {}),
            )
            .await
            .unwrap();

        wait_for_output(&mut data_rx, b"__LUMA_SSH_PROMPT__").await;
        for _ in 0..3 {
            assert!(manager.write(&session_id, "wrong\n".into()).unwrap());
        }
        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit.error_category.as_deref(), Some("auth-failed"));
        assert!(!manager.contains(&session_id));

        server.stop().await;
    }

    #[tokio::test]
    async fn keyboard_interactive_forwards_instructions_and_prompts_for_answers() {
        let files = TestFiles::new();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server = TestSshServer::start(0, host_key, None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);
        let mut config = test_config(server.address, known_hosts);
        config.username = Some(TEST_INTERACTIVE_USERNAME.into());
        config.authentication_type = "interactive".into();
        config.password = None;
        let manager = EmbeddedSshManager::default();
        let (data_tx, mut data_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();

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
                Box::new(|_| {}),
            )
            .await
            .unwrap();

        let output = wait_for_output(&mut data_rx, b"__LUMA_SSH_PROMPT__").await;
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("Authorized test users only"));
        assert!(output.contains("Test challenge"));
        assert!(output.contains("Enter the interactive secret"));
        assert!(output.contains("\"secret\":true"));
        assert!(output.contains("\"target\":\"luma-interactive@"));
        assert!(manager
            .write(&session_id, format!("{TEST_PASSWORD}\n"))
            .unwrap());
        wait_for_output(&mut data_rx, SSH_AUTHENTICATED_MARKER).await;
        assert!(manager.disconnect(&session_id).unwrap());
        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit.error_category, None);

        server.stop().await;
    }

    #[tokio::test]
    async fn rejected_public_key_falls_back_to_typed_password() {
        let files = TestFiles::new();
        let client_key = generate_ed25519_key();
        let client_key_path = files.path("id_ed25519_rejected");
        write_private_key(&client_key_path, &client_key);
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server = TestSshServer::start(0, host_key, None).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);
        let mut config = test_config(server.address, known_hosts);
        config.password = None;
        config.identity_file = Some(client_key_path.to_string_lossy().into_owned());
        config.authentication_type = "key".into();
        let manager = EmbeddedSshManager::default();
        let (data_tx, mut data_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();

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
                Box::new(|_| {}),
            )
            .await
            .unwrap();

        let output = wait_for_output(&mut data_rx, b"__LUMA_SSH_PROMPT__").await;
        assert!(String::from_utf8_lossy(&output).contains("\"target\":\"luma-test@"));
        assert!(manager
            .write(&session_id, format!("{TEST_PASSWORD}\n"))
            .unwrap());
        wait_for_output(&mut data_rx, SSH_AUTHENTICATED_MARKER).await;
        assert!(manager.disconnect(&session_id).unwrap());
        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit.error_category, None);

        server.stop().await;
    }

    #[tokio::test]
    async fn typed_key_passphrase_retries_key_loading_through_session_write() {
        let files = TestFiles::new();
        let client_key = generate_ed25519_key();
        let client_public_key = client_key.public_key().to_openssh().unwrap();
        let host_key = as_russh_private_key(&generate_ed25519_key());
        let server =
            TestSshServer::start(0, host_key, Some(public_key_identity(&client_public_key))).await;
        let known_hosts = files.path("known_hosts");
        write_known_host(&known_hosts, server.address, &server.host_key);
        let passphrase = "typed key passphrase";
        let encrypted_key = client_key.encrypt(&mut OsRng, passphrase).unwrap();
        let encrypted_key_path = files.path("id_ed25519_encrypted_typed");
        write_private_key(&encrypted_key_path, &encrypted_key);
        let mut config = test_config(server.address, known_hosts);
        config.password = None;
        config.identity_file = Some(encrypted_key_path.to_string_lossy().into_owned());
        config.authentication_type = "key".into();
        let manager = EmbeddedSshManager::default();
        let (data_tx, mut data_rx) = mpsc::unbounded_channel();
        let (exit_tx, exit_rx) = oneshot::channel();

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
                Box::new(|_| {}),
            )
            .await
            .unwrap();

        let output = wait_for_output(&mut data_rx, b"__LUMA_SSH_PROMPT__").await;
        let output = String::from_utf8_lossy(&output);
        assert!(output.contains("\"target\":\"luma-test@"));
        assert!(output.contains("Enter passphrase for key"));
        assert!(manager.write(&session_id, "typed key ".into()).unwrap());
        assert!(manager.write(&session_id, "passphrase\r".into()).unwrap());
        wait_for_output(&mut data_rx, SSH_AUTHENTICATED_MARKER).await;
        assert!(manager.disconnect(&session_id).unwrap());
        let exit = tokio::time::timeout(Duration::from_secs(2), exit_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(exit.error_category, None);

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
        plain_config.authentication_type = "key".into();
        let handle = authenticated_handle(&plain_config).await.unwrap();
        disconnect_handle(&handle).await;

        let passphrase = "test encrypted key passphrase";
        let encrypted_key = client_key.encrypt(&mut OsRng, passphrase).unwrap();
        let encrypted_key_path = files.path("id_ed25519_encrypted");
        write_private_key(&encrypted_key_path, &encrypted_key);

        let mut wrong_passphrase = test_config(server.address, known_hosts.clone());
        wrong_passphrase.password = None;
        wrong_passphrase.identity_file = Some(encrypted_key_path.to_string_lossy().into_owned());
        wrong_passphrase.authentication_type = "key".into();
        wrong_passphrase.key_passphrase = Some(Arc::new(zeroize::Zeroizing::new("wrong".into())));
        let error = expect_connect_error(authenticated_handle(&wrong_passphrase).await);
        assert_eq!(error.category(), "key-passphrase-invalid");

        let mut correct_passphrase = test_config(server.address, known_hosts);
        correct_passphrase.password = None;
        correct_passphrase.identity_file = Some(encrypted_key_path.to_string_lossy().into_owned());
        correct_passphrase.authentication_type = "key".into();
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
}
