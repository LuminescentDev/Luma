use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileType as RemoteFileType, OpenFlags};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::watch;

use super::local::{
    build_local_transfer_plan, reject_app_data_path, validate_local_path, validated_creation_path,
    TransferWalkIssue,
};
use super::{
    join_remote_path, remote_error, validate_remote_path, ActiveTransfer, SftpManager,
    MAX_DELETE_DEPTH, MAX_DELETE_ENTRIES,
};
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
pub struct AggregateTransferProgress {
    pub total_bytes: u64,
    pub bytes_done: u64,
    pub total_files: u64,
    pub files_done: u64,
    pub current_file_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transfer_id: String,
    pub transferred: u64,
    pub total: Option<u64>,
    pub state: String,
    pub error_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aggregate: Option<AggregateTransferProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed_from: Option<u64>,
}

#[derive(Debug, Clone)]
pub(super) enum TransferDescriptor {
    Upload {
        local_path: PathBuf,
        remote_path: String,
        is_directory: bool,
    },
    Download {
        remote_path: String,
        local_path: PathBuf,
        app_data_dir: PathBuf,
        is_directory: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TransferPhase {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceFingerprint {
    size: u64,
    modified_at: Option<u128>,
}

impl SourceFingerprint {
    fn supports_resume(&self) -> bool {
        self.modified_at.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileCheckpoint {
    source: SourceFingerprint,
    partial_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CheckpointDecision {
    resume_from: u64,
    cleanup_partial: bool,
}

fn checkpoint_decision(
    is_retry: bool,
    checkpoint: Option<&FileCheckpoint>,
    current_source: &SourceFingerprint,
    partial_path: &str,
    partial_len: Option<u64>,
) -> CheckpointDecision {
    let resumable = is_retry
        && current_source.supports_resume()
        && checkpoint.is_some_and(|checkpoint| {
            checkpoint.source == *current_source && checkpoint.partial_path == partial_path
        })
        && partial_len.is_some_and(|length| length > 0 && length <= current_source.size);
    CheckpointDecision {
        resume_from: if resumable {
            partial_len.unwrap_or_default()
        } else {
            0
        },
        cleanup_partial: partial_len.is_some() && !resumable,
    }
}

#[derive(Debug, Clone)]
struct RetryState {
    phase: TransferPhase,
    retryable: bool,
    completed_files: HashSet<String>,
    completed_directories: HashSet<String>,
    skipped_entries: HashSet<String>,
    // Checkpoints are deliberately process-local. App-restart resume is out of scope.
    checkpoints: HashMap<String, FileCheckpoint>,
}

pub(crate) struct TransferRecord {
    pub session_id: String,
    descriptor: TransferDescriptor,
    retry: Arc<Mutex<RetryState>>,
    is_retry: bool,
}

impl TransferRecord {
    fn new(session_id: String, descriptor: TransferDescriptor) -> Self {
        Self {
            session_id,
            descriptor,
            retry: Arc::new(Mutex::new(RetryState {
                phase: TransferPhase::Running,
                retryable: false,
                completed_files: HashSet::new(),
                completed_directories: HashSet::new(),
                skipped_entries: HashSet::new(),
                checkpoints: HashMap::new(),
            })),
            is_retry: false,
        }
    }

    fn for_retry(&self) -> Result<Self> {
        let mut state = self.retry.lock().unwrap();
        if state.phase == TransferPhase::Running {
            return Err(LumaError::InvalidInput("transfer is still running".into()));
        }
        if !state.retryable {
            return Err(LumaError::InvalidInput(
                "transfer has no failed or incomplete entries to retry".into(),
            ));
        }
        state.phase = TransferPhase::Running;
        state.retryable = false;
        drop(state);
        Ok(Self {
            session_id: self.session_id.clone(),
            descriptor: self.descriptor.clone(),
            retry: Arc::clone(&self.retry),
            is_retry: true,
        })
    }

    fn completed_file(&self, path: &str) -> bool {
        self.retry.lock().unwrap().completed_files.contains(path)
    }

    fn completed_directory(&self, path: &str) -> bool {
        self.retry
            .lock()
            .unwrap()
            .completed_directories
            .contains(path)
    }

    fn skipped(&self, path: &str) -> bool {
        self.retry.lock().unwrap().skipped_entries.contains(path)
    }

    fn mark_file_completed(&self, path: String) {
        self.retry.lock().unwrap().completed_files.insert(path);
    }

    fn mark_directory_completed(&self, path: String) {
        self.retry
            .lock()
            .unwrap()
            .completed_directories
            .insert(path);
    }

    fn mark_skipped(&self, path: String) {
        self.retry.lock().unwrap().skipped_entries.insert(path);
    }

    fn prepare_checkpoint(
        &self,
        key: &str,
        source: SourceFingerprint,
        partial_path: String,
        partial_len: Option<u64>,
    ) -> CheckpointDecision {
        let mut state = self.retry.lock().unwrap();
        let decision = checkpoint_decision(
            self.is_retry,
            state.checkpoints.get(key),
            &source,
            &partial_path,
            partial_len,
        );
        state.checkpoints.insert(
            key.to_string(),
            FileCheckpoint {
                source,
                partial_path,
            },
        );
        decision
    }

    fn clear_checkpoint(&self, key: &str) {
        self.retry.lock().unwrap().checkpoints.remove(key);
    }

    fn checkpoints(&self) -> Vec<(String, String)> {
        self.retry
            .lock()
            .unwrap()
            .checkpoints
            .iter()
            .map(|(key, checkpoint)| (key.clone(), checkpoint.partial_path.clone()))
            .collect()
    }

    fn finish(&self, phase: TransferPhase, retryable: bool) {
        let mut state = self.retry.lock().unwrap();
        state.phase = phase;
        state.retryable = retryable;
    }
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
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(LumaError::InvalidInput(
            "upload source must be a local file or directory".into(),
        ));
    }
    let record = Arc::new(TransferRecord::new(
        session_id.to_string(),
        TransferDescriptor::Upload {
            local_path,
            remote_path,
            is_directory: metadata.is_dir(),
        },
    ));
    launch_transfer(manager, client, record, on_progress)
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
    let remote_metadata = client
        .symlink_metadata(remote_path.clone())
        .await
        .map_err(remote_error)?;
    let is_directory = remote_metadata.is_dir();
    if let Ok(metadata) = tokio::fs::symlink_metadata(&local_path).await {
        let file_type = metadata.file_type();
        if is_directory {
            if file_type.is_symlink() || !file_type.is_dir() {
                return Err(LumaError::InvalidInput(
                    "directory download destination must be a local directory path".into(),
                ));
            }
        } else if metadata.is_dir() {
            return Err(LumaError::InvalidInput(
                "download destination must be a local file path".into(),
            ));
        }
    }
    let record = Arc::new(TransferRecord::new(
        session_id.to_string(),
        TransferDescriptor::Download {
            remote_path,
            local_path,
            app_data_dir: app_data_dir.to_path_buf(),
            is_directory,
        },
    ));
    launch_transfer(manager, client, record, on_progress)
}

pub async fn sftp_retry(
    manager: &SftpManager,
    transfer_id: &str,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    super::validate_identifier(transfer_id, "transferId")?;
    let previous = manager
        .transfer_records
        .lock()
        .unwrap()
        .get(transfer_id)
        .cloned()
        .ok_or_else(|| LumaError::InvalidInput("unknown transfer".into()))?;
    let client = manager.client(&previous.session_id)?;
    let record = Arc::new(previous.for_retry()?);
    launch_transfer(manager, client, record, on_progress)
}

fn launch_transfer(
    manager: &SftpManager,
    client: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    on_progress: Channel<TransferProgress>,
) -> Result<TransferStartResponse> {
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let (cancel, cancel_rx) = watch::channel(false);
    manager.transfers.lock().unwrap().insert(
        transfer_id.clone(),
        ActiveTransfer {
            session_id: record.session_id.clone(),
            cancel,
        },
    );
    manager
        .transfer_records
        .lock()
        .unwrap()
        .insert(transfer_id.clone(), Arc::clone(&record));

    let transfers = Arc::clone(&manager.transfers);
    let task_transfer_id = transfer_id.clone();
    tokio::spawn(async move {
        run_transfer_attempt(
            client,
            Arc::clone(&record),
            cancel_rx,
            &on_progress,
            &task_transfer_id,
        )
        .await;
        transfers.lock().unwrap().remove(&task_transfer_id);
    });
    Ok(TransferStartResponse { transfer_id })
}

async fn run_transfer_attempt(
    client: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    cancel: watch::Receiver<bool>,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
) {
    match record.descriptor.clone() {
        TransferDescriptor::Upload {
            local_path,
            remote_path,
            is_directory,
        } => {
            if is_directory {
                run_directory_upload(
                    client,
                    record,
                    local_path,
                    remote_path,
                    cancel,
                    channel,
                    transfer_id,
                )
                .await;
            } else {
                run_single_upload(
                    client,
                    record,
                    local_path,
                    remote_path,
                    cancel,
                    channel,
                    transfer_id,
                )
                .await;
            }
        }
        TransferDescriptor::Download {
            remote_path,
            local_path,
            app_data_dir,
            is_directory,
        } => {
            if is_directory {
                run_directory_download(
                    client,
                    record,
                    remote_path,
                    local_path,
                    app_data_dir,
                    cancel,
                    channel,
                    transfer_id,
                )
                .await;
            } else {
                run_single_download(
                    client,
                    record,
                    remote_path,
                    local_path,
                    cancel,
                    channel,
                    transfer_id,
                )
                .await;
            }
        }
    }
}

async fn run_single_upload(
    client: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    local_path: PathBuf,
    remote_path: String,
    cancel: watch::Receiver<bool>,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
) {
    let remote_temp = match remote_partial_path(&remote_path) {
        Ok(path) => path,
        Err(error) => {
            emit_progress(
                channel,
                transfer_id,
                0,
                None,
                "failed",
                Some(error.to_string()),
                None,
            );
            record.finish(TransferPhase::Failed, true);
            return;
        }
    };
    let prepared = match prepare_upload(&client, &record, "", &local_path, &remote_temp).await {
        Ok(prepared) => prepared,
        Err(error) => {
            emit_progress(
                channel,
                transfer_id,
                0,
                None,
                "failed",
                Some(error.to_string()),
                None,
            );
            record.finish(TransferPhase::Failed, true);
            return;
        }
    };
    let total = Some(prepared.source.size);
    let resumed_from = (prepared.resume_from > 0).then_some(prepared.resume_from);
    emit_progress(
        channel,
        transfer_id,
        prepared.resume_from,
        total,
        "running",
        None,
        resumed_from,
    );
    let outcome = upload_task(
        client,
        local_path,
        remote_path,
        remote_temp,
        total,
        prepared.resume_from,
        cancel,
        |transferred| {
            emit_progress(
                channel,
                transfer_id,
                transferred,
                total,
                "running",
                None,
                None,
            );
        },
    )
    .await;
    let (phase, retryable) = outcome_phase(&outcome);
    if matches!(outcome, TransferOutcome::Completed { .. }) {
        record.mark_file_completed(String::new());
        record.clear_checkpoint("");
    }
    emit_terminal(channel, transfer_id, total, outcome);
    record.finish(phase, retryable);
}

async fn run_single_download(
    client: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    remote_path: String,
    local_path: PathBuf,
    cancel: watch::Receiver<bool>,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
) {
    let temp_path = match sibling_partial_path(&local_path) {
        Ok(path) => path,
        Err(error) => {
            emit_progress(
                channel,
                transfer_id,
                0,
                None,
                "failed",
                Some(error.to_string()),
                None,
            );
            record.finish(TransferPhase::Failed, true);
            return;
        }
    };
    let prepared = match prepare_download(&client, &record, "", &remote_path, &temp_path).await {
        Ok(prepared) => prepared,
        Err(error) => {
            emit_progress(
                channel,
                transfer_id,
                0,
                None,
                "failed",
                Some(error.to_string()),
                None,
            );
            record.finish(TransferPhase::Failed, true);
            return;
        }
    };
    let total = Some(prepared.source.size);
    let resumed_from = (prepared.resume_from > 0).then_some(prepared.resume_from);
    emit_progress(
        channel,
        transfer_id,
        prepared.resume_from,
        total,
        "running",
        None,
        resumed_from,
    );
    let outcome = download_task(
        client,
        remote_path,
        local_path,
        temp_path,
        total,
        prepared.resume_from,
        cancel,
        |transferred| {
            emit_progress(
                channel,
                transfer_id,
                transferred,
                total,
                "running",
                None,
                None,
            );
        },
    )
    .await;
    let (phase, retryable) = outcome_phase(&outcome);
    if matches!(outcome, TransferOutcome::Completed { .. }) {
        record.mark_file_completed(String::new());
        record.clear_checkpoint("");
    }
    emit_terminal(channel, transfer_id, total, outcome);
    record.finish(phase, retryable);
}

async fn run_directory_upload(
    client: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    local_root: PathBuf,
    remote_root: String,
    cancel: watch::Receiver<bool>,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
) {
    let plan =
        match tokio::task::spawn_blocking(move || build_local_transfer_plan(&local_root)).await {
            Ok(Ok(plan)) => plan,
            Ok(Err(error)) => {
                emit_directory_terminal(
                    channel,
                    transfer_id,
                    AggregateTracker::default(),
                    TransferPhase::Failed,
                    Some(error.to_string()),
                );
                record.finish(TransferPhase::Failed, true);
                return;
            }
            Err(error) => {
                let message = format!("local transfer walk failed: {error}");
                emit_directory_terminal(
                    channel,
                    transfer_id,
                    AggregateTracker::default(),
                    TransferPhase::Failed,
                    Some(message),
                );
                record.finish(TransferPhase::Failed, true);
                return;
            }
        };

    let mut failures = report_walk_issues(&record, channel, transfer_id, &plan.issues);
    for relative in plan.directories {
        if record.completed_directory(&relative) {
            continue;
        }
        if *cancel.borrow() {
            emit_directory_terminal(
                channel,
                transfer_id,
                AggregateTracker::default(),
                TransferPhase::Cancelled,
                None,
            );
            record.finish(TransferPhase::Cancelled, true);
            return;
        }
        let destination = remote_destination(&remote_root, &relative);
        match ensure_remote_directory(&client, &destination).await {
            Ok(()) => record.mark_directory_completed(relative),
            Err(error) => {
                failures += 1;
                emit_entry(
                    channel,
                    transfer_id,
                    &display_relative(&relative),
                    "failed",
                    Some(error.to_string()),
                );
            }
        }
    }

    let files = plan
        .files
        .into_iter()
        .filter(|file| {
            !record.completed_file(&file.relative_path) && !record.skipped(&file.relative_path)
        })
        .collect::<Vec<_>>();
    let mut aggregate = AggregateTracker::new(files.iter().map(|file| file.size));
    for file in files {
        if *cancel.borrow() {
            emit_directory_terminal(
                channel,
                transfer_id,
                aggregate,
                TransferPhase::Cancelled,
                None,
            );
            record.finish(TransferPhase::Cancelled, true);
            return;
        }
        let relative = file.relative_path;
        let display = display_relative(&relative);
        let destination = remote_destination(&remote_root, &relative);
        let remote_temp = match remote_partial_path(&destination) {
            Ok(path) => path,
            Err(error) => {
                failures += 1;
                aggregate.begin_file(display.clone());
                aggregate.finish_file(0);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    0,
                    Some(file.size),
                    "failed",
                    Some(error.to_string()),
                    &aggregate,
                    None,
                );
                continue;
            }
        };
        let prepared =
            match prepare_upload(&client, &record, &relative, &file.source, &remote_temp).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    failures += 1;
                    aggregate.begin_file(display.clone());
                    aggregate.finish_file(0);
                    emit_file(
                        channel,
                        transfer_id,
                        &display,
                        0,
                        Some(file.size),
                        "failed",
                        Some(error.to_string()),
                        &aggregate,
                        None,
                    );
                    continue;
                }
            };
        let total = Some(prepared.source.size);
        let resumed_from = (prepared.resume_from > 0).then_some(prepared.resume_from);
        aggregate.begin_file(display.clone());
        let resumed_aggregate = aggregate.current(prepared.resume_from);
        emit_file(
            channel,
            transfer_id,
            &display,
            prepared.resume_from,
            total,
            "running",
            None,
            &resumed_aggregate,
            resumed_from,
        );
        emit_aggregate(channel, transfer_id, &resumed_aggregate, "running", None);
        let outcome = upload_task(
            Arc::clone(&client),
            file.source,
            destination,
            remote_temp,
            total,
            prepared.resume_from,
            cancel.clone(),
            |transferred| {
                let current = aggregate.current(transferred);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "running",
                    None,
                    &current,
                    None,
                );
                emit_aggregate(channel, transfer_id, &current, "running", None);
            },
        )
        .await;
        let transferred = outcome.transferred();
        match outcome {
            TransferOutcome::Completed { .. } => {
                aggregate.finish_file(transferred);
                record.mark_file_completed(relative.clone());
                record.clear_checkpoint(&relative);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "completed",
                    None,
                    &aggregate,
                    None,
                );
            }
            TransferOutcome::Failed { message, .. } => {
                failures += 1;
                aggregate.finish_file(transferred);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "failed",
                    Some(message),
                    &aggregate,
                    None,
                );
            }
            TransferOutcome::Cancelled { .. } => {
                aggregate.finish_file(transferred);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "cancelled",
                    None,
                    &aggregate,
                    None,
                );
                emit_directory_terminal(
                    channel,
                    transfer_id,
                    aggregate,
                    TransferPhase::Cancelled,
                    None,
                );
                record.finish(TransferPhase::Cancelled, true);
                return;
            }
        }
        emit_aggregate(channel, transfer_id, &aggregate, "running", None);
    }
    if failures == 0 {
        if let Err(error) = cleanup_remote_checkpoints(&client, &record).await {
            failures += 1;
            emit_entry(channel, transfer_id, ".", "failed", Some(error.to_string()));
        }
    }
    finish_directory(record, channel, transfer_id, aggregate, failures);
}

