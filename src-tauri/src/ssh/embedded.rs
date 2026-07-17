use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Pty};
use tokio::sync::mpsc;

use super::{DataCallback, ExitCallback, RemoteOsCallback, SshConnectionConfig, SshExit};
use crate::errors::{LumaError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SshBackend {
    Embedded,
    OpenSsh,
}

pub(crate) fn select_backend(config: &SshConnectionConfig) -> SshBackend {
    if config.proxy_jumps.is_empty()
        && config.username.is_some()
        && config.identity_file.is_none()
        && config.askpass_identity_id.is_some()
        && config.askpass_prompt.as_deref() == Some("password")
    {
        SshBackend::Embedded
    } else {
        SshBackend::OpenSsh
    }
}

enum Control {
    Write(Vec<u8>),
    Resize(u16, u16),
    Disconnect,
}

#[derive(Default)]
pub struct EmbeddedSshManager {
    sessions: Arc<Mutex<HashMap<String, mpsc::Sender<Control>>>>,
}

#[derive(Clone)]
pub(crate) struct Client {
    trusted_keys: Arc<Vec<PublicKey>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(self.trusted_keys.iter().any(|trusted| trusted == key))
    }
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
        let handle = authenticated_handle(&config).await?;

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

        let (control_tx, mut control_rx) = mpsc::channel(128);
        let id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(id.clone(), control_tx);
        let sessions = Arc::clone(&self.sessions);
        let task_id = id.clone();
        let _identity = config.ephemeral_identity_file.clone();
        let _credential = config.ephemeral_credential.clone();
        on_remote_os(remote_os);

        tauri::async_runtime::spawn(async move {
            let _handle = handle;
            let _identity = _identity;
            let _credential = _credential;
            let mut exit_code = None;
            let mut failure = None;
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
                        Some(Control::Disconnect) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            break;
                        }
                    },
                    message = channel.wait() => match message {
                        Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => on_data(&data),
                        Some(ChannelMsg::ExitStatus { exit_status }) => exit_code = Some(exit_status),
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
            }
            sessions.lock().unwrap().remove(&task_id);
            on_exit(SshExit {
                code: exit_code,
                error_category: failure.as_ref().map(|_| "ssh-error".into()),
                error_message: failure,
            });
        });
        Ok(id)
    }

    pub async fn write(&self, session_id: &str, data: String) -> Result<bool> {
        self.send(session_id, Control::Write(data.into_bytes()))
            .await
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<bool> {
        self.send(session_id, Control::Resize(cols, rows)).await
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<bool> {
        self.send(session_id, Control::Disconnect).await
    }

    async fn send(&self, session_id: &str, control: Control) -> Result<bool> {
        let sender = self.sessions.lock().unwrap().get(session_id).cloned();
        let Some(sender) = sender else {
            return Ok(false);
        };
        sender
            .send(control)
            .await
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
            let _ = sender.try_send(Control::Disconnect);
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
            category: "host-key",
            message: "No trusted host key was found for this server".into(),
        });
    }
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
            Client { trusted_keys },
        ),
    )
    .await
    .map_err(|_| LumaError::SshConnection {
        category: "timeout",
        message: "Embedded SSH transport timed out".into(),
    })?
    .map_err(connect_error)?;
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
        tokio::time::timeout(
            Duration::from_secs(15),
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash)),
        )
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "SSH key authentication timed out".into(),
        })?
        .map_err(connect_error)?
        .success()
    } else {
        let password =
            credential_secret(config, "password")?.ok_or_else(|| LumaError::SshConnection {
                category: "authentication",
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
            category: "authentication",
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

fn connect_error(error: russh::Error) -> LumaError {
    if matches!(
        error,
        russh::Error::UnknownKey | russh::Error::WrongServerSig
    ) {
        return LumaError::SshConnection {
            category: "host-key-rejected",
            message: "The SSH server key did not match the trusted host key".into(),
        };
    }
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("embedded SSH connection failed: {error}"),
    }
}

async fn detect_remote_os(handle: &client::Handle<Client>) -> super::SshRemoteOs {
    let operation = async {
        let mut channel = handle.channel_open_session().await.ok()?;
        channel.exec(true, b"cat /etc/os-release").await.ok()?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } if output.len() + data.len() <= 64 * 1024 => {
                    output.extend_from_slice(&data);
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Some(super::remote_os::parse_os_release(
            &String::from_utf8_lossy(&output),
        ))
    };
    tokio::time::timeout(Duration::from_secs(3), operation)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(super::SshRemoteOs::unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
    fn falls_back_for_private_key_hosts_until_key_auth_is_compatible() {
        assert_eq!(select_backend(&config()), SshBackend::OpenSsh);
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
