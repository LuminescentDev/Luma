use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use serde::Serialize;
use sqlx::Row;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Semaphore};

use crate::errors::{LumaError, Result};
use crate::ssh::{self, SshBackend};
use crate::vault::VaultState;
use crate::AppState;

const DEFAULT_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 600;
const MAX_HOSTS: usize = 50;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES_PER_HOST: usize = 1024 * 1024;
const MAX_PARALLEL_HOSTS: usize = 4;
const EPHEMERAL_MAX_AGE_SECS: i64 = 7 * 24 * 60 * 60;
const OUTPUT_TRUNCATED_MARKER: &str = "\n[output truncated after 1048576 bytes]\n";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRunStartResponse {
    pub run_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SnippetRunEventKind {
    Started,
    Stdout,
    Stderr,
    Finished,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetRunEvent {
    pub run_id: String,
    pub host_id: String,
    pub kind: SnippetRunEventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<Option<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
}

impl SnippetRunEvent {
    fn started(run_id: &str, host_id: &str) -> Self {
        Self {
            run_id: run_id.into(),
            host_id: host_id.into(),
            kind: SnippetRunEventKind::Started,
            data: None,
            exit_code: None,
            error_category: None,
            error_message: None,
        }
    }

    fn output(run_id: &str, host_id: &str, kind: SnippetRunEventKind, data: String) -> Self {
        Self {
            run_id: run_id.into(),
            host_id: host_id.into(),
            kind,
            data: Some(data),
            exit_code: None,
            error_category: None,
            error_message: None,
        }
    }

    fn finished(run_id: &str, host_id: &str, exit_code: Option<u32>) -> Self {
        Self {
            run_id: run_id.into(),
            host_id: host_id.into(),
            kind: SnippetRunEventKind::Finished,
            data: None,
            exit_code: Some(exit_code),
            error_category: None,
            error_message: None,
        }
    }

    fn failed(run_id: &str, host_id: &str, category: &str, message: String) -> Self {
        Self {
            run_id: run_id.into(),
            host_id: host_id.into(),
            kind: SnippetRunEventKind::Failed,
            data: None,
            exit_code: None,
            error_category: Some(category.into()),
            error_message: Some(message),
        }
    }
}

#[derive(Default)]
pub struct SnippetRunManager {
    runs: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
}

impl SnippetRunManager {
    pub fn cancel(&self, run_id: &str) -> Result<()> {
        ssh::validate_host_id(run_id)?;
        let runs = self.runs.lock().unwrap();
        let cancel = runs
            .get(run_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown snippet run".into()))?;
        let _ = cancel.send(true);
        Ok(())
    }

    pub fn kill_all(&self) {
        for (_, cancel) in self.runs.lock().unwrap().drain() {
            let _ = cancel.send(true);
        }
    }
}

pub async fn start(
    app: AppHandle,
    manager: &SnippetRunManager,
    snippet_command: String,
    host_ids: Vec<String>,
    timeout_secs: Option<u64>,
    on_event: Channel<SnippetRunEvent>,
) -> Result<SnippetRunStartResponse> {
    let timeout_secs = validate_request(&snippet_command, &host_ids, timeout_secs)?;
    validate_hosts(&app.state::<AppState>().pool, &host_ids).await?;

    let run_id = uuid::Uuid::new_v4().to_string();
    let (cancel, cancel_rx) = watch::channel(false);
    manager.runs.lock().unwrap().insert(run_id.clone(), cancel);

    let runs = Arc::clone(&manager.runs);
    let task_run_id = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let semaphore = Arc::new(Semaphore::new(MAX_PARALLEL_HOSTS));
        let mut tasks = Vec::with_capacity(host_ids.len());
        for host_id in host_ids {
            let app = app.clone();
            let semaphore = Arc::clone(&semaphore);
            let command = snippet_command.clone();
            let event_channel = on_event.clone();
            let run_id = task_run_id.clone();
            let mut host_cancel = cancel_rx.clone();
            tasks.push(tauri::async_runtime::spawn(async move {
                let permit = tokio::select! {
                    biased;
                    _ = host_cancel.changed() => {
                        send_failed(&event_channel, &run_id, &host_id, "connection-lost", "Snippet run cancelled");
                        return;
                    }
                    permit = Arc::clone(&semaphore).acquire_owned() => match permit {
                        Ok(permit) => permit,
                        Err(_) => return,
                    }
                };
                let _permit = permit;
                if *host_cancel.borrow() {
                    send_failed(&event_channel, &run_id, &host_id, "connection-lost", "Snippet run cancelled");
                    return;
                }
                let _ = event_channel.send(SnippetRunEvent::started(&run_id, &host_id));
                run_host(
                    app,
                    &run_id,
                    &host_id,
                    &command,
                    Duration::from_secs(timeout_secs),
                    host_cancel,
                    event_channel,
                )
                .await;
            }));
        }
        for task in tasks {
            let _ = task.await;
        }
        runs.lock().unwrap().remove(&task_run_id);
    });

    Ok(SnippetRunStartResponse { run_id })
}

fn validate_request(command: &str, host_ids: &[String], timeout_secs: Option<u64>) -> Result<u64> {
    if command.trim().is_empty() || command.contains('\0') || command.len() > MAX_COMMAND_BYTES {
        return Err(LumaError::InvalidInput(format!(
            "snippetCommand must be non-empty, at most {MAX_COMMAND_BYTES} bytes, and contain no null characters"
        )));
    }
    if host_ids.is_empty() || host_ids.len() > MAX_HOSTS {
        return Err(LumaError::InvalidInput(format!(
            "hostIds must contain between 1 and {MAX_HOSTS} hosts"
        )));
    }
    let mut unique = HashSet::with_capacity(host_ids.len());
    for host_id in host_ids {
        ssh::validate_host_id(host_id)?;
        if !unique.insert(host_id) {
            return Err(LumaError::InvalidInput(
                "hostIds must not contain duplicates".into(),
            ));
        }
    }
    let timeout_secs = timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    if !(1..=MAX_TIMEOUT_SECS).contains(&timeout_secs) {
        return Err(LumaError::InvalidInput(format!(
            "timeoutSecs must be between 1 and {MAX_TIMEOUT_SECS}"
        )));
    }
    Ok(timeout_secs)
}

async fn validate_hosts(pool: &sqlx::SqlitePool, host_ids: &[String]) -> Result<()> {
    for host_id in host_ids {
        let row = sqlx::query("SELECT is_ephemeral, created_at FROM hosts WHERE id = ?1")
            .bind(host_id)
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| LumaError::InvalidInput(format!("unknown hostId: {host_id}")))?;
        let is_ephemeral = row.get::<i64, _>("is_ephemeral") != 0;
        let created_at: i64 = row.get("created_at");
        if is_ephemeral
            && created_at
                < chrono::Utc::now()
                    .timestamp()
                    .saturating_sub(EPHEMERAL_MAX_AGE_SECS)
        {
            return Err(LumaError::InvalidInput(format!(
                "ephemeral host has expired: {host_id}"
            )));
        }
    }
    Ok(())
}