#[allow(clippy::too_many_arguments)]
async fn run_directory_download(
    client: Arc<SftpSession>,
    record: Arc<TransferRecord>,
    remote_root: String,
    local_root: PathBuf,
    app_data_dir: PathBuf,
    cancel: watch::Receiver<bool>,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
) {
    if let Err(error) = reject_app_data_path(&local_root, &app_data_dir) {
        emit_directory_terminal(
            channel,
            transfer_id,
            AggregateTracker::default(),
            TransferPhase::Failed,
            Some(error.to_string()),
        );
        record.finish(TransferPhase::Failed, true);
        return;
    }
    let plan = match build_remote_transfer_plan(&client, &remote_root).await {
        Ok(plan) => plan,
        Err(error) => {
            emit_directory_terminal(
                channel,
                transfer_id,
                AggregateTracker::default(),
                TransferPhase::Failed,
                Some(error.to_string()),
            );
            record.finish(TransferPhase::Failed, true);
            return;
        }
    };
    let mut failures = report_walk_issues(&record, channel, transfer_id, &plan.issues);
    for relative in plan.directories {
        if record.completed_directory(&relative) {
            continue;
        }
        if *cancel.borrow() {
            emit_directory_terminal(
                channel,
                transfer_id,
                AggregateTracker::default(),
                TransferPhase::Cancelled,
                None,
            );
            record.finish(TransferPhase::Cancelled, true);
            return;
        }
        let destination = match local_destination(&local_root, &relative) {
            Ok(path) => path,
            Err(error) => {
                failures += 1;
                emit_entry(
                    channel,
                    transfer_id,
                    &display_relative(&relative),
                    "failed",
                    Some(error.to_string()),
                );
                continue;
            }
        };
        match ensure_local_directory(&destination).await {
            Ok(()) => record.mark_directory_completed(relative),
            Err(error) => {
                failures += 1;
                emit_entry(
                    channel,
                    transfer_id,
                    &display_relative(&relative),
                    "failed",
                    Some(error.to_string()),
                );
            }
        }
    }

    let files = plan
        .files
        .into_iter()
        .filter(|file| {
            !record.completed_file(&file.relative_path) && !record.skipped(&file.relative_path)
        })
        .collect::<Vec<_>>();
    let mut aggregate = AggregateTracker::new(files.iter().map(|file| file.size.unwrap_or(0)));
    for file in files {
        if *cancel.borrow() {
            emit_directory_terminal(
                channel,
                transfer_id,
                aggregate,
                TransferPhase::Cancelled,
                None,
            );
            record.finish(TransferPhase::Cancelled, true);
            return;
        }
        let relative = file.relative_path;
        let display = display_relative(&relative);
        let destination = match local_destination(&local_root, &relative) {
            Ok(path) => path,
            Err(error) => {
                failures += 1;
                aggregate.begin_file(display.clone());
                aggregate.finish_file(0);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    0,
                    file.size,
                    "failed",
                    Some(error.to_string()),
                    &aggregate,
                    None,
                );
                continue;
            }
        };
        let temp_path = match sibling_partial_path(&destination) {
            Ok(path) => path,
            Err(error) => {
                failures += 1;
                aggregate.begin_file(display.clone());
                aggregate.finish_file(0);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    0,
                    file.size,
                    "failed",
                    Some(error.to_string()),
                    &aggregate,
                    None,
                );
                continue;
            }
        };
        let prepared =
            match prepare_download(&client, &record, &relative, &file.source, &temp_path).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    failures += 1;
                    aggregate.begin_file(display.clone());
                    aggregate.finish_file(0);
                    emit_file(
                        channel,
                        transfer_id,
                        &display,
                        0,
                        file.size,
                        "failed",
                        Some(error.to_string()),
                        &aggregate,
                        None,
                    );
                    continue;
                }
            };
        let total = Some(prepared.source.size);
        let resumed_from = (prepared.resume_from > 0).then_some(prepared.resume_from);
        aggregate.begin_file(display.clone());
        let resumed_aggregate = aggregate.current(prepared.resume_from);
        emit_file(
            channel,
            transfer_id,
            &display,
            prepared.resume_from,
            total,
            "running",
            None,
            &resumed_aggregate,
            resumed_from,
        );
        emit_aggregate(channel, transfer_id, &resumed_aggregate, "running", None);
        let outcome = download_task(
            Arc::clone(&client),
            file.source,
            destination,
            temp_path,
            total,
            prepared.resume_from,
            cancel.clone(),
            |transferred| {
                let current = aggregate.current(transferred);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "running",
                    None,
                    &current,
                    None,
                );
                emit_aggregate(channel, transfer_id, &current, "running", None);
            },
        )
        .await;
        let transferred = outcome.transferred();
        match outcome {
            TransferOutcome::Completed { .. } => {
                aggregate.finish_file(transferred);
                record.mark_file_completed(relative.clone());
                record.clear_checkpoint(&relative);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "completed",
                    None,
                    &aggregate,
                    None,
                );
            }
            TransferOutcome::Failed { message, .. } => {
                failures += 1;
                aggregate.finish_file(transferred);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "failed",
                    Some(message),
                    &aggregate,
                    None,
                );
            }
            TransferOutcome::Cancelled { .. } => {
                aggregate.finish_file(transferred);
                emit_file(
                    channel,
                    transfer_id,
                    &display,
                    transferred,
                    total,
                    "cancelled",
                    None,
                    &aggregate,
                    None,
                );
                emit_directory_terminal(
                    channel,
                    transfer_id,
                    aggregate,
                    TransferPhase::Cancelled,
                    None,
                );
                record.finish(TransferPhase::Cancelled, true);
                return;
            }
        }
        emit_aggregate(channel, transfer_id, &aggregate, "running", None);
    }
    if failures == 0 {
        if let Err(error) = cleanup_local_checkpoints(&record).await {
            failures += 1;
            emit_entry(channel, transfer_id, ".", "failed", Some(error.to_string()));
        }
    }
    finish_directory(record, channel, transfer_id, aggregate, failures);
}

