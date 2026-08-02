//! The system properties Aptabase attaches to every event.
//!
//! Scope is deliberately app/version/platform only. `locale`, `osVersion` and
//! `engineVersion` are part of Aptabase's schema and optional server-side; all
//! three are omitted because they add fingerprinting entropy without answering
//! any question this feature exists to answer. Adding `osVersion` later is a
//! one-field change plus an `os_info` dependency.

use serde::Serialize;

/// Server-side `StringLength` limits. Exceeding any of them rejects the whole
/// batch, so values are clamped before they are queued.
const MAX_EVENT_NAME: usize = 60;
const MAX_OS_NAME: usize = 30;
const MAX_APP_VERSION: usize = 50;
const MAX_SDK_VERSION: usize = 40;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SystemProps {
    pub is_debug: bool,
    pub os_name: String,
    pub engine_name: &'static str,
    pub app_version: String,
    pub sdk_version: String,
}

impl SystemProps {
    pub(super) fn new(app_version: String) -> Self {
        Self {
            is_debug: cfg!(debug_assertions),
            os_name: clamp(os_name().to_string(), MAX_OS_NAME),
            engine_name: engine_name(),
            app_version: clamp(app_version, MAX_APP_VERSION),
            sdk_version: clamp(
                concat!("luma-analytics@", env!("CARGO_PKG_VERSION")).to_string(),
                MAX_SDK_VERSION,
            ),
        }
    }
}

pub(super) fn clamp_event_name(name: &str) -> String {
    clamp(name.to_string(), MAX_EVENT_NAME)
}

/// Truncates on a char boundary so a multi-byte value can never produce
/// invalid UTF-8 or panic on a slice.
fn clamp(mut value: String, max: usize) -> String {
    if value.len() <= max {
        return value;
    }
    let end = (0..=max)
        .rev()
        .find(|&i| value.is_char_boundary(i))
        .unwrap_or(0);
    value.truncate(end);
    value
}

/// Aptabase's display names for the platforms Luma ships on.
fn os_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "Windows",
        "macos" => "macOS",
        "ios" => "iOS",
        "android" => "Android",
        "linux" => "Linux",
        other => other,
    }
}

/// The webview each platform embeds. Compile-time, so no runtime probe and no
/// dependency on Tauri's `wry` feature.
fn engine_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "WebView2"
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        "WebKit"
    }
    #[cfg(target_os = "android")]
    {
        "Android WebView"
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "ios",
        target_os = "android"
    )))]
    {
        "WebKitGTK"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_props_carry_the_app_version() {
        let props = SystemProps::new("0.14.2".into());
        assert_eq!(props.app_version, "0.14.2");
        assert!(props.sdk_version.starts_with("luma-analytics@"));
        assert!(!props.os_name.is_empty());
    }

    #[test]
    fn oversized_values_are_clamped_to_the_server_limits() {
        let props = SystemProps::new("9".repeat(200));
        assert_eq!(props.app_version.len(), MAX_APP_VERSION);
        assert!(props.sdk_version.len() <= MAX_SDK_VERSION);
        assert_eq!(clamp_event_name(&"e".repeat(200)).len(), MAX_EVENT_NAME);
    }

    #[test]
    fn clamping_respects_char_boundaries() {
        // A naive truncate would panic here.
        let clamped = clamp("é".repeat(40), MAX_OS_NAME);
        assert!(clamped.len() <= MAX_OS_NAME);
    }
}
