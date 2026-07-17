use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

use super::local::{reject_app_data_path, validate_local_path, validated_creation_path};
use super::{remote_error, validate_remote_path, ActiveTransfer, SftpManager};
use crate::errors::{LumaError, Result};

const TRANSFER_CHUNK_BYTES: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_BYTE_INTERVAL: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferStartResponse {
    pub transfer_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub transferred: u64,
    pub total: Option<u64>,
    pub state: String,
    pub error_message: Option<String>,
}

pub async fn sftp_upload(
    manager: &SftpManager,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    let client = manager.client(session_id)?;
    let local_path = validate_local_path(local_path)?;
    let remote_path = validate_remote_path(remote_path)?;
    let metadata = tokio::fs::metadata(&local_path).await.map_err(|error| {
        LumaError::SftpFailed(format!("could not inspect upload source: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(LumaError::InvalidInput(
            "upload source must be a local file".into(),
        ));
    }
    let total = Some(metadata.len());
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (cancel, cancel_rx) = watch::channel(false);
    manager.transfers.lock().unwrap().insert(
        transfer_id.clone(),
        ActiveTransfer {
            session_id: session_id.to_string(),
            cancel,
        },
    );

    emit_progress(&on_progress, &transfer_id, 0, total, "running", None);
    let transfers = Arc::clone(&manager.transfers);
    let task_transfer_id = transfer_id.clone();
    tokio::spawn(async move {
        let outcome = upload_task(
            client,
            local_path,
            remote_path,
            total,
            cancel_rx,
            |transferred| {
                emit_progress(
                    &on_progress,
                    &task_transfer_id,
                    transferred,
                    total,
                    "running",
                    None,
                );
            },
        )
        .await;
        emit_terminal(&on_progress, &task_transfer_id, total, outcome);
        transfers.lock().unwrap().remove(&task_transfer_id);
    });

    Ok(TransferStartResponse { transfer_id })
}

pub async fn sftp_download(
    manager: &SftpManager,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
    app_data_dir: &Path,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    let client = manager.client(session_id)?;
    let remote_path = validate_remote_path(remote_path)?;
    let local_path = validated_creation_path(local_path)?;
    reject_app_data_path(&local_path, app_data_dir)?;
    if let Ok(metadata) = tokio::fs::symlink_metadata(&local_path).await {
        if metadata.is_dir() {
            return Err(LumaError::InvalidInput(
                "download destination must be a local file path".into(),
            ));
        }
    }
    let remote_metadata = client
        .symlink_metadata(remote_path.clone())
        .await
        .map_err(remote_error)?;
    if remote_metadata.is_dir() {
        return Err(LumaError::InvalidInput(
            "download source must be a remote file".into(),
        ));
    }
    let total = remote_metadata.size;
    let temp_path = sibling_temp_path(&local_path, "part")?;
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (cancel, cancel_rx) = watch::channel(false);
    manager.transfers.lock().unwrap().insert(
        transfer_id.clone(),
        ActiveTransfer {
            session_id: session_id.to_string(),
            cancel,
        },
    );

    emit_progress(&on_progress, &transfer_id, 0, total, "running", None);
    let transfers = Arc::clone(&manager.transfers);
    let task_transfer_id = transfer_id.clone();
    tokio::spawn(async move {
        let outcome = download_task(
            client,
            remote_path,
            local_path,
            temp_path,
            total,
            cancel_rx,
            |transferred| {
                emit_progress(
                    &on_progress,
                    &task_transfer_id,
                    transferred,
                    total,
                    "running",
                    None,
                );
            },
        )
        .await;
        emit_terminal(&on_progress, &task_transfer_id, total, outcome);
        transfers.lock().unwrap().remove(&task_transfer_id);
    });

    Ok(TransferStartResponse { transfer_id })
}

async fn upload_task(
    client: Arc<SftpSession>,
    local_path: PathBuf,
    remote_path: String,
    total: Option<u64>,
    cancel: watch::Receiver<bool>,
    on_progress: impl FnMut(u64),
) -> TransferOutcome {
    let mut source = match tokio::fs::File::open(local_path).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: 0,
                message: format!("could not open upload source: {error}"),
            }
        }
    };
    let mut destination = match client.create(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: 0,
                message: remote_error(error).to_string(),
            }
        }
    };

    match copy_stream(&mut source, &mut destination, total, cancel, on_progress).await {
        Ok(transferred) => TransferOutcome::Completed { transferred },
        Err(CopyFailure::Cancelled { transferred }) => TransferOutcome::Cancelled { transferred },
        Err(CopyFailure::Io { transferred, error }) => TransferOutcome::Failed {
            transferred,
            message: format!("upload failed: {error}"),
        },
    }
}