async fn cleanup_remote_checkpoints(client: &SftpSession, record: &TransferRecord) -> Result<()> {
    for (key, path) in record.checkpoints() {
        if client
            .try_exists(path.clone())
            .await
            .map_err(remote_error)?
        {
            client.remove_file(path).await.map_err(remote_error)?;
        }
        record.clear_checkpoint(&key);
    }
    Ok(())
}

async fn cleanup_local_checkpoints(record: &TransferRecord) -> Result<()> {
    for (key, path) in record.checkpoints() {
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(LumaError::SftpFailed(format!(
                    "could not remove stale partial download: {error}"
                )))
            }
        }
        record.clear_checkpoint(&key);
    }
    Ok(())
}

fn finish_directory(
    record: Arc<TransferRecord>,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    aggregate: AggregateTracker,
    failures: usize,
) {
    if failures == 0 {
        emit_directory_terminal(
            channel,
            transfer_id,
            aggregate,
            TransferPhase::Completed,
            None,
        );
        record.finish(TransferPhase::Completed, false);
    } else {
        let message = format!("{failures} transfer entries failed");
        emit_directory_terminal(
            channel,
            transfer_id,
            aggregate,
            TransferPhase::Failed,
            Some(message),
        );
        record.finish(TransferPhase::Failed, true);
    }
}

