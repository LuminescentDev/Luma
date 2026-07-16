mod commands;
mod errors;
mod logging;
mod platform;
mod storage;
mod terminal;

use sqlx::SqlitePool;
use tauri::Manager;

use terminal::PtyManager;

pub struct AppState {
    pub pool: SqlitePool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            logging::init(&log_dir);
            tracing::info!("luma {} starting", env!("CARGO_PKG_VERSION"));

            let db_path = app.path().app_data_dir()?.join("luma.db");
            let pool = tauri::async_runtime::block_on(storage::init(&db_path))?;
            app.manage(AppState { pool });
            app.manage(PtyManager::default());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get_all,
            commands::settings_set,
            commands::settings_delete,
            commands::shells_detect,
            commands::profiles_list,
            commands::profile_create,
            commands::profile_update,
            commands::profile_delete,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // No shell process may outlive the application.
            app_handle.state::<PtyManager>().kill_all();
        }
    });
}