async fn download_task(
    client: Arc<SftpSession>,
    remote_path: String,
    local_path: PathBuf,
    temp_path: PathBuf,
    total: Option<u64>,
    cancel: watch::Receiver<bool>,
    on_progress: impl FnMut(u64),
) -> TransferOutcome {
    let mut source = match client.open(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: 0,
                message: remote_error(error).to_string(),
            }
        }
    };
    let mut destination = match tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .await
    {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: 0,
                message: format!("could not create temporary download file: {error}"),
            }
        }
    };

    let result = copy_stream(
        &mut source,
        &mut destination,
        total,
        cancel.clone(),
        on_progress,
    )
    .await;
    let outcome = match result {
        Ok(transferred) if *cancel.borrow() => TransferOutcome::Cancelled { transferred },
        Ok(transferred) => match destination.sync_all().await {
            Ok(()) => match replace_destination(&temp_path, &local_path).await {
                Ok(()) => TransferOutcome::Completed { transferred },
                Err(error) => TransferOutcome::Failed {
                    transferred,
                    message: format!("could not finish download: {error}"),
                },
            },
            Err(error) => TransferOutcome::Failed {
                transferred,
                message: format!("could not flush download: {error}"),
            },
        },
        Err(CopyFailure::Cancelled { transferred }) => TransferOutcome::Cancelled { transferred },
        Err(CopyFailure::Io { transferred, error }) => TransferOutcome::Failed {
            transferred,
            message: format!("download failed: {error}"),
        },
    };

    if !matches!(outcome, TransferOutcome::Completed { .. }) {
        let _ = tokio::fs::remove_file(&temp_path).await;
    }
    outcome
}

async fn replace_destination(temp_path: &Path, destination: &Path) -> io::Result<()> {
    match tokio::fs::symlink_metadata(destination).await {
        Ok(metadata) if metadata.is_dir() => Err(io::Error::new(
            io::ErrorKind::IsADirectory,
            "download destination is a directory",
        )),
        Ok(_) => {
            let backup = sibling_temp_path(destination, "backup")
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error.to_string()))?;
            tokio::fs::rename(destination, &backup).await?;
            if let Err(error) = tokio::fs::rename(temp_path, destination).await {
                let _ = tokio::fs::rename(&backup, destination).await;
                return Err(error);
            }
            let _ = tokio::fs::remove_file(backup).await;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            tokio::fs::rename(temp_path, destination).await
        }
        Err(error) => Err(error),
    }
}

fn sibling_temp_path(destination: &Path, label: &str) -> Result<PathBuf> {
    let parent = destination
        .parent()
        .ok_or_else(|| LumaError::InvalidInput("local path has no parent directory".into()))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| LumaError::InvalidInput("local filename is invalid".into()))?;
    Ok(parent.join(format!(".{name}.luma-{label}-{}", uuid::Uuid::new_v4())))
}

#[derive(Debug)]
enum TransferOutcome {
    Completed { transferred: u64 },
    Failed { transferred: u64, message: String },
    Cancelled { transferred: u64 },
}

fn emit_terminal(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    total: Option<u64>,
    outcome: TransferOutcome,
) {
    match outcome {
        TransferOutcome::Completed { transferred } => {
            emit_progress(channel, transfer_id, transferred, total, "completed", None)
        }
        TransferOutcome::Failed {
            transferred,
            message,
        } => emit_progress(
            channel,
            transfer_id,
            transferred,
            total,
            "failed",
            Some(message),
        ),
        TransferOutcome::Cancelled { transferred } => {
            emit_progress(channel, transfer_id, transferred, total, "cancelled", None)
        }
    }
}

fn emit_progress(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    transferred: u64,
    total: Option<u64>,
    state: &str,
    error_message: Option<String>,
) {
    let _ = channel.send(TransferProgress {
        transfer_id: transfer_id.to_string(),
        transferred,
        total,
        state: state.to_string(),
        error_message,
    });
}

#[derive(Debug)]
enum CopyFailure {
    Cancelled { transferred: u64 },
    Io { transferred: u64, error: io::Error },
}