fn report_walk_issues(
    record: &TransferRecord,
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    issues: &[TransferWalkIssue],
) -> usize {
    let mut failures = 0;
    for issue in issues {
        if record.skipped(&issue.path) {
            continue;
        }
        if issue.skipped {
            record.mark_skipped(issue.path.clone());
            emit_entry(
                channel,
                transfer_id,
                &display_relative(&issue.path),
                "skipped",
                Some(issue.message.clone()),
            );
        } else {
            failures += 1;
            emit_entry(
                channel,
                transfer_id,
                &display_relative(&issue.path),
                "failed",
                Some(issue.message.clone()),
            );
        }
    }
    failures
}

#[derive(Debug, Clone)]
struct RemoteTransferFile {
    source: String,
    relative_path: String,
    size: Option<u64>,
}

#[derive(Debug, Default)]
struct RemoteTransferPlan {
    directories: Vec<String>,
    files: Vec<RemoteTransferFile>,
    issues: Vec<TransferWalkIssue>,
}

async fn build_remote_transfer_plan(
    client: &SftpSession,
    root: &str,
) -> Result<RemoteTransferPlan> {
    let metadata = client
        .symlink_metadata(root.to_string())
        .await
        .map_err(remote_error)?;
    if !metadata.is_dir() {
        return Err(LumaError::InvalidInput(
            "download source must be a remote file or directory".into(),
        ));
    }
    let mut plan = RemoteTransferPlan::default();
    let mut stack = vec![(root.to_string(), String::new(), 0_usize)];
    let mut entries = 1_usize;
    while let Some((directory, relative, depth)) = stack.pop() {
        if depth > MAX_DELETE_DEPTH {
            return Err(LumaError::SftpFailed(format!(
                "recursive transfer exceeds the maximum depth of {MAX_DELETE_DEPTH}"
            )));
        }
        plan.directories.push(relative.clone());
        let children = match client.read_dir(directory.clone()).await {
            Ok(children) => children,
            Err(error) => {
                plan.issues.push(TransferWalkIssue {
                    path: relative,
                    message: format!("could not read remote directory: {}", remote_error(error)),
                    retryable: true,
                    skipped: false,
                });
                continue;
            }
        };
        let mut directories = Vec::new();
        for child in children {
            entries += 1;
            if entries > MAX_DELETE_ENTRIES {
                return Err(LumaError::SftpFailed(format!(
                    "recursive transfer exceeds the maximum of {MAX_DELETE_ENTRIES} entries"
                )));
            }
            let name = child.file_name();
            let child_relative = match safe_remote_child_relative(&relative, &name) {
                Ok(path) => path,
                Err(error) => {
                    plan.issues.push(TransferWalkIssue {
                        path: if relative.is_empty() {
                            name
                        } else {
                            format!("{relative}/{name}")
                        },
                        message: error.to_string(),
                        retryable: false,
                        skipped: true,
                    });
                    continue;
                }
            };
            let source = child.path();
            match child.file_type() {
                RemoteFileType::Dir => directories.push((source, child_relative)),
                RemoteFileType::File => plan.files.push(RemoteTransferFile {
                    source,
                    relative_path: child_relative,
                    size: child.metadata().size,
                }),
                RemoteFileType::Symlink => plan.issues.push(TransferWalkIssue {
                    path: child_relative,
                    message: "symlink skipped".into(),
                    retryable: false,
                    skipped: true,
                }),
                RemoteFileType::Other => plan.issues.push(TransferWalkIssue {
                    path: child_relative,
                    message: "non-regular remote entry skipped".into(),
                    retryable: false,
                    skipped: true,
                }),
            }
        }
        directories.sort_by(|left, right| left.1.cmp(&right.1));
        for (path, child_relative) in directories.into_iter().rev() {
            stack.push((path, child_relative, depth + 1));
        }
    }
    plan.directories
        .sort_by_key(|path| path.matches('/').count());
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn safe_remote_child_relative(parent: &str, name: &str) -> Result<String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(LumaError::SftpFailed(
            "server returned an unsafe filename".into(),
        ));
    }
    Ok(if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    })
}

