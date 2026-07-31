#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod config;
mod embedded;
mod embedded_auth;
mod known_hosts;
mod remote_os;
// Tunnels (and the SOCKS proxy that backs dynamic forwards) are plain tokio
// over the russh session, so they build and run on mobile too.
mod socks5;
mod tunnels;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use sqlx::SqlitePool;
use zeroize::Zeroizing;

use crate::errors::{LumaError, Result};
use crate::keystore::{self, KeystoreState};
use crate::platform::home_dir;
use crate::storage::host_inheritance;
use crate::storage::hosts::{self, Host};
use crate::storage::identities;
use crate::storage::key_references;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub use config::{
    import_config, preview_config, SshConfigCandidate, SshConfigImportRequest,
    SshConfigImportResult,
};
pub use embedded::EmbeddedSshManager;
pub(crate) use embedded::{
    authenticated_handle, authenticated_handle_with_forwarding,
    connect_error as embedded_connect_error, AuthenticatedConnection, ForwardedTcpip,
};
pub use known_hosts::{
    file_path as known_hosts_file_path, list as known_hosts_list, remove as known_hosts_remove,
    status as host_key_status, trust as trust_host_key, validate_host_id, KnownHostsEntry,
    SshHostKeyStatus,
};
pub use remote_os::SshRemoteOs;
pub use tunnels::{
    tunnel_connection_config, TunnelExit, TunnelInfo, TunnelManager, TunnelStartResponse,
};

pub(crate) const SSH_AUTHENTICATED_MARKER: &[u8] = b"__LUMA_SSH_AUTHENTICATED__";
const MAX_PROXY_JUMP_DEPTH: usize = 8;

type DataCallback = Box<dyn FnMut(&[u8]) + Send + 'static>;
type ExitCallback = Box<dyn FnOnce(SshExit) + Send + 'static>;
type RemoteOsCallback = Box<dyn FnOnce(SshRemoteOs) + Send + 'static>;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshExit {
    pub code: Option<u32>,
    pub error_category: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Clone)]
pub(crate) struct SshConnectionConfig {
    pub(crate) hostname: String,
    port: u16,
    known_hosts_file: PathBuf,
    username: Option<String>,
    authentication_type: String,
    identity_file: Option<String>,
    proxy_jumps: Vec<SshConnectionConfig>,
    pub(crate) startup_command: Option<String>,
    password: Option<Arc<Zeroizing<String>>>,
    key_passphrase: Option<Arc<Zeroizing<String>>>,
    fallback_password: Option<Arc<Zeroizing<String>>>,
    _ephemeral_identity_file: Option<Arc<EphemeralIdentityFile>>,
}

impl std::fmt::Debug for SshConnectionConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SshConnectionConfig")
            .field("hostname", &self.hostname)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("has_identity_file", &self.identity_file.is_some())
            .field("proxy_jump_count", &self.proxy_jumps.len())
            .field("has_startup_command", &self.startup_command.is_some())
            .field("has_password", &self.password.is_some())
            .field("has_key_passphrase", &self.key_passphrase.is_some())
            .field("has_fallback_password", &self.fallback_password.is_some())
            .finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct EphemeralIdentityFile(PathBuf);

impl Drop for EphemeralIdentityFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
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
    keystore_state: &KeystoreState,
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
            keystore::load(pool, keystore_state, "key", key_id, "private-key")
                .await?
                .ok_or_else(|| {
                    LumaError::KeyUnavailable("keystore key has no private key".into())
                })?,
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
            LumaError::KeyUnavailable(format!("could not prepare keystore key: {error}"))
        })?;
        let normalized_private_key = Zeroizing::new(normalize_private_key(&private_key));
        let write_result = file.write_all(normalized_private_key.as_bytes());
        if let Err(error) = write_result {
            let _ = std::fs::remove_file(&path);
            return Err(LumaError::KeyUnavailable(format!(
                "could not prepare keystore key: {error}"
            )));
        }
        drop(file);
        let guard = Arc::new(EphemeralIdentityFile(path.clone()));
        return Ok((Some(path.to_string_lossy().into_owned()), Some(guard)));
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
    proxy_jumps: Vec<Host>,
}

/// Every connection runs the host as its group chain resolves it, never the
/// raw row: a field the host leaves unset may be supplied by its group.
pub(crate) async fn effective_host(pool: &SqlitePool, host_id: &str) -> Result<Host> {
    let host = hosts::get(pool, host_id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    Ok(host_inheritance::effective_host(pool, host).await?.host)
}

async fn resolve_connection_route(
    pool: &SqlitePool,
    host_id: &str,
) -> Result<ResolvedConnectionRoute> {
    let host = effective_host(pool, host_id).await?;

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
        // A jump host resolves through its own group chain too, so a bastion
        // inherits the group's identity exactly as a directly opened host does.
        let proxy = hosts::get(pool, &proxy_id)
            .await?
            .ok_or_else(|| LumaError::InvalidInput("proxy jump host no longer exists".into()))?;
        let proxy = host_inheritance::effective_host(pool, proxy).await?.host;
        next = proxy.proxy_jump_host_id.clone();
        proxy_jumps.push(proxy);
    }
    proxy_jumps.reverse();

    Ok(ResolvedConnectionRoute { host, proxy_jumps })
}

