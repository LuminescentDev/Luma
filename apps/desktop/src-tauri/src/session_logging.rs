use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use chrono::Utc;
use serde::Serialize;

use crate::errors::{LumaError, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionLogMode {
    Raw,
    Asciicast,
}

impl SessionLogMode {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "raw" => Ok(Self::Raw),
            "asciicast" => Ok(Self::Asciicast),
            _ => Err(LumaError::InvalidInput(
                "mode must be either raw or asciicast".into(),
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Raw => "raw",
            Self::Asciicast => "asciicast",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Raw => "log",
            Self::Asciicast => "cast",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLogStatus {
    pub active: bool,
    pub mode: Option<String>,
    pub path: Option<String>,
    pub bytes_written: u64,
}

struct SessionRegistration {
    cols: u16,
    rows: u16,
    active: Option<ActiveLog>,
}

struct ActiveLog {
    mode: SessionLogMode,
    path: PathBuf,
    writer: BufWriter<File>,
    started_at: Instant,
    bytes_written: u64,
}

#[derive(Clone, Default)]
pub struct SessionLogManager {
    sessions: Arc<Mutex<HashMap<String, SessionRegistration>>>,
}

impl SessionLogManager {
    pub fn register(&self, session_id: &str, cols: u16, rows: u16) {
        self.sessions.lock().unwrap().insert(
            session_id.to_string(),
            SessionRegistration {
                cols,
                rows,
                active: None,
            },
        );
    }

    pub fn update_dimensions(&self, session_id: &str, cols: u16, rows: u16) {
        if let Some(session) = self.sessions.lock().unwrap().get_mut(session_id) {
            session.cols = cols;
            session.rows = rows;
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    pub fn start(
        &self,
        session_id: &str,
        mode: SessionLogMode,
        requested_path: Option<&str>,
        app_data_dir: &Path,
    ) -> Result<PathBuf> {
        let path = resolve_log_path(session_id, mode, requested_path, app_data_dir)?;
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown terminal session".into()))?;
        if session.active.is_some() {
            return Err(LumaError::InvalidInput(
                "session logging is already active".into(),
            ));
        }

        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .map_err(|error| LumaError::Pty(format!("could not create session log: {error}")))?;
        let mut active = ActiveLog {
            mode,
            path: path.clone(),
            writer: BufWriter::new(file),
            started_at: Instant::now(),
            bytes_written: 0,
        };
        if mode == SessionLogMode::Asciicast {
            let header = serde_json::json!({
                "version": 2,
                "width": session.cols,
                "height": session.rows,
                "timestamp": SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            });
            write_json_line(&mut active, &header)?;
        }
        session.active = Some(active);
        tracing::info!(session_id = %session_id, path = %path.display(), mode = mode.as_str(), "started session logging");
        Ok(path)
    }

    pub fn stop(&self, session_id: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown terminal session".into()))?;
        let mut active = session
            .active
            .take()
            .ok_or_else(|| LumaError::InvalidInput("session logging is not active".into()))?;
        active
            .writer
            .flush()
            .map_err(|error| LumaError::Pty(format!("could not flush session log: {error}")))?;
        tracing::info!(session_id = %session_id, path = %active.path.display(), "stopped session logging");
        Ok(())
    }

    pub fn status(&self, session_id: &str) -> Result<SessionLogStatus> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown terminal session".into()))?;
        Ok(match &session.active {
            Some(active) => SessionLogStatus {
                active: true,
                mode: Some(active.mode.as_str().into()),
                path: Some(path_to_string(&active.path)?),
                bytes_written: active.bytes_written,
            },
            None => SessionLogStatus {
                active: false,
                mode: None,
                path: None,
                bytes_written: 0,
            },
        })
    }

    pub fn write(&self, session_id: &str, bytes: &[u8]) {
        let mut sessions = self.sessions.lock().unwrap();
        let Some(active) = sessions
            .get_mut(session_id)
            .and_then(|session| session.active.as_mut())
        else {
            return;
        };
        let result: Result<u64> = match active.mode {
            SessionLogMode::Raw => active
                .writer
                .write_all(bytes)
                .map(|_| bytes.len() as u64)
                .map_err(|error| LumaError::Pty(format!("could not write session log: {error}"))),
            SessionLogMode::Asciicast => {
                let event = serde_json::json!([
                    active.started_at.elapsed().as_secs_f64(),
                    "o",
                    String::from_utf8_lossy(bytes),
                ]);
                write_json_line(active, &event).map(|_| 0)
            }
        };
        match result {
            Ok(written) => active.bytes_written = active.bytes_written.saturating_add(written),
            Err(error) => {
                tracing::warn!(session_id = %session_id, path = %active.path.display(), %error, "session logging stopped after a write failure");
                if let Some(session) = sessions.get_mut(session_id) {
                    session.active = None;
                }
            }
        }
    }

    pub fn unregister(&self, session_id: &str) {
        let active = self
            .sessions
            .lock()
            .unwrap()
            .remove(session_id)
            .and_then(|session| session.active);
        if let Some(mut active) = active {
            let _ = active.writer.flush();
            tracing::info!(session_id = %session_id, path = %active.path.display(), "closed session log on exit");
        }
    }
}

fn write_json_line<T: Serialize>(active: &mut ActiveLog, value: &T) -> Result<()> {
    let mut encoded = serde_json::to_vec(value)
        .map_err(|error| LumaError::Pty(format!("could not encode session log event: {error}")))?;
    encoded.push(b'\n');
    active
        .writer
        .write_all(&encoded)
        .map_err(|error| LumaError::Pty(format!("could not write session log: {error}")))?;
    active.bytes_written = active.bytes_written.saturating_add(encoded.len() as u64);
    Ok(())
}

fn resolve_log_path(
    session_id: &str,
    mode: SessionLogMode,
    requested_path: Option<&str>,
    app_data_dir: &Path,
) -> Result<PathBuf> {
    if let Some(path) = requested_path {
        return validate_requested_path(path);
    }

    let directory = app_data_dir.join("session-logs");
    fs::create_dir_all(&directory).map_err(|error| {
        LumaError::Pty(format!("could not create session log directory: {error}"))
    })?;
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S-%3f");
    let short_id = session_id.get(..8).unwrap_or(session_id);
    Ok(directory.join(format!("luma-{timestamp}-{short_id}.{}", mode.extension())))
}

fn validate_requested_path(value: &str) -> Result<PathBuf> {
    if value.is_empty() || value.contains('\0') {
        return Err(LumaError::InvalidInput("log path is invalid".into()));
    }
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(LumaError::InvalidInput("log path must be absolute".into()));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
    {
        return Err(LumaError::InvalidInput(
            "log path may not contain traversal components".into(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| LumaError::InvalidInput("log path has no parent directory".into()))?;
    let parent = parent
        .canonicalize()
        .map_err(|_| LumaError::InvalidInput("log path parent directory does not exist".into()))?;
    if !parent.is_dir() {
        return Err(LumaError::InvalidInput(
            "log path parent must be a directory".into(),
        ));
    }
    let name = path
        .file_name()
        .ok_or_else(|| LumaError::InvalidInput("log path has no filename".into()))?;
    let resolved = parent.join(name);
    if resolved.is_dir() {
        return Err(LumaError::InvalidInput(
            "log path must identify a file".into(),
        ));
    }
    Ok(resolved)
}

fn path_to_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| LumaError::InvalidInput("log path is not valid Unicode".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_traversal_paths() {
        assert!(validate_requested_path("relative.log").is_err());
        let base = std::env::temp_dir();
        let traversal = base.join("folder").join("..").join("output.log");
        assert!(validate_requested_path(&traversal.to_string_lossy()).is_err());
    }

    #[test]
    fn writes_asciicast_header_and_event() {
        let base = std::env::temp_dir().join(format!("luma-log-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&base).unwrap();
        let path = base.join("test.cast");
        let logs = SessionLogManager::default();
        logs.register("session", 100, 40);
        logs.start(
            "session",
            SessionLogMode::Asciicast,
            Some(path.to_str().unwrap()),
            &base,
        )
        .unwrap();
        logs.write("session", b"hello\n");
        logs.stop("session").unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        let lines = contents.lines().collect::<Vec<_>>();
        let header: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(header["version"], 2);
        assert_eq!(header["width"], 100);
        let event: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(event[1], "o");
        assert_eq!(event[2], "hello\n");
        fs::remove_dir_all(base).unwrap();
    }
}