fn remote_destination(root: &str, relative: &str) -> String {
    if relative.is_empty() {
        root.to_string()
    } else {
        relative
            .split('/')
            .fold(root.to_string(), |path, part| join_remote_path(&path, part))
    }
}

fn local_destination(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    if relative.is_empty() {
        return Ok(path);
    }
    for component in relative.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(LumaError::SftpFailed(
                "remote transfer path contains an unsafe component".into(),
            ));
        }
        path.push(component);
    }
    Ok(path)
}

async fn ensure_remote_directory(client: &SftpSession, path: &str) -> Result<()> {
    if client
        .try_exists(path.to_string())
        .await
        .map_err(remote_error)?
    {
        let metadata = client
            .symlink_metadata(path.to_string())
            .await
            .map_err(remote_error)?;
        if metadata.is_dir() {
            return Ok(());
        }
        return Err(LumaError::SftpFailed(format!(
            "remote destination is not a directory: {path}"
        )));
    }
    client
        .create_dir(path.to_string())
        .await
        .map_err(remote_error)
}

async fn ensure_local_directory(path: &Path) -> Result<()> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(LumaError::SftpFailed(format!(
            "local destination directory is a symlink: {}",
            path.display()
        ))),
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(_) => Err(LumaError::SftpFailed(format!(
            "local destination is not a directory: {}",
            path.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            tokio::fs::create_dir(path).await.map_err(|error| {
                LumaError::SftpFailed(format!("could not create local directory: {error}"))
            })
        }
        Err(error) => Err(LumaError::SftpFailed(format!(
            "could not inspect local directory: {error}"
        ))),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedFile {
    source: SourceFingerprint,
    resume_from: u64,
}

fn local_source_fingerprint(metadata: &std::fs::Metadata) -> SourceFingerprint {
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos());
    SourceFingerprint {
        size: metadata.len(),
        modified_at,
    }
}

fn remote_source_fingerprint(
    metadata: &russh_sftp::client::fs::Metadata,
) -> Result<SourceFingerprint> {
    let size = metadata
        .size
        .ok_or_else(|| LumaError::SftpFailed("remote source size is unavailable".into()))?;
    Ok(SourceFingerprint {
        size,
        modified_at: metadata.mtime.map(u128::from),
    })
}

async fn remote_partial_inspection(client: &SftpSession, path: &str) -> Result<PartialInspection> {
    if !client
        .try_exists(path.to_string())
        .await
        .map_err(remote_error)?
    {
        return Ok(PartialInspection {
            len: None,
            must_cleanup: false,
        });
    }
    let metadata = client
        .symlink_metadata(path.to_string())
        .await
        .map_err(remote_error)?;
    if metadata.is_symlink() {
        return Ok(PartialInspection {
            len: None,
            must_cleanup: true,
        });
    }
    if !metadata.file_type().is_file() {
        return Err(LumaError::SftpFailed(format!(
            "remote partial path is not a regular file: {path}"
        )));
    }
    Ok(PartialInspection {
        len: metadata.size,
        must_cleanup: false,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PartialInspection {
    len: Option<u64>,
    must_cleanup: bool,
}

async fn local_partial_inspection(path: &Path) -> Result<PartialInspection> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => Ok(PartialInspection {
            len: None,
            must_cleanup: true,
        }),
        Ok(metadata) if metadata.is_file() => Ok(PartialInspection {
            len: Some(metadata.len()),
            must_cleanup: false,
        }),
        Ok(_) => Err(LumaError::SftpFailed(format!(
            "local partial path is not a regular file: {}",
            path.display()
        ))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PartialInspection {
            len: None,
            must_cleanup: false,
        }),
        Err(error) => Err(LumaError::SftpFailed(format!(
            "could not inspect local partial file: {error}"
        ))),
    }
}

async fn prepare_upload(
    client: &SftpSession,
    record: &TransferRecord,
    key: &str,
    local_path: &Path,
    remote_temp: &str,
) -> Result<PreparedFile> {
    let metadata = tokio::fs::metadata(local_path).await.map_err(|error| {
        LumaError::SftpFailed(format!("could not inspect upload source: {error}"))
    })?;
    if !metadata.is_file() {
        return Err(LumaError::SftpFailed(
            "upload source is no longer a regular file".into(),
        ));
    }
    let source = local_source_fingerprint(&metadata);
    let partial = remote_partial_inspection(client, remote_temp).await?;
    let decision =
        record.prepare_checkpoint(key, source.clone(), remote_temp.to_string(), partial.len);
    if partial.must_cleanup || decision.cleanup_partial {
        client
            .remove_file(remote_temp.to_string())
            .await
            .map_err(remote_error)?;
    }
    Ok(PreparedFile {
        source,
        resume_from: decision.resume_from,
    })
}

async fn prepare_download(
    client: &SftpSession,
    record: &TransferRecord,
    key: &str,
    remote_path: &str,
    local_temp: &Path,
) -> Result<PreparedFile> {
    let metadata = client
        .symlink_metadata(remote_path.to_string())
        .await
        .map_err(remote_error)?;
    if !metadata.file_type().is_file() {
        return Err(LumaError::SftpFailed(
            "download source is no longer a regular file".into(),
        ));
    }
    let source = remote_source_fingerprint(&metadata)?;
    let partial = local_partial_inspection(local_temp).await?;
    let partial_path = local_temp.to_string_lossy().into_owned();
    let decision = record.prepare_checkpoint(key, source.clone(), partial_path, partial.len);
    if partial.must_cleanup || decision.cleanup_partial {
        tokio::fs::remove_file(local_temp).await.map_err(|error| {
            LumaError::SftpFailed(format!("could not remove stale partial download: {error}"))
        })?;
    }
    Ok(PreparedFile {
        source,
        resume_from: decision.resume_from,
    })
}

#[allow(clippy::too_many_arguments)]
async fn upload_task(
    client: Arc<SftpSession>,
    local_path: PathBuf,
    remote_path: String,
    remote_temp: String,
    total: Option<u64>,
    resume_from: u64,
    cancel: watch::Receiver<bool>,
    on_progress: impl FnMut(u64),
) -> TransferOutcome {
    let mut source = match tokio::fs::File::open(local_path).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: resume_from,
                message: format!("could not open upload source: {error}"),
            }
        }
    };
    if let Err(error) = source.seek(io::SeekFrom::Start(resume_from)).await {
        return TransferOutcome::Failed {
            transferred: resume_from,
            message: format!("could not seek upload source: {error}"),
        };
    }
    let flags = if resume_from == 0 {
        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
    } else {
        OpenFlags::WRITE
    };
    let mut destination = match client.open_with_flags(remote_temp.clone(), flags).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: resume_from,
                message: remote_error(error).to_string(),
            }
        }
    };
    if let Err(error) = destination.seek(io::SeekFrom::Start(resume_from)).await {
        return TransferOutcome::Failed {
            transferred: resume_from,
            message: format!("could not seek remote partial upload: {error}"),
        };
    }

    match copy_stream(
        &mut source,
        &mut destination,
        total,
        resume_from,
        cancel.clone(),
        on_progress,
    )
    .await
    {
        Ok(transferred) if *cancel.borrow() => TransferOutcome::Cancelled { transferred },
        Ok(transferred) => {
            match replace_remote_destination(&client, &remote_temp, &remote_path).await {
                Ok(()) => TransferOutcome::Completed { transferred },
                Err(error) => TransferOutcome::Failed {
                    transferred,
                    message: format!("could not finish upload: {error}"),
                },
            }
        }
        Err(CopyFailure::Cancelled { transferred }) => TransferOutcome::Cancelled { transferred },
        Err(CopyFailure::Io { transferred, error }) => TransferOutcome::Failed {
            transferred,
            message: format!("upload failed: {error}"),
        },
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_task(
    client: Arc<SftpSession>,
    remote_path: String,
    local_path: PathBuf,
    temp_path: PathBuf,
    total: Option<u64>,
    resume_from: u64,
    cancel: watch::Receiver<bool>,
    on_progress: impl FnMut(u64),
) -> TransferOutcome {
    let mut source = match client.open(remote_path).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: resume_from,
                message: remote_error(error).to_string(),
            }
        }
    };
    if let Err(error) = source.seek(io::SeekFrom::Start(resume_from)).await {
        return TransferOutcome::Failed {
            transferred: resume_from,
            message: format!("could not seek remote download source: {error}"),
        };
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true);
    if resume_from == 0 {
        options.create(true).truncate(true);
    } else {
        options.append(true);
    }
    let mut destination = match options.open(&temp_path).await {
        Ok(file) => file,
        Err(error) => {
            return TransferOutcome::Failed {
                transferred: resume_from,
                message: format!("could not open temporary download file: {error}"),
            }
        }
    };

    let result = copy_stream(
        &mut source,
        &mut destination,
        total,
        resume_from,
        cancel.clone(),
        on_progress,
    )
    .await;
    match result {
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
    }
}

