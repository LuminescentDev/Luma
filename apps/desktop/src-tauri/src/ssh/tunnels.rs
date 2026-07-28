use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sqlx::SqlitePool;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};

use super::{
    authenticated_handle, authenticated_handle_with_forwarding, connection_config,
    AuthenticatedConnection, ForwardedTcpip, SshConnectionConfig,
};
use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::storage::port_forwards::PortForward;

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
    stop: watch::Sender<bool>,
    task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
pub struct TunnelManager {
    tunnels: Arc<Mutex<HashMap<String, ActiveTunnel>>>,
}

impl TunnelManager {
    pub async fn start(
        &self,
        config: SshConnectionConfig,
        port_forward: PortForward,
        on_exit: impl FnOnce(TunnelExit) + Send + 'static,
    ) -> Result<String> {
        let tunnel_id = uuid::Uuid::new_v4().to_string();
        let (stop, stop_rx) = watch::channel(false);
        {
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
                    stop,
                    task: None,
                },
            );
        }

        let setup = self.setup(config, &port_forward).await;
        let (connection, worker) = match setup {
            Ok(value) => value,
            Err(error) => {
                self.tunnels.lock().unwrap().remove(&tunnel_id);
                return Err(error);
            }
        };

        let tunnels = Arc::clone(&self.tunnels);
        let task_id = tunnel_id.clone();
        let task = tokio::spawn(async move {
            let exit = run_tunnel(connection, worker, stop_rx).await;
            tunnels.lock().unwrap().remove(&task_id);
            on_exit(exit);
        });
        if let Some(tunnel) = self.tunnels.lock().unwrap().get_mut(&tunnel_id) {
            tunnel.task = Some(task);
        }
        Ok(tunnel_id)
    }

    async fn setup(
        &self,
        config: SshConnectionConfig,
        port_forward: &PortForward,
    ) -> Result<(AuthenticatedConnection, TunnelWorker)> {
        match port_forward.forward_type.as_str() {
            "local" => {
                let listener = bind_listener(port_forward, "localPort").await?;
                let destination = destination(port_forward)?;
                let connection = authenticated_handle(&config).await?;
                Ok((
                    connection,
                    TunnelWorker::Local {
                        listener,
                        destination,
                    },
                ))
            }
            "dynamic" => {
                let listener = bind_listener(port_forward, "localPort").await?;
                let connection = authenticated_handle(&config).await?;
                Ok((connection, TunnelWorker::Dynamic { listener }))
            }
            "remote" => {
                let destination = destination(port_forward)?;
                let remote_port = port_forward
                    .remote_port
                    .ok_or_else(|| LumaError::InvalidInput("remotePort is required".into()))?;
                let (forwarded_tx, forwarded_rx) = mpsc::unbounded_channel();
                let connection =
                    authenticated_handle_with_forwarding(&config, forwarded_tx).await?;
                tokio::time::timeout(
                    Duration::from_secs(15),
                    connection
                        .tcpip_forward(port_forward.bind_address.clone(), u32::from(remote_port)),
                )
                .await
                .map_err(|_| LumaError::SshConnection {
                    category: "timeout",
                    message: "Remote forwarding request timed out".into(),
                })?
                .map_err(|error| LumaError::SshConnection {
                    category: "ssh-error",
                    message: format!("Remote forwarding request was denied: {error}"),
                })?;
                Ok((
                    connection,
                    TunnelWorker::Remote {
                        forwarded_rx,
                        bind_address: port_forward.bind_address.clone(),
                        remote_port,
                        destination,
                    },
                ))
            }
            _ => Err(LumaError::InvalidInput(
                "type must be 'local', 'remote', or 'dynamic'".into(),
            )),
        }
    }

    pub async fn stop(&self, tunnel_id: &str) -> Result<()> {
        let mut tunnel = self
            .tunnels
            .lock()
            .unwrap()
            .remove(tunnel_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown tunnel".into()))?;
        let _ = tunnel.stop.send(true);
        if let Some(task) = tunnel.task.take() {
            let _ = tokio::time::timeout(Duration::from_secs(3), task).await;
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

    pub fn kill_all(&self) {
        for (_, tunnel) in self.tunnels.lock().unwrap().drain() {
            let _ = tunnel.stop.send(true);
        }
    }
}

enum TunnelWorker {
    Local {
        listener: TcpListener,
        destination: (String, u16),
    },
    Dynamic {
        listener: TcpListener,
    },
    Remote {
        forwarded_rx: mpsc::UnboundedReceiver<ForwardedTcpip>,
        bind_address: String,
        remote_port: u16,
        destination: (String, u16),
    },
}

async fn run_tunnel(
    connection: AuthenticatedConnection,
    worker: TunnelWorker,
    mut stop: watch::Receiver<bool>,
) -> TunnelExit {
    let handle = Arc::clone(connection.handle());
    let result = match worker {
        TunnelWorker::Local {
            listener,
            destination,
        } => run_listener(listener, handle, Some(destination), &mut stop).await,
        TunnelWorker::Dynamic { listener } => run_listener(listener, handle, None, &mut stop).await,
        TunnelWorker::Remote {
            forwarded_rx,
            bind_address,
            remote_port,
            destination,
        } => {
            let result = run_remote(forwarded_rx, destination, &mut stop).await;
            let _ = connection
                .cancel_tcpip_forward(bind_address, u32::from(remote_port))
                .await;
            result
        }
    };
    match result {
        Ok(()) => TunnelExit {
            code: None,
            error_category: None,
            error_message: None,
        },
        Err(error) => TunnelExit {
            code: None,
            error_category: Some(error.category().into()),
            error_message: Some(error.to_string()),
        },
    }
}

async fn run_listener(
    listener: TcpListener,
    handle: Arc<russh::client::Handle<super::embedded::Client>>,
    destination: Option<(String, u16)>,
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Ok(());
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = accepted.map_err(|error| LumaError::SshConnection {
                    category: "connection-lost",
                    message: format!("Tunnel listener failed: {error}"),
                })?;
                let handle = Arc::clone(&handle);
                let destination = destination.clone();
                tokio::spawn(async move {
                    let result = if let Some((host, port)) = destination {
                        forward_local(stream, handle, host, port, peer).await
                    } else {
                        super::socks5::serve(stream, handle).await
                    };
                    if let Err(error) = result {
                        tracing::debug!(category = error.category(), "forwarded connection closed");
                    }
                });
            }
            _ = tokio::time::sleep(Duration::from_secs(1)) => {
                if handle.is_closed() {
                    return Err(LumaError::SshConnection {
                        category: "connection-lost",
                        message: "The SSH tunnel transport closed unexpectedly".into(),
                    });
                }
            }
        }
    }
}

