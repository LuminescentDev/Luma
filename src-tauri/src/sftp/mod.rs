mod local;
mod transfer;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use russh_sftp::client::fs::Metadata as RemoteMetadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType as RemoteFileType, OpenFlags};
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::errors::{LumaError, Result};
use crate::ssh::{
    askpass_environment, authenticated_handle, build_sftp_arguments, classify_error_output,
    connection_config, select_backend, EmbeddedClient, SshBackend, CAPTURE_LIMIT_BYTES,
};
use crate::vault::VaultState;

pub use local::{local_delete, local_list, local_mkdir, local_rename};
pub use transfer::{
    sftp_download, sftp_retry, sftp_upload, TransferProgress, TransferStartResponse,
};

const MAX_PATH_BYTES: usize = 32_768;
const MAX_DIRECTORY_ENTRIES: usize = 20_000;
const MAX_DELETE_DEPTH: usize = 64;
const MAX_DELETE_ENTRIES: usize = 100_000;
const MAX_AUTHORIZED_KEYS_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpConnectResponse {
    pub sftp_session_id: String,
    pub initial_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SftpSessionInfo {
    pub sftp_session_id: String,
    pub host_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: Option<u64>,
    pub modified_at: Option<i64>,
    pub permissions: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

struct StoredSession<T> {
    host_id: String,
    value: T,
}

struct SessionStore<T> {
    entries: HashMap<String, StoredSession<T>>,
}

impl<T> Default for SessionStore<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<T> SessionStore<T> {
    fn insert(&mut self, session_id: String, host_id: String, value: T) {
        self.entries
            .insert(session_id, StoredSession { host_id, value });
    }

    fn get(&self, session_id: &str) -> Option<&T> {
        self.entries.get(session_id).map(|stored| &stored.value)
    }

    fn remove(&mut self, session_id: &str) -> Option<T> {
        self.entries.remove(session_id).map(|stored| stored.value)
    }

    fn list(&self) -> Vec<SftpSessionInfo> {
        let mut sessions = self
            .entries
            .iter()
            .map(|(session_id, stored)| SftpSessionInfo {
                sftp_session_id: session_id.clone(),
                host_id: stored.host_id.clone(),
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.sftp_session_id.cmp(&right.sftp_session_id));
        sessions
    }

    fn drain(&mut self) -> Vec<T> {
        self.entries
            .drain()
            .map(|(_, stored)| stored.value)
            .collect()
    }
}

struct ActiveSession {
    client: Arc<SftpSession>,
    child: Mutex<Option<Child>>,
    embedded: Option<russh::client::Handle<EmbeddedClient>>,
    _connection_config: crate::ssh::SshConnectionConfig,
}

pub(super) struct ActiveTransfer {
    pub session_id: String,
    pub cancel: watch::Sender<bool>,
}

#[derive(Default)]
pub struct SftpManager {
    sessions: Arc<Mutex<SessionStore<Arc<ActiveSession>>>>,
    pub(super) transfers: Arc<Mutex<HashMap<String, ActiveTransfer>>>,
    pub(super) transfer_records: Arc<Mutex<HashMap<String, Arc<transfer::TransferRecord>>>>,
}

impl SftpManager {
    pub async fn connect(
        &self,
        pool: &SqlitePool,
        vault_state: &VaultState,
        host_id: &str,
    ) -> Result<SftpConnectResponse> {
        validate_identifier(host_id, "hostId")?;
        let (mut config, _) = connection_config(pool, vault_state, host_id).await?;
        config.startup_command = None;
        if select_backend(&config) == SshBackend::Embedded {
            match connect_embedded_sftp(&config).await {
                Ok((client, embedded, initial_path)) => {
                    let session_id = uuid::Uuid::new_v4().to_string();
                    self.sessions.lock().unwrap().insert(
                        session_id.clone(),
                        host_id.to_string(),
                        Arc::new(ActiveSession {
                            client,
                            child: Mutex::new(None),
                            embedded: Some(embedded),
                            _connection_config: config,
                        }),
                    );
                    tracing::info!(sftp_session_id = %session_id, host_id = %host_id, backend = "russh", "opened SFTP session");
                    return Ok(SftpConnectResponse {
                        sftp_session_id: session_id,
                        initial_path,
                    });
                }
                Err(error) if embedded_fallback_allowed(&error) => {
                    tracing::warn!(host_id = %host_id, reason = %error, "embedded SFTP unavailable; falling back to OpenSSH");
                }
                Err(error) => return Err(error),
            }
        }
        if config.executable.is_empty() {
            return Err(LumaError::SshUnavailable(
                "embedded SFTP failed and system OpenSSH is unavailable".into(),
            ));
        }
        let arguments = build_sftp_arguments(&config);
        let environment = askpass_environment(&config)?;

        let mut command = Command::new(&config.executable);
        crate::platform::hide_background_tokio_command(&mut command);
        command
            .args(&arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in environment {
            command.env(key, value);
        }

        let mut child = command.spawn().map_err(|error| {
            LumaError::SshUnavailable(format!("failed to start system OpenSSH for SFTP: {error}"))
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| LumaError::SftpFailed("OpenSSH stdin was unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| LumaError::SftpFailed("OpenSSH stdout was unavailable".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| LumaError::SftpFailed("OpenSSH stderr was unavailable".into()))?;
        let stderr_task = tokio::spawn(capture_stderr(stderr));

        let stream = tokio::io::join(stdout, stdin);
        let client = match SftpSession::new(stream).await {
            Ok(client) => Arc::new(client),
            Err(error) => {
                let _ = child.kill().await;
                let captured = stderr_task.await.unwrap_or_default();
                return Err(connect_error(&captured, &error.to_string()));
            }
        };

        let initial_path = match client.canonicalize(".").await {
            Ok(path) => path,
            Err(error) => {
                let _ = client.close().await;
                let _ = child.kill().await;
                let captured = stderr_task.await.unwrap_or_default();
                return Err(connect_error(&captured, &error.to_string()));
            }
        };
        validate_remote_path(&initial_path)?;
        drop(stderr_task);

        let session_id = uuid::Uuid::new_v4().to_string();
        self.sessions.lock().unwrap().insert(
            session_id.clone(),
            host_id.to_string(),
            Arc::new(ActiveSession {
                client,
                child: Mutex::new(Some(child)),
                embedded: None,
                _connection_config: config,
            }),
        );
        tracing::info!(sftp_session_id = %session_id, host_id = %host_id, "opened SFTP session");

        Ok(SftpConnectResponse {
            sftp_session_id: session_id,
            initial_path,
        })
    }

    pub async fn disconnect(&self, session_id: &str) -> Result<()> {
        validate_identifier(session_id, "sftpSessionId")?;
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(session_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown SFTP session".into()))?;
        self.cancel_session_transfers(session_id);
        let _ = session.client.close().await;
        if let Some(child) = session.child.lock().unwrap().as_mut() {
            let _ = child.start_kill();
        }
        if let Some(embedded) = &session.embedded {
            let _ = embedded
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "SFTP session closed",
                    "en",
                )
                .await;
        }
        tracing::info!(sftp_session_id = %session_id, "closed SFTP session");
        Ok(())
    }

    pub fn list(&self) -> Vec<SftpSessionInfo> {
        self.sessions.lock().unwrap().list()
    }

    pub(super) fn client(&self, session_id: &str) -> Result<Arc<SftpSession>> {
        validate_identifier(session_id, "sftpSessionId")?;
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .map(|session| Arc::clone(&session.client))
            .ok_or_else(|| LumaError::InvalidInput("unknown SFTP session".into()))
    }

    pub fn cancel_transfer(&self, transfer_id: &str) -> Result<()> {
        validate_identifier(transfer_id, "transferId")?;
        let transfers = self.transfers.lock().unwrap();
        let transfer = transfers
            .get(transfer_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown transfer".into()))?;
        let _ = transfer.cancel.send(true);
        Ok(())
    }

    fn cancel_session_transfers(&self, session_id: &str) {
        let transfers = self.transfers.lock().unwrap();
        for transfer in transfers.values() {
            if transfer.session_id == session_id {
                let _ = transfer.cancel.send(true);
            }
        }
    }

    pub fn kill_all(&self) {
        for (_, transfer) in self.transfers.lock().unwrap().drain() {
            let _ = transfer.cancel.send(true);
        }
        self.transfer_records.lock().unwrap().clear();
        let sessions = self.sessions.lock().unwrap().drain();
        for session in sessions {
            if let Some(child) = session.child.lock().unwrap().as_mut() {
                let _ = child.start_kill();
            }
        }
        tracing::info!("closed all SFTP sessions and cancelled transfers on shutdown");
    }
}

async fn connect_embedded_sftp(
    config: &crate::ssh::SshConnectionConfig,
) -> Result<(
    Arc<SftpSession>,
    russh::client::Handle<EmbeddedClient>,
    String,
)> {
    let handle = authenticated_handle(config).await?;
    let channel = handle.channel_open_session().await.map_err(|error| {
        LumaError::SftpFailed(format!("could not open embedded SSH channel: {error}"))
    })?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| LumaError::SftpFailed(format!("SFTP subsystem failed: {error}")))?;
    let client = Arc::new(
        SftpSession::new(channel.into_stream())
            .await
            .map_err(|error| LumaError::SftpFailed(format!("SFTP handshake failed: {error}")))?,
    );
    let initial_path = client.canonicalize(".").await.map_err(remote_error)?;
    validate_remote_path(&initial_path)?;
    Ok((client, handle, initial_path))
}

fn embedded_fallback_allowed(error: &LumaError) -> bool {
    !matches!(
        error.category(),
        "host-key"
            | "host-key-changed"
            | "host-key-rejected"
            | "authentication"
            | "auth-failed"
            | "key-unavailable"
    )
}

fn authorized_key_blob(line: &[u8]) -> Option<(&str, &str)> {
    let text = std::str::from_utf8(line).ok()?;
    let fields = text.split_whitespace().collect::<Vec<_>>();
    fields.windows(2).find_map(|pair| {
        let algorithm = pair[0];
        let is_key = algorithm.starts_with("ssh-")
            || algorithm.starts_with("ecdsa-")
            || algorithm.starts_with("sk-");
        is_key.then_some((algorithm, pair[1]))
    })
}

fn merge_authorized_keys(existing: &[u8], public_key: &str) -> Result<(Vec<u8>, bool)> {
    if public_key.contains(['\r', '\n', '\0']) {
        return Err(LumaError::InvalidInput(
            "public key contains an invalid control character".into(),
        ));
    }
    let target = authorized_key_blob(public_key.as_bytes())
        .ok_or_else(|| LumaError::InvalidInput("stored public key is invalid".into()))?;
    if existing
        .split(|byte| *byte == b'\n')
        .filter_map(authorized_key_blob)
        .any(|candidate| candidate == target)
    {
        return Ok((existing.to_vec(), false));
    }

    let mut updated = Vec::with_capacity(existing.len() + public_key.len() + 2);
    updated.extend_from_slice(existing);
    if !updated.is_empty() && !updated.ends_with(b"\n") {
        updated.push(b'\n');
    }
    updated.extend_from_slice(public_key.as_bytes());
    updated.push(b'\n');
    Ok((updated, true))
}

pub async fn install_authorized_key(
    manager: &SftpManager,
    session_id: &str,
    home: &str,
    public_key: &str,
) -> Result<bool> {
    let client = manager.client(session_id)?;
    let ssh_directory = join_remote_path(home, ".ssh");
    if client
        .try_exists(ssh_directory.clone())
        .await
        .map_err(remote_error)?
    {
        let metadata = client
            .metadata(ssh_directory.clone())
            .await
            .map_err(remote_error)?;
        if !metadata.is_dir() {
            return Err(LumaError::SftpFailed(
                "remote ~/.ssh path is not a directory".into(),
            ));
        }
    } else {
        client
            .create_dir(ssh_directory.clone())
            .await
            .map_err(remote_error)?;
    }
    let mut directory_permissions = RemoteMetadata::empty();
    directory_permissions.permissions = Some(0o700);
    client
        .set_metadata(ssh_directory.clone(), directory_permissions)
        .await
        .map_err(remote_error)?;

    let authorized_keys = join_remote_path(&ssh_directory, "authorized_keys");
    let existing = if client
        .try_exists(authorized_keys.clone())
        .await
        .map_err(remote_error)?
    {
        let metadata = client
            .metadata(authorized_keys.clone())
            .await
            .map_err(remote_error)?;
        if metadata.len() > MAX_AUTHORIZED_KEYS_BYTES {
            return Err(LumaError::SftpFailed(format!(
                "remote authorized_keys exceeds {MAX_AUTHORIZED_KEYS_BYTES} bytes"
            )));
        }
        client
            .read(authorized_keys.clone())
            .await
            .map_err(remote_error)?
    } else {
        Vec::new()
    };
    let (updated, installed) = merge_authorized_keys(&existing, public_key)?;
    if installed {
        let suffix = &updated[existing.len()..];
        let mut file = client
            .open_with_flags_and_attributes(
                authorized_keys.clone(),
                OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::APPEND,
                {
                    let mut metadata = RemoteMetadata::empty();
                    metadata.permissions = Some(0o600);
                    metadata
                },
            )
            .await
            .map_err(remote_error)?;
        file.write_all(suffix)
            .await
            .map_err(|error| LumaError::SftpFailed(error.to_string()))?;
        file.flush()
            .await
            .map_err(|error| LumaError::SftpFailed(error.to_string()))?;
    }
    let mut file_permissions = RemoteMetadata::empty();
    file_permissions.permissions = Some(0o600);
    client
        .set_metadata(authorized_keys, file_permissions)
        .await
        .map_err(remote_error)?;
    Ok(installed)
}

pub async fn list(manager: &SftpManager, session_id: &str, path: &str) -> Result<DirectoryListing> {
    let client = manager.client(session_id)?;
    let path = validate_remote_path(path)?;
    let canonical = client.canonicalize(path).await.map_err(remote_error)?;
    validate_remote_path(&canonical)?;
    let read_dir = client
        .read_dir(canonical.clone())
        .await
        .map_err(remote_error)?;
    let mut entries = Vec::new();

    for entry in read_dir {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            return Err(LumaError::SftpFailed(format!(
                "directory contains more than {MAX_DIRECTORY_ENTRIES} entries"
            )));
        }
        let name = entry.file_name();
        if name.contains('\0') {
            return Err(LumaError::SftpFailed(
                "server returned a filename containing NUL".into(),
            ));
        }
        let metadata = entry.metadata();
        entries.push(remote_entry(&canonical, name, metadata)?);
    }
    sort_entries(&mut entries);

    Ok(DirectoryListing {
        path: canonical,
        entries,
    })
}

pub async fn mkdir(manager: &SftpManager, session_id: &str, path: &str) -> Result<()> {
    let client = manager.client(session_id)?;
    let path = validate_remote_path(path)?;
    if client
        .try_exists(path.clone())
        .await
        .map_err(remote_error)?
    {
        return Err(LumaError::SftpFailed(
            "remote destination already exists".into(),
        ));
    }
    client.create_dir(path).await.map_err(remote_error)
}

pub async fn rename(manager: &SftpManager, session_id: &str, from: &str, to: &str) -> Result<()> {
    let client = manager.client(session_id)?;
    let from = validate_remote_path(from)?;
    let to = validate_remote_path(to)?;
    if client.try_exists(to.clone()).await.map_err(remote_error)? {
        return Err(LumaError::SftpFailed(
            "remote destination already exists".into(),
        ));
    }
    client.rename(from, to).await.map_err(remote_error)
}

pub async fn delete(
    manager: &SftpManager,
    session_id: &str,
    path: &str,
    recursive: bool,
) -> Result<()> {
    let client = manager.client(session_id)?;
    let path = validate_remote_path(path)?;
    let metadata = client
        .symlink_metadata(path.clone())
        .await
        .map_err(remote_error)?;

    if !metadata.is_dir() {
        return client.remove_file(path).await.map_err(remote_error);
    }
    if !recursive {
        return client.remove_dir(path).await.map_err(remote_error);
    }

    let plan = build_remote_delete_plan(&client, path).await?;
    for operation in plan {
        match operation {
            DeleteOperation::File(path) => client.remove_file(path).await.map_err(remote_error)?,
            DeleteOperation::Directory(path) => {
                client.remove_dir(path).await.map_err(remote_error)?
            }
        }
    }
    Ok(())
}

enum DeleteOperation {
    File(String),
    Directory(String),
}

enum PendingDelete {
    Visit {
        path: String,
        depth: usize,
        metadata: RemoteMetadata,
    },
    RemoveDirectory(String),
}

async fn build_remote_delete_plan(
    client: &SftpSession,
    root: String,
) -> Result<Vec<DeleteOperation>> {
    let root_metadata = client
        .symlink_metadata(root.clone())
        .await
        .map_err(remote_error)?;
    let mut stack = vec![PendingDelete::Visit {
        path: root,
        depth: 0,
        metadata: root_metadata,
    }];
    let mut budget = DeleteBudget::new(MAX_DELETE_DEPTH, MAX_DELETE_ENTRIES);
    budget.visit(0)?;
    let mut plan = Vec::new();

    while let Some(pending) = stack.pop() {
        match pending {
            PendingDelete::RemoveDirectory(path) => {
                plan.push(DeleteOperation::Directory(path));
            }
            PendingDelete::Visit {
                path,
                depth,
                metadata,
            } => {
                if !metadata.is_dir() {
                    plan.push(DeleteOperation::File(path));
                    continue;
                }

                let children = client.read_dir(path.clone()).await.map_err(remote_error)?;
                let mut child_entries = Vec::new();
                for child in children {
                    let name = child.file_name();
                    if name.contains('\0') {
                        return Err(LumaError::SftpFailed(
                            "server returned a filename containing NUL".into(),
                        ));
                    }
                    budget.visit(depth + 1)?;
                    child_entries.push((join_remote_path(&path, &name), child.metadata()));
                }
                stack.push(PendingDelete::RemoveDirectory(path));
                for (child_path, child_metadata) in child_entries.into_iter().rev() {
                    stack.push(PendingDelete::Visit {
                        path: child_path,
                        depth: depth + 1,
                        metadata: child_metadata,
                    });
                }
            }
        }
    }
    Ok(plan)
}

#[derive(Debug)]
pub(super) struct DeleteBudget {
    max_depth: usize,
    max_entries: usize,
    entries: usize,
}

impl DeleteBudget {
    pub(super) fn new(max_depth: usize, max_entries: usize) -> Self {
        Self {
            max_depth,
            max_entries,
            entries: 0,
        }
    }

    pub(super) fn visit(&mut self, depth: usize) -> Result<()> {
        if depth > self.max_depth {
            return Err(LumaError::SftpFailed(format!(
                "recursive delete exceeds the maximum depth of {}",
                self.max_depth
            )));
        }
        self.entries += 1;
        if self.entries > self.max_entries {
            return Err(LumaError::SftpFailed(format!(
                "recursive delete exceeds the maximum of {} entries",
                self.max_entries
            )));
        }
        Ok(())
    }
}

pub(super) fn validate_remote_path(path: &str) -> Result<String> {
    if path.is_empty() {
        return Err(LumaError::InvalidInput("remote path is empty".into()));
    }
    if path.contains('\0') {
        return Err(LumaError::InvalidInput(
            "remote path may not contain NUL".into(),
        ));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(LumaError::InvalidInput(format!(
            "remote path exceeds {MAX_PATH_BYTES} bytes"
        )));
    }
    Ok(path.to_string())
}

pub(super) fn validate_identifier(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() || value.contains('\0') || value.len() > 256 {
        return Err(LumaError::InvalidInput(format!("{field} is invalid")));
    }
    Ok(())
}

pub(super) fn remote_error(error: russh_sftp::client::error::Error) -> LumaError {
    LumaError::SftpFailed(error.to_string())
}

fn connect_error(stderr: &[u8], protocol_error: &str) -> LumaError {
    let stderr = String::from_utf8_lossy(stderr);
    if let Some((category, message)) = classify_error_output(&stderr) {
        LumaError::SshConnection {
            category,
            message: message.into(),
        }
    } else {
        LumaError::SftpFailed(format!(
            "could not initialize the SFTP subsystem: {protocol_error}"
        ))
    }
}

async fn capture_stderr(mut stderr: tokio::process::ChildStderr) -> Vec<u8> {
    let mut captured = Vec::with_capacity(CAPTURE_LIMIT_BYTES);
    let mut buffer = [0_u8; 4096];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) if captured.len() < CAPTURE_LIMIT_BYTES => {
                let remaining = CAPTURE_LIMIT_BYTES - captured.len();
                captured.extend_from_slice(&buffer[..read.min(remaining)]);
            }
            Ok(_) => {}
        }
    }
    captured
}

fn remote_entry(parent: &str, name: String, metadata: RemoteMetadata) -> Result<FileEntry> {
    let path = join_remote_path(parent, &name);
    validate_remote_path(&path)?;
    let kind = match metadata.file_type() {
        RemoteFileType::Dir => "dir",
        RemoteFileType::File => "file",
        RemoteFileType::Symlink => "symlink",
        RemoteFileType::Other => "other",
    };
    Ok(FileEntry {
        name,
        path,
        kind: kind.into(),
        size: metadata.size,
        modified_at: metadata.mtime.map(i64::from),
        permissions: metadata
            .permissions
            .map(|_| metadata.permissions().to_string()),
    })
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

pub(super) fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|left, right| {
        let left_dir = left.kind == "dir";
        let right_dir = right.kind == "dir";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_remote_paths_and_identifiers() {
        assert_eq!(validate_remote_path("/tmp/a b").unwrap(), "/tmp/a b");
        assert_eq!(
            validate_remote_path("relative/file").unwrap(),
            "relative/file"
        );
        assert_eq!(
            validate_remote_path("").unwrap_err().category(),
            "invalid-input"
        );
        assert_eq!(
            validate_remote_path("bad\0path").unwrap_err().category(),
            "invalid-input"
        );
        assert!(validate_identifier("session-id", "sessionId").is_ok());
        assert!(validate_identifier(" ", "sessionId").is_err());
    }

    #[test]
    fn recursive_delete_budget_enforces_depth_and_entry_caps() {
        let mut depth_budget = DeleteBudget::new(2, 10);
        depth_budget.visit(0).unwrap();
        depth_budget.visit(2).unwrap();
        let error = depth_budget.visit(3).unwrap_err();
        assert_eq!(error.category(), "sftp-failed");
        assert!(error.to_string().contains("maximum depth"));

        let mut entry_budget = DeleteBudget::new(10, 2);
        entry_budget.visit(0).unwrap();
        entry_budget.visit(1).unwrap();
        let error = entry_budget.visit(1).unwrap_err();
        assert_eq!(error.category(), "sftp-failed");
        assert!(error.to_string().contains("maximum of 2 entries"));
    }

    #[test]
    fn session_store_tracks_independent_sessions() {
        let mut store = SessionStore::default();
        store.insert("two".into(), "host-b".into(), 2_u8);
        store.insert("one".into(), "host-a".into(), 1_u8);

        assert_eq!(store.get("one"), Some(&1));
        assert_eq!(
            store.list(),
            vec![
                SftpSessionInfo {
                    sftp_session_id: "one".into(),
                    host_id: "host-a".into(),
                },
                SftpSessionInfo {
                    sftp_session_id: "two".into(),
                    host_id: "host-b".into(),
                },
            ]
        );
        assert_eq!(store.remove("one"), Some(1));
        assert!(store.get("one").is_none());
        assert_eq!(store.drain(), vec![2]);
    }

    #[test]
    fn sorts_directories_first_then_names() {
        let mut entries = vec![
            FileEntry {
                name: "z.txt".into(),
                path: "/z.txt".into(),
                kind: "file".into(),
                size: Some(1),
                modified_at: None,
                permissions: None,
            },
            FileEntry {
                name: "beta".into(),
                path: "/beta".into(),
                kind: "dir".into(),
                size: None,
                modified_at: None,
                permissions: None,
            },
            FileEntry {
                name: "Alpha".into(),
                path: "/Alpha".into(),
                kind: "dir".into(),
                size: None,
                modified_at: None,
                permissions: None,
            },
        ];
        sort_entries(&mut entries);
        assert_eq!(
            entries
                .into_iter()
                .map(|entry| entry.name)
                .collect::<Vec<_>>(),
            vec!["Alpha", "beta", "z.txt"]
        );
    }

    #[test]
    fn authorized_keys_install_is_idempotent_and_preserves_content() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest generated@example";
        let existing = b"# keep this comment\nssh-rsa AAAAB3NzaExisting old@example\n";
        let (installed, changed) = merge_authorized_keys(existing, key).unwrap();
        assert!(changed);
        assert!(installed.starts_with(existing));
        assert!(installed.ends_with(format!("{key}\n").as_bytes()));

        let same_blob_different_comment =
            "restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest other-comment";
        let (unchanged, changed) =
            merge_authorized_keys(&installed, same_blob_different_comment).unwrap();
        assert!(!changed);
        assert_eq!(unchanged, installed);
    }

    #[test]
    fn authorized_keys_append_repairs_missing_trailing_newline_without_rewriting_existing_bytes() {
        let existing = b"ssh-rsa AAAAexisting no-newline";
        let key = "ssh-ed25519 AAAAnew comment";
        let (updated, changed) = merge_authorized_keys(existing, key).unwrap();
        assert!(changed);
        assert_eq!(
            updated,
            b"ssh-rsa AAAAexisting no-newline\nssh-ed25519 AAAAnew comment\n"
        );
    }

    #[test]
    fn embedded_fallback_never_bypasses_security_failures() {
        let host_key = LumaError::SshConnection {
            category: "host-key-rejected",
            message: "mismatch".into(),
        };
        let authentication = LumaError::SshConnection {
            category: "authentication",
            message: "denied".into(),
        };
        assert!(!embedded_fallback_allowed(&host_key));
        assert!(!embedded_fallback_allowed(&authentication));
        assert!(embedded_fallback_allowed(&LumaError::SftpFailed(
            "subsystem unsupported".into()
        )));
    }
}
