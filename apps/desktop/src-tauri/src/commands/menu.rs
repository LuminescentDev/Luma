use serde::{Deserialize, Serialize};

use crate::errors::Result;

/*
 * Native mobile menu bridge using @_cdecl entry points in
 * gen/apple/Sources/luma/LumaMenu.swift, reached directly from the static
 * library.
 *
 * A UIMenu presented over the webview renders in real Liquid Glass on iOS 26,
 * which web content can never do. The frontend anchors it to a DOM element's
 * bounding rect and gets the selection back as an event, so a picker looks and
 * behaves like a system menu while its trigger stays an ordinary React button.
 */

/// One row in the menu. `selected` renders a system checkmark.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItem {
    pub id: String,
    pub title: String,
    /// Optional SF Symbol shown leading the title.
    #[serde(default)]
    pub sf_symbol: Option<String>,
    #[serde(default)]
    pub selected: bool,
}

/// Where to hang the menu, in CSS pixels relative to the webview's viewport —
/// which map 1:1 to UIKit points, so Swift can use them directly.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuAnchor {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Present the menu. Returns Ok once it is on screen; the chosen item arrives
/// later as a `mobile-menu://selected` event. Dismissing without choosing
/// reports nothing, exactly as a system menu does. Errors where no native menu
/// exists, which is the frontend's signal to fall back to its own sheet.
#[tauri::command]
pub fn menu_present(items: Vec<MenuItem>, anchor: MenuAnchor, appearance: String) -> Result<()> {
    imp::present(&items, anchor, &appearance)
}

/// Store the app handle so the Swift selection callback can emit events.
pub fn register_menu(app: &tauri::AppHandle) {
    imp::register(app);
}

#[cfg(target_os = "ios")]
mod imp {
    use super::{MenuAnchor, MenuItem};
    use crate::errors::{LumaError, Result};
    use serde::Serialize;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::sync::{Mutex, OnceLock};
    use tauri::{AppHandle, Emitter};

    extern "C" {
        fn luma_menu_present(json: *const c_char) -> bool;
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct MenuConfig<'a> {
        items: &'a [MenuItem],
        anchor: MenuAnchor,
        appearance: &'a str,
    }

    #[derive(Clone, Serialize)]
    struct MenuSelected {
        id: String,
    }

    static APP_HANDLE: OnceLock<Mutex<Option<AppHandle>>> = OnceLock::new();

    pub fn register(app: &AppHandle) {
        if let Ok(mut slot) = APP_HANDLE.get_or_init(|| Mutex::new(None)).lock() {
            *slot = Some(app.clone());
        }
    }

    pub fn present(items: &[MenuItem], anchor: MenuAnchor, appearance: &str) -> Result<()> {
        let json = serde_json::to_string(&MenuConfig {
            items,
            anchor,
            appearance,
        })
        .map_err(|error| LumaError::InvalidInput(format!("menu payload: {error}")))?;
        let json = CString::new(json)
            .map_err(|_| LumaError::InvalidInput("menu payload contains a null byte".into()))?;
        // SAFETY: Swift copies the string before returning and never retains the
        // pointer, so the CString may be dropped after the call.
        let presented = unsafe { luma_menu_present(json.as_ptr()) };
        if !presented {
            return Err(LumaError::InvalidInput("native menu unavailable".into()));
        }
        Ok(())
    }

    /// Called from Swift on the main thread when a menu item is chosen.
    ///
    /// # Safety
    /// `id` must be a valid NUL-terminated C string that outlives this call.
    #[no_mangle]
    pub unsafe extern "C" fn luma_menu_did_select(id: *const c_char) {
        if id.is_null() {
            return;
        }
        let Ok(id) = CStr::from_ptr(id).to_str() else {
            return;
        };
        let payload = MenuSelected { id: id.to_string() };
        if let Some(slot) = APP_HANDLE.get() {
            if let Ok(handle) = slot.lock() {
                if let Some(handle) = handle.as_ref() {
                    let _ = handle.emit("mobile-menu://selected", payload);
                }
            }
        }
    }
}

#[cfg(not(target_os = "ios"))]
mod imp {
    use super::{MenuAnchor, MenuItem};
    use crate::errors::{LumaError, Result};

    pub fn register(_app: &tauri::AppHandle) {}

    pub fn present(_items: &[MenuItem], _anchor: MenuAnchor, _appearance: &str) -> Result<()> {
        Err(LumaError::InvalidInput(
            "native menus are only available on iOS".into(),
        ))
    }
}
