pub(crate) mod logging;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::errors::{LumaError, Result};

use logging::SessionLogManager;
pub use logging::{SessionLogMode, SessionLogStatus};

const MAX_INPUT_BYTES: usize = 1024 * 1024;
const READ_BUFFER_BYTES: usize = 64 * 1024;

/// A shell command fully resolved by the backend (from a detected shell or a
/// stored profile). The frontend never passes raw executable paths to spawn.
pub struct ResolvedShell {
    pub path: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: HashMap<String, String>,
}

struct PtySession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, Arc<PtySession>>>>,
    logs: SessionLogManager,
}

impl PtyManager {
    /// Spawn a shell attached to a new PTY. Output bytes are delivered on a
    /// dedicated reader thread through `on_data`; `on_exit` fires once with
    /// the exit code after the process ends and the session is cleaned up.
    pub fn spawn(
        &self,
        shell: ResolvedShell,
        cols: u16,
        rows: u16,
        mut on_data: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(Option<u32>) + Send + 'static,
    ) -> Result<String> {
        if shell.path.trim().is_empty() {
            return Err(LumaError::InvalidInput("shell path is empty".into()));
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.clamp(2, 500),
                cols: cols.clamp(2, 1000),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| LumaError::Pty(format!("failed to open pty: {e}")))?;

        let mut cmd = CommandBuilder::new(&shell.path);
        cmd.args(&shell.args);

        let cwd = match &shell.working_directory {
            Some(dir) => {
                let path = PathBuf::from(dir);
                if !path.is_dir() {
                    return Err(LumaError::InvalidInput(format!(
                        "working directory does not exist: {dir}"
                    )));
                }
                path
            }
            None => home_dir().unwrap_or_else(|| PathBuf::from(".")),
        };
        cmd.cwd(cwd);

        #[cfg(not(windows))]
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Luma");
        for (key, value) in &shell.environment {
            cmd.env(key, value);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| LumaError::Pty(format!("failed to spawn shell: {e}")))?;
        drop(pair.slave);

        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| LumaError::Pty(format!("failed to open pty reader: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| LumaError::Pty(format!("failed to open pty writer: {e}")))?;

        let id = uuid::Uuid::new_v4().to_string();
        let session = Arc::new(PtySession {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            killer: Mutex::new(killer),
        });
        self.sessions.lock().unwrap().insert(id.clone(), session);
        self.logs.register(&id, cols, rows);

        // Waiter thread: reaps the child, then drops the session so the PTY
        // master closes. On Windows the ConPTY reader only unblocks with EOF
        // once the pseudo console is closed, so this ordering matters.
        let (exit_tx, exit_rx) = std::sync::mpsc::channel::<Option<u32>>();
        let sessions = Arc::clone(&self.sessions);
        let wait_id = id.clone();
        std::thread::Builder::new()
            .name(format!("pty-wait-{wait_id}"))
            .spawn(move || {
                let code = child.wait().ok().map(|status| status.exit_code());
                let _ = exit_tx.send(code);
                sessions.lock().unwrap().remove(&wait_id);
                tracing::info!("pty session {wait_id} exited with code {code:?}");
            })
            .map_err(|e| LumaError::Pty(format!("failed to start wait thread: {e}")))?;

        // Reader thread: drains output until the PTY closes, then reports the
        // exit code collected by the waiter.
        let reader_id = id.clone();
        let logs = self.logs.clone();
        std::thread::Builder::new()
            .name(format!("pty-reader-{reader_id}"))
            .spawn(move || {
                let mut buf = vec![0u8; READ_BUFFER_BYTES];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            logs.write(&reader_id, &buf[..n]);
                            on_data(&buf[..n]);
                        }
                    }
                }
                logs.unregister(&reader_id);
                let code = exit_rx.recv().ok().flatten();
                on_exit(code);
            })
            .map_err(|e| LumaError::Pty(format!("failed to start reader thread: {e}")))?;