async fn run_host(
    app: AppHandle,
    run_id: &str,
    host_id: &str,
    command: &str,
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
    on_event: Channel<SnippetRunEvent>,
) {
    let operation = async {
        let state = app.state::<AppState>();
        let vault = app.state::<VaultState>();
        let (mut config, _) = ssh::connection_config(&state.pool, &vault, host_id).await?;
        config.startup_command = None;
        if ssh::select_backend(&config) != SshBackend::Embedded {
            return Err(LumaError::SshConnection {
                category: "unsupported",
                message: "Non-interactive snippet execution is unavailable for hosts that require system OpenSSH".into(),
            });
        }

        let handle = ssh::authenticated_handle(&config).await?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(ssh::embedded_connect_error)?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(ssh::embedded_connect_error)?;

        let mut output_cap = OutputCap::new(MAX_OUTPUT_BYTES_PER_HOST);
        let mut exit_code = None;
        let mut disappeared = false;
        loop {
            let Some(message) = channel.wait().await else {
                disappeared = true;
                break;
            };
            match message {
                ChannelMsg::Data { data } => emit_capped_output(
                    &on_event,
                    run_id,
                    host_id,
                    SnippetRunEventKind::Stdout,
                    &data,
                    &mut output_cap,
                ),
                ChannelMsg::ExtendedData { data, .. } => emit_capped_output(
                    &on_event,
                    run_id,
                    host_id,
                    SnippetRunEventKind::Stderr,
                    &data,
                    &mut output_cap,
                ),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        if handle.is_closed() && exit_code.is_none() {
            disappeared = true;
        }
        if disappeared {
            Err(LumaError::SshConnection {
                category: "connection-lost",
                message: "The SSH transport closed before the remote command finished".into(),
            })
        } else {
            Ok(exit_code)
        }
    };

    tokio::pin!(operation);
    let timeout_sleep = tokio::time::sleep(timeout);
    tokio::pin!(timeout_sleep);
    let result = tokio::select! {
        biased;
        changed = cancel.changed() => {
            if changed.is_ok() && *cancel.borrow() {
                Err(LumaError::SshConnection {
                    category: "connection-lost",
                    message: "Snippet run cancelled".into(),
                })
            } else {
                operation.await
            }
        }
        result = &mut operation => result,
        _ = &mut timeout_sleep => Err(timeout_error(timeout)),
    };

    match result {
        Ok(exit_code) => {
            let _ = on_event.send(SnippetRunEvent::finished(run_id, host_id, exit_code));
        }
        Err(error) => {
            let (category, message) = event_error(&error);
            send_failed(&on_event, run_id, host_id, category, &message);
        }
    }
}

fn timeout_error(timeout: Duration) -> LumaError {
    LumaError::SshConnection {
        category: "timeout",
        message: format!(
            "Snippet execution timed out after {} seconds",
            timeout.as_secs()
        ),
    }
}

fn event_error(error: &LumaError) -> (&'static str, String) {
    let category = match error.category() {
        "auth-failed" | "authentication" | "key-unavailable" | "vault-locked" => "auth-failed",
        "dns-failed" | "host-unreachable" => "host-unreachable",
        "timeout" => "timeout",
        "unsupported" | "ssh-unavailable" => "unsupported",
        "connection-lost" => "connection-lost",
        "host-key-changed" => "host-key-changed",
        "host-key" | "host-key-rejected" | "host-key-file-invalid" => "host-key-rejected",
        _ => "ssh-error",
    };
    (category, error.to_string())
}

fn send_failed(
    channel: &Channel<SnippetRunEvent>,
    run_id: &str,
    host_id: &str,
    category: &str,
    message: &str,
) {
    let _ = channel.send(SnippetRunEvent::failed(
        run_id,
        host_id,
        category,
        message.to_string(),
    ));
}

fn emit_capped_output(
    channel: &Channel<SnippetRunEvent>,
    run_id: &str,
    host_id: &str,
    kind: SnippetRunEventKind,
    data: &[u8],
    cap: &mut OutputCap,
) {
    let accepted = cap.accept(data);
    if !accepted.bytes.is_empty() {
        let _ = channel.send(SnippetRunEvent::output(
            run_id,
            host_id,
            kind,
            String::from_utf8_lossy(accepted.bytes).into_owned(),
        ));
    }
    if accepted.emit_marker {
        let _ = channel.send(SnippetRunEvent::output(
            run_id,
            host_id,
            kind,
            OUTPUT_TRUNCATED_MARKER.into(),
        ));
    }
}

#[derive(Debug, PartialEq, Eq)]
struct AcceptedOutput<'a> {
    bytes: &'a [u8],
    emit_marker: bool,
}

#[derive(Debug)]
struct OutputCap {
    remaining: usize,
    marker_emitted: bool,
}

impl OutputCap {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            marker_emitted: false,
        }
    }

    fn accept<'a>(&mut self, data: &'a [u8]) -> AcceptedOutput<'a> {
        let accepted = data.len().min(self.remaining);
        self.remaining -= accepted;
        let truncated = accepted < data.len();
        let emit_marker = truncated && !self.marker_emitted;
        self.marker_emitted |= truncated;
        AcceptedOutput {
            bytes: &data[..accepted],
            emit_marker,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_multi_host_request() {
        assert_eq!(
            validate_request("uptime", &["one".into()], None).unwrap(),
            DEFAULT_TIMEOUT_SECS
        );
        assert!(validate_request(" ", &["one".into()], None).is_err());
        assert!(validate_request("echo\0bad", &["one".into()], None).is_err());
        assert!(validate_request("uptime", &[], None).is_err());
        assert!(validate_request("uptime", &["one".into(), "one".into()], None).is_err());
        assert!(validate_request("uptime", &["one".into()], Some(0)).is_err());
        assert!(validate_request("uptime", &["one".into()], Some(601)).is_err());
    }

    #[test]
    fn serializes_event_contract_shapes() {
        assert_eq!(
            serde_json::to_value(SnippetRunEvent::started("run", "host")).unwrap(),
            serde_json::json!({"runId":"run","hostId":"host","kind":"started"})
        );
        assert_eq!(
            serde_json::to_value(SnippetRunEvent::output(
                "run",
                "host",
                SnippetRunEventKind::Stdout,
                "ok\n".into(),
            ))
            .unwrap(),
            serde_json::json!({"runId":"run","hostId":"host","kind":"stdout","data":"ok\n"})
        );
        assert_eq!(
            serde_json::to_value(SnippetRunEvent::finished("run", "host", None)).unwrap(),
            serde_json::json!({"runId":"run","hostId":"host","kind":"finished","exitCode":null})
        );
        assert_eq!(
            serde_json::to_value(SnippetRunEvent::failed(
                "run",
                "host",
                "timeout",
                "timed out".into(),
            ))
            .unwrap(),
            serde_json::json!({
                "runId":"run",
                "hostId":"host",
                "kind":"failed",
                "errorCategory":"timeout",
                "errorMessage":"timed out"
            })
        );
    }

    #[test]
    fn output_cap_truncates_once_across_streams() {
        let mut cap = OutputCap::new(5);
        assert_eq!(
            cap.accept(b"abc"),
            AcceptedOutput {
                bytes: b"abc",
                emit_marker: false,
            }
        );
        assert_eq!(
            cap.accept(b"def"),
            AcceptedOutput {
                bytes: b"de",
                emit_marker: true,
            }
        );
        assert_eq!(
            cap.accept(b"more"),
            AcceptedOutput {
                bytes: b"",
                emit_marker: false,
            }
        );
    }
}