async fn replace_remote_destination(
    client: &SftpSession,
    temp_path: &str,
    destination: &str,
) -> Result<()> {
    if !client
        .try_exists(destination.to_string())
        .await
        .map_err(remote_error)?
    {
        return client
            .rename(temp_path.to_string(), destination.to_string())
            .await
            .map_err(remote_error);
    }
    let metadata = client
        .symlink_metadata(destination.to_string())
        .await
        .map_err(remote_error)?;
    if metadata.is_dir() {
        return Err(LumaError::SftpFailed(
            "upload destination is a directory".into(),
        ));
    }
    let backup = format!("{destination}.luma-backup-{}", uuid::Uuid::new_v4());
    validate_remote_path(&backup)?;
    client
        .rename(destination.to_string(), backup.clone())
        .await
        .map_err(remote_error)?;
    if let Err(error) = client
        .rename(temp_path.to_string(), destination.to_string())
        .await
    {
        let _ = client.rename(backup, destination.to_string()).await;
        return Err(remote_error(error));
    }
    let _ = client.remove_file(backup).await;
    Ok(())
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

fn remote_partial_path(destination: &str) -> Result<String> {
    let path = format!("{destination}.luma-part");
    validate_remote_path(&path)?;
    Ok(path)
}

fn sibling_partial_path(destination: &Path) -> Result<PathBuf> {
    let parent = destination
        .parent()
        .ok_or_else(|| LumaError::InvalidInput("local path has no parent directory".into()))?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| LumaError::InvalidInput("local filename is invalid".into()))?;
    Ok(parent.join(format!("{name}.luma-part")))
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

impl TransferOutcome {
    fn transferred(&self) -> u64 {
        match self {
            Self::Completed { transferred }
            | Self::Failed { transferred, .. }
            | Self::Cancelled { transferred } => *transferred,
        }
    }
}

fn outcome_phase(outcome: &TransferOutcome) -> (TransferPhase, bool) {
    match outcome {
        TransferOutcome::Completed { .. } => (TransferPhase::Completed, false),
        TransferOutcome::Failed { .. } => (TransferPhase::Failed, true),
        TransferOutcome::Cancelled { .. } => (TransferPhase::Cancelled, true),
    }
}

fn emit_terminal(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    total: Option<u64>,
    outcome: TransferOutcome,
) {
    match outcome {
        TransferOutcome::Completed { transferred } => emit_progress(
            channel,
            transfer_id,
            transferred,
            total,
            "completed",
            None,
            None,
        ),
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
            None,
        ),
        TransferOutcome::Cancelled { transferred } => emit_progress(
            channel,
            transfer_id,
            transferred,
            total,
            "cancelled",
            None,
            None,
        ),
    }
}