async fn copy_stream<R, W>(
    reader: &mut R,
    writer: &mut W,
    _total: Option<u64>,
    mut cancel: watch::Receiver<bool>,
    mut on_progress: impl FnMut(u64),
) -> std::result::Result<u64, CopyFailure>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
    let mut transferred = 0_u64;
    let mut gate = ProgressGate::new(Instant::now());

    loop {
        if *cancel.borrow() {
            return Err(CopyFailure::Cancelled { transferred });
        }
        let read = tokio::select! {
            biased;
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    return Err(CopyFailure::Cancelled { transferred });
                }
                continue;
            }
            result = reader.read(&mut buffer) => {
                result.map_err(|error| CopyFailure::Io { transferred, error })?
            }
        };
        if read == 0 {
            break;
        }

        let write_result = tokio::select! {
            biased;
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    return Err(CopyFailure::Cancelled { transferred });
                }
                continue;
            }
            result = writer.write_all(&buffer[..read]) => result,
        };
        write_result.map_err(|error| CopyFailure::Io { transferred, error })?;
        transferred += read as u64;
        let now = Instant::now();
        if gate.should_emit(transferred, now) {
            on_progress(transferred);
        }
    }

    let flush_result = tokio::select! {
        biased;
        changed = cancel.changed() => {
            if changed.is_ok() && *cancel.borrow() {
                return Err(CopyFailure::Cancelled { transferred });
            }
            Ok(())
        }
        result = writer.flush() => result,
    };
    flush_result.map_err(|error| CopyFailure::Io { transferred, error })?;
    let shutdown_result = tokio::select! {
        biased;
        changed = cancel.changed() => {
            if changed.is_ok() && *cancel.borrow() {
                return Err(CopyFailure::Cancelled { transferred });
            }
            Ok(())
        }
        result = writer.shutdown() => result,
    };
    shutdown_result.map_err(|error| CopyFailure::Io { transferred, error })?;
    Ok(transferred)
}

#[derive(Debug)]
struct ProgressGate {
    last_emitted_at: Instant,
    last_emitted_bytes: u64,
}

impl ProgressGate {
    fn new(now: Instant) -> Self {
        Self {
            last_emitted_at: now,
            last_emitted_bytes: 0,
        }
    }

    fn should_emit(&mut self, transferred: u64, now: Instant) -> bool {
        if now.duration_since(self.last_emitted_at) >= PROGRESS_INTERVAL
            || transferred.saturating_sub(self.last_emitted_bytes) >= PROGRESS_BYTE_INTERVAL
        {
            self.last_emitted_at = now;
            self.last_emitted_bytes = transferred;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::sync::Mutex;

    use super::*;

    #[tokio::test]
    async fn copy_stream_uses_bounded_chunks_and_preserves_bytes() {
        let input = vec![42_u8; TRANSFER_CHUNK_BYTES * 2 + 17];
        let mut reader = Cursor::new(input.clone());
        let mut writer = Cursor::new(Vec::new());
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let progress = Arc::new(Mutex::new(Vec::new()));
        let progress_for_copy = Arc::clone(&progress);

        let transferred = copy_stream(
            &mut reader,
            &mut writer,
            Some(input.len() as u64),
            cancel_rx,
            move |bytes| progress_for_copy.lock().unwrap().push(bytes),
        )
        .await
        .unwrap();

        assert_eq!(transferred, input.len() as u64);
        assert_eq!(writer.into_inner(), input);
        assert!(progress.lock().unwrap().len() <= 2);
    }

    #[test]
    fn progress_gate_throttles_by_time_or_bytes() {
        let start = Instant::now();
        let mut gate = ProgressGate::new(start);
        assert!(!gate.should_emit(TRANSFER_CHUNK_BYTES as u64, start));
        assert!(gate.should_emit(PROGRESS_BYTE_INTERVAL, start));
        assert!(!gate.should_emit(
            PROGRESS_BYTE_INTERVAL + 1,
            start + Duration::from_millis(99)
        ));
        assert!(gate.should_emit(
            PROGRESS_BYTE_INTERVAL + 2,
            start + Duration::from_millis(100)
        ));
    }

    #[tokio::test]
    async fn copy_stream_cancels_before_reading_more_chunks() {
        let input = vec![7_u8; TRANSFER_CHUNK_BYTES * 2];
        let mut reader = Cursor::new(input);
        let mut writer = Cursor::new(Vec::new());
        let (cancel_tx, cancel_rx) = watch::channel(false);
        cancel_tx.send(true).unwrap();

        let error = copy_stream(&mut reader, &mut writer, None, cancel_rx, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(error, CopyFailure::Cancelled { transferred: 0 }));
        assert!(writer.into_inner().is_empty());
    }
}
