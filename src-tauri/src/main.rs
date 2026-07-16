// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(identity_id) = std::env::var_os("LUMA_ASKPASS_ID") {
        if let Ok(entry) =
            keyring::Entry::new("luma.ssh.identity", identity_id.to_string_lossy().as_ref())
        {
            if let Ok(password) = entry.get_password() {
                print!("{password}");
            }
        }
        return;
    }
    luma_lib::run()
}