fn emit_progress(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    transferred: u64,
    total: Option<u64>,
    state: &str,
    error_message: Option<String>,
    resumed_from: Option<u64>,
) {
    let _ = channel.send(TransferProgress {
        transfer_id: transfer_id.to_string(),
        transferred,
        total,
        state: state.to_string(),
        error_message,
        progress_kind: None,
        file_path: None,
        aggregate: None,
        resumed_from,
    });
}

#[allow(clippy::too_many_arguments)]
fn emit_file(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    file_path: &str,
    transferred: u64,
    total: Option<u64>,
    state: &str,
    error_message: Option<String>,
    aggregate: &AggregateTracker,
    resumed_from: Option<u64>,
) {
    let _ = channel.send(TransferProgress {
        transfer_id: transfer_id.to_string(),
        transferred,
        total,
        state: state.to_string(),
        error_message,
        progress_kind: Some("file".into()),
        file_path: Some(file_path.to_string()),
        aggregate: Some(aggregate.payload()),
        resumed_from,
    });
}

fn emit_entry(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    path: &str,
    state: &str,
    error_message: Option<String>,
) {
    let _ = channel.send(TransferProgress {
        transfer_id: transfer_id.to_string(),
        transferred: 0,
        total: None,
        state: state.to_string(),
        error_message,
        progress_kind: Some("entry".into()),
        file_path: Some(path.to_string()),
        aggregate: None,
        resumed_from: None,
    });
}

fn emit_aggregate(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    aggregate: &AggregateTracker,
    state: &str,
    error_message: Option<String>,
) {
    let payload = aggregate.payload();
    let _ = channel.send(TransferProgress {
        transfer_id: transfer_id.to_string(),
        transferred: payload.bytes_done,
        total: Some(payload.total_bytes),
        state: state.to_string(),
        error_message,
        progress_kind: Some("aggregate".into()),
        file_path: payload.current_file_path.clone(),
        aggregate: Some(payload),
        resumed_from: None,
    });
}

fn emit_directory_terminal(
    channel: &Channel<TransferProgress>,
    transfer_id: &str,
    aggregate: AggregateTracker,
    phase: TransferPhase,
    error_message: Option<String>,
) {
    let state = match phase {
        TransferPhase::Running => "running",
        TransferPhase::Completed => "completed",
        TransferPhase::Failed => "failed",
        TransferPhase::Cancelled => "cancelled",
    };
    emit_aggregate(channel, transfer_id, &aggregate, state, error_message);
}

