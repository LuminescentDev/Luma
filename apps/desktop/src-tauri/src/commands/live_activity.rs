use serde::{Deserialize, Serialize};

use crate::errors::Result;

/*
 * iOS Live Activity bridge. The Rust static library is linked into the iOS app
 * binary, so this reaches ActivityKit through the @_cdecl entry points in
 * gen/apple/Sources/luma/LumaLiveActivity.swift instead of a Tauri mobile plugin.
 *
 * Both mobile platforms share one invoke handler in lib.rs, so the command exists
 * on Android too and does nothing there.
 */

/// Mirrors `LumaActivityAttributes.ContentState` in
/// gen/apple/Shared/LumaActivityAttributes.swift, which decodes by property name:
/// renaming a field here means renaming it there. Display strings are formatted
/// by the frontend (features/mobile/liveActivity.ts) and passed through verbatim.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveActivityState {
    pub appearance: String,
    pub primary: String,
    pub headline: String,
    pub detail: String,
    pub connected: u32,
    pub reconnecting: u32,
    pub failed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer: Option<LiveActivityTransfer>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveActivityTransfer {
    pub uploading: bool,
    /// None when the job's total size is unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fraction: Option<f64>,
    pub detail: String,
}

/// Start or update the activity, or end it when `state` is None.
#[tauri::command]
pub fn live_activity_sync(state: Option<LiveActivityState>) -> Result<()> {
    match state {
        Some(state) => apply(&state),
        None => end(),
    }
}

#[cfg(target_os = "ios")]
extern "C" {
    fn luma_live_activity_sync(json: *const std::os::raw::c_char);
    fn luma_live_activity_end();
}

#[cfg(target_os = "ios")]
fn apply(state: &LiveActivityState) -> Result<()> {
    use crate::errors::LumaError;

    let json = serde_json::to_string(state)
        .map_err(|error| LumaError::InvalidInput(format!("live activity payload: {error}")))?;
    let json = std::ffi::CString::new(json).map_err(|_| {
        LumaError::InvalidInput("live activity payload contains a null byte".to_string())
    })?;
    // SAFETY: the Swift side copies the string before it returns and never retains
    // the pointer, so the CString may be dropped after the call.
    unsafe { luma_live_activity_sync(json.as_ptr()) };
    Ok(())
}

#[cfg(target_os = "ios")]
fn end() -> Result<()> {
    unsafe { luma_live_activity_end() };
    Ok(())
}

#[cfg(target_os = "android")]
fn apply(_state: &LiveActivityState) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "android")]
fn end() -> Result<()> {
    Ok(())
}
