// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(identity_id) = std::env::var_os("LUMA_ASKPASS_ID") {
        let service =
            std::env::var("LUMA_ASKPASS_SERVICE").unwrap_or_else(|_| "luma.ssh.identity".into());
        let prompt = std::env::args()
            .nth(1)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let expected_prompt = std::env::var("LUMA_ASKPASS_PROMPT").unwrap_or_default();
        if expected_prompt.is_empty() || prompt.contains(&expected_prompt) {
            if let Ok(entry) = keyring::Entry::new(&service, identity_id.to_string_lossy().as_ref())
            {
                if let Ok(password) = entry.get_password() {
                    print!("{password}");
                }
            }
        }
        return;
    }
    luma_lib::run()
}
