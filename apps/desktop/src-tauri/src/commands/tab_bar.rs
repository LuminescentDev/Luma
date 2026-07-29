use serde::{Deserialize, Serialize};

use crate::errors::Result;

/*
 * Native mobile tab bar bridge. WebKit exposes no CSS primitive for the iOS 26
 * Liquid Glass material, so the bar cannot be drawn by the webview at any
 * fidelity — it has to be a real UIKit view pinned over it.
 *
 * Following the Live Activity bridge (commands/live_activity.rs), the Rust
 * static library reaches Swift through @_cdecl entry points in
 * gen/apple/Sources/luma/LumaTabBar.swift rather than through a Tauri mobile
 * plugin. Unlike that bridge this one is bidirectional: Swift calls back into
 * `luma_tab_bar_did_select` when a tab is tapped, and we re-emit that as a Tauri
 * event for the frontend.
 *
 * Every command is registered on both mobile platforms (one shared invoke
 * handler). On Android and desktop `attach` returns an error, which the
 * frontend treats as "no native bar" and falls back to its web capsule — see
 * features/mobile/tabBar.ts.
 */

/// One tab as rendered by the native bar. `sfSymbol` is iOS vocabulary; the web
/// capsule maps the same tabs to Lucide icons independently.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabBarItem {
    pub id: String,
    pub label: String,
    pub sf_symbol: String,
    /// Badge count. Zero renders no badge.
    #[serde(default)]
    pub badge: u32,
}

/// Attach the native bar over the webview, returning the height it occupies in
/// CSS pixels so web content can reserve room for it. Errors where no native
/// bar exists, which is the frontend's signal to render its own.
#[tauri::command]
pub fn tab_bar_attach(tabs: Vec<TabBarItem>, selected: String) -> Result<f64> {
    imp::attach(&tabs, &selected)
}

/// Replace the bar's items and selection in place.
#[tauri::command]
pub fn tab_bar_update(tabs: Vec<TabBarItem>, selected: String) -> Result<()> {
    imp::update(&tabs, &selected)
}

/// Show or hide the bar without tearing it down (full-screen terminal, keyboard).
#[tauri::command]
pub fn tab_bar_set_visible(visible: bool) -> Result<()> {
    imp::set_visible(visible)
}

/// Present the native animation lab (LumaTabBarLab.swift): one bar per move
/// style, side by side, so the selection animation can be judged on a device
/// instead of guessed at. A design aid reachable from Profile > About.
#[tauri::command]
pub fn tab_bar_lab() -> Result<()> {
    imp::lab()
}

/// Store the app handle so the Swift tap callback can emit events. Called from
/// the builder's setup hook; a no-op off iOS.
pub fn register_tab_bar(app: &tauri::AppHandle) {
    imp::register(app);
}

#[cfg(target_os = "ios")]
mod imp {
    use super::TabBarItem;
    use crate::errors::{LumaError, Result};
    use serde::Serialize;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};

    extern "C" {
        fn luma_tab_bar_attach(json: *const c_char) -> f64;
        fn luma_tab_bar_update(json: *const c_char);
        fn luma_tab_bar_set_visible(visible: bool);
        fn luma_tab_bar_lab_present() -> bool;
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct TabBarConfig<'a> {
        tabs: &'a [TabBarItem],
        selected: &'a str,
    }

    #[derive(Clone, Serialize)]
    struct TabSelected {
        id: String,
    }

    /// Handle used to emit selections from the Swift callback, which has no
    /// access to Tauri state.
    static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

    pub fn register(app: &AppHandle) {
        if let Ok(mut slot) = APP_HANDLE.get_or_init(|| Mutex::new(None)).lock() {
            *slot = Some(app.clone());
        }
    }

    fn encode(tabs: &[TabBarItem], selected: &str) -> Result<CString> {
        let json = serde_json::to_string(&TabBarConfig { tabs, selected })
            .map_err(|error| LumaError::InvalidInput(format!("tab bar payload: {error}")))?;
        CString::new(json).map_err(|_| {
            LumaError::InvalidInput("tab bar payload contains a null byte".to_string())
        })
    }

    pub fn attach(tabs: &[TabBarItem], selected: &str) -> Result<f64> {
        let json = encode(tabs, selected)?;
        // SAFETY: Swift copies the string before returning and never retains the
        // pointer, so the CString may be dropped after the call.
        let height = unsafe { luma_tab_bar_attach(json.as_ptr()) };
        // A non-positive height means Swift declined to attach (no window yet,
        // or an unsupported host). Report that as an error so the frontend keeps
        // its web capsule instead of reserving space for a bar that is not there.
        if height <= 0.0 {
            return Err(LumaError::InvalidInput(
                "native tab bar unavailable".to_string(),
            ));
        }
        Ok(height)
    }

    pub fn update(tabs: &[TabBarItem], selected: &str) -> Result<()> {
        let json = encode(tabs, selected)?;
        unsafe { luma_tab_bar_update(json.as_ptr()) };
        Ok(())
    }

    pub fn set_visible(visible: bool) -> Result<()> {
        unsafe { luma_tab_bar_set_visible(visible) };
        Ok(())
    }

    pub fn lab() -> Result<()> {
        // SAFETY: no arguments; Swift presents a view controller and returns.
        let presented = unsafe { luma_tab_bar_lab_present() };
        if !presented {
            return Err(LumaError::InvalidInput(
                "tab bar lab unavailable".to_string(),
            ));
        }
        Ok(())
    }

    /// Called from Swift on the main thread when a tab is tapped.
    ///
    /// # Safety
    /// `id` must be a valid NUL-terminated C string that outlives this call.
    #[no_mangle]
    pub unsafe extern "C" fn luma_tab_bar_did_select(id: *const c_char) {
        if id.is_null() {
            return;
        }
        let Ok(id) = CStr::from_ptr(id).to_str() else {
            return;
        };
        let payload = TabSelected { id: id.to_string() };
        if let Some(slot) = APP_HANDLE.get() {
            if let Ok(handle) = slot.lock() {
                if let Some(handle) = handle.as_ref() {
                    let _ = handle.emit("mobile-tab-bar://selected", payload);
                }
            }
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod imp {
    use super::TabBarItem;
    use crate::errors::{LumaError, Result};

    fn unsupported<T>() -> Result<T> {
        Err(LumaError::InvalidInput(
            "native tab bar is only available on iOS".to_string(),
        ))
    }

    pub fn register(_app: &tauri::AppHandle) {}

    pub fn attach(_tabs: &[TabBarItem], _selected: &str) -> Result<f64> {
        unsupported()
    }

    pub fn update(_tabs: &[TabBarItem], _selected: &str) -> Result<()> {
        unsupported()
    }

    pub fn set_visible(_visible: bool) -> Result<()> {
        unsupported()
    }

    pub fn lab() -> Result<()> {
        unsupported()
    }
}