        tracing::info!("spawned pty session {id} ({})", shell.path);
        Ok(id)
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        if self.write_if_present(session_id, data.as_bytes())? {
            return Ok(());
        }
        Err(LumaError::InvalidInput("unknown terminal session".into()))
    }

    /// Write without turning a missing id into an error. Commands shared by
    /// native PTYs and embedded SSH use this fast path to route the overwhelmingly
    /// common local/OpenSSH case without first touching the SSH manager.
    pub fn write_if_present(&self, session_id: &str, data: &[u8]) -> Result<bool> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(LumaError::InvalidInput("input too large".into()));
        }
        let Some(session) = self.sessions.lock().unwrap().get(session_id).cloned() else {
            return Ok(false);
        };
        let mut writer = session.writer.lock().unwrap();
        writer
            .write_all(data)
            .map_err(|e| LumaError::Pty(format!("write failed: {e}")))?;
        Ok(true)
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let session = self.get(session_id)?;
        let rows = rows.clamp(2, 500);
        let cols = cols.clamp(2, 1000);
        let result = session.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
        result.map_err(|e| LumaError::Pty(format!("resize failed: {e}")))?;
        self.logs.update_dimensions(session_id, cols, rows);
        Ok(())
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

    pub fn kill(&self, session_id: &str) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(session_id)
            .ok_or_else(|| LumaError::InvalidInput("unknown terminal session".into()))?;
        // Best-effort terminate; dropping the session below closes the PTY,
        // which ends the attached process group on every platform.
        let _ = session.killer.lock().unwrap().kill();
        drop(session);
        Ok(())
    }

    /// Kill every running session; used during application shutdown so no
    /// child processes outlive the app.
    pub fn kill_all(&self) {
        let sessions: Vec<(String, Arc<PtySession>)> =
            self.sessions.lock().unwrap().drain().collect();
        for (id, session) in sessions {
            let _ = session.killer.lock().unwrap().kill();
            drop(session);
            tracing::info!("killed pty session {id} on shutdown");
        }
    }

    fn get(&self, session_id: &str) -> Result<Arc<PtySession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| LumaError::InvalidInput("unknown terminal session".into()))
    }
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.map(PathBuf::from).filter(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn echo_shell() -> ResolvedShell {
        #[cfg(windows)]
        return ResolvedShell {
            path: "cmd.exe".into(),
            args: vec!["/C".into(), "echo luma-pty-test".into()],
            working_directory: None,
            environment: HashMap::new(),
        };
        #[cfg(not(windows))]
        return ResolvedShell {
            path: "/bin/sh".into(),
            args: vec!["-c".into(), "echo luma-pty-test".into()],
            working_directory: None,
            environment: HashMap::new(),
        };
    }

    #[test]
    fn spawns_reads_output_and_reports_exit() {
        let manager = PtyManager::default();
        let output = Arc::new(Mutex::new(Vec::new()));
        let output_clone = Arc::clone(&output);
        let (exit_tx, exit_rx) = mpsc::channel();

        let id = manager
            .spawn(
                echo_shell(),
                80,
                24,
                move |bytes| output_clone.lock().unwrap().extend_from_slice(bytes),
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .unwrap();

        // ConPTY starts with INHERIT_CURSOR and stalls the child until the
        // terminal answers the cursor-position query (ESC[6n). xterm.js does
        // this automatically in the app; do it manually here.
        manager.write(&id, "\x1b[1;1R").unwrap();

        let code = exit_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("shell did not exit in time");
        assert_eq!(code, Some(0));

        let text = String::from_utf8_lossy(&output.lock().unwrap()).to_string();
        assert!(
            text.contains("luma-pty-test"),
            "pty output missing echo: {text:?}"
        );

        assert_cleaned_up(&manager);
    }

    /// The waiter thread removes the session just after reporting the exit
    /// code, so allow a short grace period.
    fn assert_cleaned_up(manager: &PtyManager) {
        for _ in 0..100 {
            if manager.sessions.lock().unwrap().is_empty() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("pty session was not cleaned up after exit");
    }

    #[test]
    fn kill_terminates_long_running_session() {
        let manager = PtyManager::default();
        let (exit_tx, exit_rx) = mpsc::channel();

        #[cfg(windows)]
        let shell = ResolvedShell {
            path: "cmd.exe".into(),
            args: vec![],
            working_directory: None,
            environment: HashMap::new(),
        };
        #[cfg(not(windows))]
        let shell = ResolvedShell {
            path: "/bin/sh".into(),
            args: vec![],
            working_directory: None,
            environment: HashMap::new(),
        };

        let id = manager
            .spawn(
                shell,
                80,
                24,
                |_| {},
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .unwrap();

        manager.kill(&id).unwrap();
        exit_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("killed shell did not exit");
        assert_cleaned_up(&manager);
    }

    #[test]
    fn raw_session_logging_captures_pty_output() {
        let manager = PtyManager::default();
        let (exit_tx, exit_rx) = mpsc::channel();
        let base = std::env::temp_dir().join(format!("luma-pty-log-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("session.log");

        #[cfg(windows)]
        let shell = ResolvedShell {
            path: "cmd.exe".into(),
            args: vec![],
            working_directory: None,
            environment: HashMap::new(),
        };
        #[cfg(not(windows))]
        let shell = ResolvedShell {
            path: "/bin/sh".into(),
            args: vec![],
            working_directory: None,
            environment: HashMap::new(),
        };

        let id = manager
            .spawn(
                shell,
                80,
                24,
                |_| {},
                move |code| {
                    let _ = exit_tx.send(code);
                },
            )
            .unwrap();
        manager
            .log_start(
                &id,
                SessionLogMode::Raw,
                Some(path.to_str().unwrap()),
                &base,
            )
            .unwrap();
        manager.write(&id, "\x1b[1;1R").unwrap();
        #[cfg(windows)]
        manager
            .write(&id, "echo luma-session-log-test\r\nexit\r\n")
            .unwrap();
        #[cfg(not(windows))]
        manager
            .write(&id, "echo luma-session-log-test\nexit\n")
            .unwrap();

        exit_rx
            .recv_timeout(Duration::from_secs(15))
            .expect("logged shell did not exit");
        assert_cleaned_up(&manager);
        let contents = std::fs::read(&path).unwrap();
        assert!(
            String::from_utf8_lossy(&contents).contains("luma-session-log-test"),
            "session log did not contain expected output"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn write_to_unknown_session_fails() {
        let manager = PtyManager::default();
        assert!(manager.write("nope", "ls\n").is_err());
    }
}
