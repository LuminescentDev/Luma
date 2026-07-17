// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;

fn run_askpass(identity_id: &std::ffi::OsStr) -> bool {
    let service =
        std::env::var("LUMA_ASKPASS_SERVICE").unwrap_or_else(|_| "luma.ssh.identity".into());
    let prompt = std::env::args()
        .nth(1)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let expected_prompt = std::env::var("LUMA_ASKPASS_PROMPT")
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !expected_prompt.is_empty() && !prompt.contains(&expected_prompt) {
        return false;
    }

    let Ok(entry) = keyring::Entry::new(&service, identity_id.to_string_lossy().as_ref()) else {
        return false;
    };
    let Ok(password) = entry.get_password() else {
        return false;
    };
    let password = zeroize::Zeroizing::new(password);
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(password.as_bytes())
        .and_then(|_| stdout.flush())
        .is_ok()
}

fn main() {
    if let Some(identity_id) = std::env::var_os("LUMA_ASKPASS_ID") {
        if !run_askpass(&identity_id) {
            std::process::exit(1);
        }
        return;
    }
    luma_lib::run()
}