async fn forward_local(
    mut stream: TcpStream,
    handle: Arc<russh::client::Handle<super::embedded::Client>>,
    host: String,
    port: u16,
    peer: std::net::SocketAddr,
) -> Result<()> {
    let channel = handle
        .channel_open_direct_tcpip(
            host,
            u32::from(port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await
        .map_err(super::embedded::connect_error)?;
    let mut channel = channel.into_stream();
    tokio::io::copy_bidirectional(&mut stream, &mut channel).await?;
    Ok(())
}

async fn run_remote(
    mut forwarded_rx: mpsc::UnboundedReceiver<ForwardedTcpip>,
    destination: (String, u16),
    stop: &mut watch::Receiver<bool>,
) -> Result<()> {
    loop {
        tokio::select! {
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    return Ok(());
                }
            }
            forwarded = forwarded_rx.recv() => {
                let Some(forwarded) = forwarded else {
                    return Err(LumaError::SshConnection {
                        category: "connection-lost",
                        message: "The SSH remote-forward transport closed unexpectedly".into(),
                    });
                };
                let destination = destination.clone();
                tokio::spawn(async move {
                    match TcpStream::connect((&destination.0[..], destination.1)).await {
                        Ok(mut stream) => {
                            forwarded.reply.accept().await;
                            let mut channel = forwarded.channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut stream, &mut channel).await;
                        }
                        Err(_) => {
                            forwarded.reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
                        }
                    }
                });
            }
        }
    }
}

async fn bind_listener(port_forward: &PortForward, field: &str) -> Result<TcpListener> {
    let port = port_forward
        .local_port
        .ok_or_else(|| LumaError::InvalidInput(format!("{field} is required")))?;
    TcpListener::bind((port_forward.bind_address.as_str(), port))
        .await
        .map_err(|error| LumaError::SshConnection {
            category: "host-unreachable",
            message: format!(
                "Could not bind tunnel listener on {}:{port}: {error}",
                port_forward.bind_address
            ),
        })
}

fn destination(port_forward: &PortForward) -> Result<(String, u16)> {
    Ok((
        port_forward
            .destination_host
            .clone()
            .ok_or_else(|| LumaError::InvalidInput("destinationHost is required".into()))?,
        port_forward
            .destination_port
            .ok_or_else(|| LumaError::InvalidInput("destinationPort is required".into()))?,
    ))
}

pub async fn tunnel_connection_config(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    host_id: &str,
) -> Result<SshConnectionConfig> {
    let (mut config, _) = connection_config(pool, keystore_state, host_id).await?;
    for node in config.proxy_jumps.iter().chain(std::iter::once(&config)) {
        let is_key = node.authentication_type == "key";
        let password_auth = node.authentication_type == "password";
        if node.authentication_type == "interactive"
            || (password_auth && node.password.is_none())
            || (is_key && node.identity_file.is_none())
        {
            return Err(LumaError::InvalidInput(format!(
                "tunnel authentication for {} requires an interactive prompt",
                node.username
                    .as_deref()
                    .map(|user| format!("{user}@{}", node.hostname))
                    .unwrap_or_else(|| node.hostname.clone())
            )));
        }
    }
    config.startup_command = None;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port_forward(forward_type: &str, port: u16) -> PortForward {
        PortForward {
            id: format!("{forward_type}-id"),
            host_id: "host-id".into(),
            name: "Forward".into(),
            forward_type: forward_type.into(),
            bind_address: "127.0.0.1".into(),
            local_port: (forward_type != "remote").then_some(port),
            destination_host: (forward_type != "dynamic").then(|| "127.0.0.1".into()),
            destination_port: (forward_type != "dynamic").then_some(5432),
            remote_port: (forward_type == "remote").then_some(port),
        }
    }

    #[tokio::test]
    async fn bind_conflict_is_reported_before_ssh_connect() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let error = bind_listener(&port_forward("local", port), "localPort")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("Could not bind tunnel listener"));
    }

    #[test]
    fn tunnel_manager_tracks_reservations() {
        let manager = TunnelManager::default();
        let (stop, _) = watch::channel(false);
        manager.tunnels.lock().unwrap().insert(
            "one".into(),
            ActiveTunnel {
                tunnel_id: "one".into(),
                port_forward_id: "forward-one".into(),
                host_id: "host".into(),
                stop,
                task: None,
            },
        );
        assert_eq!(manager.list().len(), 1);
        assert_eq!(manager.list()[0].status, "running");
    }
}
