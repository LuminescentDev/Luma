use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::errors::{LumaError, Result};
use crate::platform::{self, DetectedShell};
use crate::storage::profiles::{self, ProfileInput, TerminalProfile};
use crate::storage::settings;
use crate::terminal::{PtyManager, ResolvedShell};
use crate::AppState;

mod hosts;
mod port_forwards;
mod sftp;
mod snippets;
mod ssh;
mod sync;
mod vault;

pub use hosts::*;
pub use port_forwards::*;
pub use sftp::*;
pub use snippets::*;
pub use ssh::*;
pub use sync::*;
pub use vault::*;

// --- Settings ---

#[tauri::command]
pub async fn settings_get_all(state: State<'_, AppState>) -> Result<HashMap<String, Value>> {
    settings::all(&state.pool).await
}

#[tauri::command]
pub async fn settings_set(state: State<'_, AppState>, key: String, value: Value) -> Result<()> {
    settings::set(&state.pool, &key, &value).await
}

#[tauri::command]
pub async fn settings_delete(state: State<'_, AppState>, key: String) -> Result<()> {
    settings::delete(&state.pool, &key).await
}

// --- Shells and profiles ---

#[tauri::command]
pub async fn shells_detect() -> Result<Vec<DetectedShell>> {
    Ok(platform::detect_shells())
}

#[tauri::command]
pub async fn profiles_list(state: State<'_, AppState>) -> Result<Vec<TerminalProfile>> {
    profiles::list(&state.pool).await
}

#[tauri::command]
pub async fn profile_create(
    state: State<'_, AppState>,
    input: ProfileInput,
) -> Result<TerminalProfile> {
    profiles::create(&state.pool, input).await
}

#[tauri::command]
pub async fn profile_update(
    state: State<'_, AppState>,
    id: String,
    input: ProfileInput,
) -> Result<TerminalProfile> {
    profiles::update(&state.pool, &id, input).await
}

#[tauri::command]
pub async fn profile_delete(state: State<'_, AppState>, id: String) -> Result<()> {
    profiles::delete(&state.pool, &id).await
}

// --- Terminal sessions ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRequest {
    pub cols: u16,
    pub rows: u16,
    /// Id of a shell from `shells_detect`.
    pub shell_id: Option<String>,
    /// Id of a stored terminal profile; takes precedence over `shell_id`.
    pub profile_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResponse {
    pub session_id: String,
    pub shell_name: String,
}

#[tauri::command]
pub async fn pty_spawn(
    state: State<'_, AppState>,
    pty: State<'_, PtyManager>,
    request: SpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<Option<u32>>,
) -> Result<SpawnResponse> {
    let (shell, shell_name) = if let Some(profile_id) = &request.profile_id {
        let profile = profiles::get(&state.pool, profile_id)
            .await?
            .ok_or_else(|| LumaError::InvalidInput("unknown profile".into()))?;
        (
            ResolvedShell {
                path: profile.shell_path,
                args: profile.args,
                working_directory: profile.working_directory.filter(|d| !d.is_empty()),
                environment: profile.environment.unwrap_or_default(),
            },
            profile.name,
        )
    } else {
        let shells = platform::detect_shells();
        let detected = match &request.shell_id {
            Some(id) => shells
                .into_iter()
                .find(|s| &s.id == id)
                .ok_or_else(|| LumaError::InvalidInput("unknown shell".into()))?,
            None => shells
                .into_iter()
                .next()
                .ok_or_else(|| LumaError::Pty("no shell available on this system".into()))?,
        };
        (
            ResolvedShell {
                path: detected.path,
                args: detected.args,
                working_directory: None,
                environment: HashMap::new(),
            },
            detected.name,
        )
    };

    let session_id = pty.spawn(
        shell,
        request.cols,
        request.rows,
        move |bytes| {
            let _ = on_data.send(InvokeResponseBody::Raw(bytes.to_vec()));
        },
        move |code| {
            let _ = on_exit.send(code);
        },
    )?;

    Ok(SpawnResponse {
        session_id,
        shell_name,
    })
}

#[tauri::command]
pub async fn pty_write(pty: State<'_, PtyManager>, session_id: String, data: String) -> Result<()> {
    pty.write(&session_id, &data)
}

#[tauri::command]
pub async fn pty_resize(
    pty: State<'_, PtyManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    pty.resize(&session_id, cols, rows)
}

#[tauri::command]
pub async fn pty_kill(pty: State<'_, PtyManager>, session_id: String) -> Result<()> {
    pty.kill(&session_id)
}