fn validate_connection_username(username: String) -> Result<String> {
    const MAX_USERNAME_LENGTH: usize = 128;

    if username.is_empty() || username.len() > MAX_USERNAME_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "username must be 1-{MAX_USERNAME_LENGTH} characters"
        )));
    }
    if username.starts_with('-') {
        return Err(LumaError::InvalidInput(
            "username must not start with '-'".into(),
        ));
    }
    if !username
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return Err(LumaError::InvalidInput(
            "username contains whitespace or unsupported characters".into(),
        ));
    }
    Ok(username)
}

fn resolve_os_username() -> Result<String> {
    let username = ["USERNAME", "USER"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .ok_or_else(|| LumaError::InvalidInput("SSH username is required".into()))?;
    validate_connection_username(username)
}

async fn resolve_host_identity(
    pool: &SqlitePool,
    mut host: Host,
) -> Result<(Host, Option<identities::Identity>)> {
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
    if host.username.is_none() {
        host.username = Some(resolve_os_username()?);
    }
    Ok((host, identity))
}

async fn resolve_host_connection_config(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    host: Host,
    known_hosts_file: PathBuf,
) -> Result<SshConnectionConfig> {
    let (host, identity) = resolve_host_identity(pool, host).await?;
    let password = if let Some(identity) = identity
        .as_ref()
        .filter(|identity| identity.key_id.is_none() && identity.has_password)
    {
        identities::password(pool, keystore_state, &identity.id)
            .await?
            .map(Arc::new)
    } else {
        None
    };
    let fallback_password = if let Some(identity) = identity
        .as_ref()
        .filter(|identity| identity.key_id.is_some() && identity.has_password)
    {
        identities::password(pool, keystore_state, &identity.id)
            .await?
            .map(Arc::new)
    } else {
        None
    };
    let (identity_file, _ephemeral_identity_file) =
        identity_file(pool, keystore_state, &host).await?;
    let mut key_passphrase = None;
    if host.authentication_type == "key" {
        if let Some(key_id) = host.key_id.as_deref() {
            let has_saved_passphrase = sqlx::query_scalar::<_, i64>(
                "SELECT EXISTS(SELECT 1 FROM keystore_secrets WHERE owner_type='key' AND owner_id=?1 AND secret_type='passphrase')",
            )
            .bind(key_id)
            .fetch_one(pool)
            .await?
                != 0;
            if has_saved_passphrase {
                let passphrase = Zeroizing::new(
                    keystore::load(pool, keystore_state, "key", key_id, "passphrase")
                        .await?
                        .unwrap_or_default(),
                );
                if !passphrase.is_empty() {
                    key_passphrase = Some(Arc::new(passphrase));
                }
            }
        }
    }

    Ok(SshConnectionConfig {
        hostname: host.hostname,
        port: host.port,
        known_hosts_file,
        username: host.username,
        authentication_type: host.authentication_type,
        identity_file,
        proxy_jumps: Vec::new(),
        startup_command: host.startup_command,
        password,
        key_passphrase,
        fallback_password,
        _ephemeral_identity_file,
    })
}

pub(crate) async fn host_key_connection_config(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    host_id: &str,
    known_hosts_file: PathBuf,
) -> Result<SshConnectionConfig> {
    let route = resolve_connection_route(pool, host_id).await?;
    let mut proxy_jumps = Vec::with_capacity(route.proxy_jumps.len());
    for proxy in route.proxy_jumps {
        let mut config =
            resolve_host_connection_config(pool, keystore_state, proxy, known_hosts_file.clone())
                .await?;
        config.startup_command = None;
        proxy_jumps.push(config);
    }
    let mut config =
        resolve_host_connection_config(pool, keystore_state, route.host, known_hosts_file).await?;
    config.startup_command = None;
    config.proxy_jumps = proxy_jumps;
    Ok(config)
}

pub async fn connection_config(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    host_id: &str,
) -> Result<(SshConnectionConfig, String)> {
    let route = resolve_connection_route(pool, host_id).await?;
    let title = route.host.name.clone();
    let known_hosts_file = known_hosts::file_path_for_pool(pool).await?;
    let mut proxy_jumps = Vec::with_capacity(route.proxy_jumps.len());
    for proxy in route.proxy_jumps {
        let mut config =
            resolve_host_connection_config(pool, keystore_state, proxy, known_hosts_file.clone())
                .await?;
        config.startup_command = None;
        proxy_jumps.push(config);
    }
    let mut config =
        resolve_host_connection_config(pool, keystore_state, route.host, known_hosts_file).await?;
    config.proxy_jumps = proxy_jumps;
    Ok((config, title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_username_validation_matches_host_rules() {
        assert_eq!(
            validate_connection_username("alice.smith-2".into()).unwrap(),
            "alice.smith-2"
        );
        for invalid in ["", "-root", "alice smith", "alice@example.com"] {
            assert!(validate_connection_username(invalid.into()).is_err());
        }
    }

    #[test]
    fn normalizes_private_keys() {
        assert_eq!(
            normalize_private_key("\u{feff}-----BEGIN KEY-----\r\ndata\r\n-----END KEY-----"),
            "-----BEGIN KEY-----\ndata\n-----END KEY-----\n"
        );
    }
}