fn display_relative(path: &str) -> String {
    if path.is_empty() {
        ".".into()
    } else {
        path.to_string()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct AggregateTracker {
    total_bytes: u64,
    completed_bytes: u64,
    total_files: u64,
    files_done: u64,
    current_file_path: Option<String>,
}

impl AggregateTracker {
    fn new(sizes: impl IntoIterator<Item = u64>) -> Self {
        let sizes = sizes.into_iter().collect::<Vec<_>>();
        Self {
            total_bytes: sizes.iter().copied().sum(),
            total_files: sizes.len() as u64,
            ..Self::default()
        }
    }

    fn begin_file(&mut self, path: String) {
        self.current_file_path = Some(path);
    }

    fn current(&self, transferred: u64) -> Self {
        let mut current = self.clone();
        current.completed_bytes = current.completed_bytes.saturating_add(transferred);
        current
    }

    fn finish_file(&mut self, transferred: u64) {
        self.completed_bytes = self.completed_bytes.saturating_add(transferred);
        self.files_done = self.files_done.saturating_add(1);
    }

    fn payload(&self) -> AggregateTransferProgress {
        AggregateTransferProgress {
            total_bytes: self.total_bytes,
            bytes_done: self.completed_bytes.min(self.total_bytes),
            total_files: self.total_files,
            files_done: self.files_done.min(self.total_files),
            current_file_path: self.current_file_path.clone(),
        }
    }
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
    initial_transferred: u64,
    mut cancel: watch::Receiver<bool>,
    mut on_progress: impl FnMut(u64),
) -> std::result::Result<u64, CopyFailure>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut buffer = vec![0_u8; TRANSFER_CHUNK_BYTES];
    let mut transferred = initial_transferred;
    let mut gate = ProgressGate::new(Instant::now(), initial_transferred);

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
    fn new(now: Instant, initial_bytes: u64) -> Self {
        Self {
            last_emitted_at: now,
            last_emitted_bytes: initial_bytes,
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
            0,
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
    fn aggregate_progress_accounts_for_current_and_finished_files() {
        let mut aggregate = AggregateTracker::new([10, 20]);
        aggregate.begin_file("one.txt".into());
        assert_eq!(
            aggregate.current(4).payload(),
            AggregateTransferProgress {
                total_bytes: 30,
                bytes_done: 4,
                total_files: 2,
                files_done: 0,
                current_file_path: Some("one.txt".into()),
            }
        );
        aggregate.finish_file(10);
        aggregate.begin_file("two.txt".into());
        assert_eq!(aggregate.current(5).payload().bytes_done, 15);
        aggregate.finish_file(20);
        let final_progress = aggregate.payload();
        assert_eq!(final_progress.bytes_done, 30);
        assert_eq!(final_progress.files_done, 2);
    }

    #[test]
    fn retry_records_share_completed_entry_state() {
        let original = TransferRecord::new(
            "session".into(),
            TransferDescriptor::Upload {
                local_path: PathBuf::from("source"),
                remote_path: "/destination".into(),
                is_directory: true,
            },
        );
        original.mark_file_completed("done.txt".into());
        original.finish(TransferPhase::Failed, true);
        let retry = original.for_retry().unwrap();
        assert!(retry.completed_file("done.txt"));
        retry.mark_file_completed("retried.txt".into());
        retry.finish(TransferPhase::Completed, false);
        assert!(original.completed_file("retried.txt"));
        assert!(original.for_retry().is_err());
    }

    #[test]
    fn resumed_from_serializes_only_when_present() {
        let progress = TransferProgress {
            transfer_id: "transfer".into(),
            transferred: 40,
            total: Some(100),
            state: "running".into(),
            error_message: None,
            progress_kind: Some("file".into()),
            file_path: Some("large.bin".into()),
            aggregate: None,
            resumed_from: Some(40),
        };
        let value = serde_json::to_value(progress).unwrap();
        assert_eq!(value["resumedFrom"], 40);
    }

    #[test]
    fn checkpoint_validation_resumes_only_unchanged_sources() {
        let source = SourceFingerprint {
            size: 100,
            modified_at: Some(42),
        };
        let checkpoint = FileCheckpoint {
            source: source.clone(),
            partial_path: "/dest.luma-part".into(),
        };
        assert_eq!(
            checkpoint_decision(
                true,
                Some(&checkpoint),
                &source,
                "/dest.luma-part",
                Some(40),
            ),
            CheckpointDecision {
                resume_from: 40,
                cleanup_partial: false,
            }
        );

        for changed in [
            SourceFingerprint {
                size: 101,
                modified_at: Some(42),
            },
            SourceFingerprint {
                size: 100,
                modified_at: Some(43),
            },
            SourceFingerprint {
                size: 100,
                modified_at: None,
            },
        ] {
            assert_eq!(
                checkpoint_decision(
                    true,
                    Some(&checkpoint),
                    &changed,
                    "/dest.luma-part",
                    Some(40),
                ),
                CheckpointDecision {
                    resume_from: 0,
                    cleanup_partial: true,
                }
            );
        }
        assert_eq!(
            checkpoint_decision(
                false,
                Some(&checkpoint),
                &source,
                "/dest.luma-part",
                Some(40),
            ),
            CheckpointDecision {
                resume_from: 0,
                cleanup_partial: true,
            }
        );
    }

    #[test]
    fn resumed_aggregate_starts_at_checkpoint_offset() {
        let mut aggregate = AggregateTracker::new([100]);
        aggregate.begin_file("large.bin".into());
        assert_eq!(aggregate.current(40).payload().bytes_done, 40);
        aggregate.finish_file(100);
        assert_eq!(aggregate.payload().bytes_done, 100);
    }

    #[tokio::test]
    async fn local_download_uses_stable_partial_then_renames_on_success() {
        let directory = std::env::temp_dir().join(format!(
            "luma-transfer-partial-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let destination = directory.join("archive.bin");
        let partial = sibling_partial_path(&destination).unwrap();
        assert_eq!(partial, directory.join("archive.bin.luma-part"));
        tokio::fs::write(&destination, b"old").await.unwrap();
        tokio::fs::write(&partial, b"complete").await.unwrap();

        replace_destination(&partial, &destination).await.unwrap();

        assert_eq!(tokio::fs::read(&destination).await.unwrap(), b"complete");
        assert!(!tokio::fs::try_exists(&partial).await.unwrap());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn successful_directory_cleanup_removes_owned_orphan_partial() {
        let directory = std::env::temp_dir().join(format!(
            "luma-transfer-cleanup-test-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let partial = directory.join("removed.bin.luma-part");
        tokio::fs::write(&partial, b"partial").await.unwrap();
        let record = TransferRecord::new(
            "session".into(),
            TransferDescriptor::Download {
                remote_path: "/source".into(),
                local_path: directory.clone(),
                app_data_dir: directory.join("app-data"),
                is_directory: true,
            },
        );
        record.prepare_checkpoint(
            "removed.bin",
            SourceFingerprint {
                size: 10,
                modified_at: Some(1),
            },
            partial.to_string_lossy().into_owned(),
            Some(7),
        );

        cleanup_local_checkpoints(&record).await.unwrap();

        assert!(!tokio::fs::try_exists(&partial).await.unwrap());
        assert!(record.checkpoints().is_empty());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn copy_stream_counts_resumed_bytes_from_checkpoint() {
        let mut reader = Cursor::new(vec![1_u8; 60]);
        let mut writer = Cursor::new(Vec::new());
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let transferred = copy_stream(&mut reader, &mut writer, Some(100), 40, cancel_rx, |_| {})
            .await
            .unwrap();
        assert_eq!(transferred, 100);
        assert_eq!(writer.into_inner().len(), 60);
    }

    #[test]
    fn progress_gate_throttles_by_time_or_bytes() {
        let start = Instant::now();
        let mut gate = ProgressGate::new(start, 0);
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

        let error = copy_stream(&mut reader, &mut writer, None, 0, cancel_rx, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(error, CopyFailure::Cancelled { transferred: 0 }));
        assert!(writer.into_inner().is_empty());
    }
}
