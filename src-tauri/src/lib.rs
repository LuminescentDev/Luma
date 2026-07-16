mod commands;
mod errors;
mod logging;
mod storage;

use sqlx::SqlitePool;
use tauri::Manager;

pub struct AppState {
    pub pool: SqlitePool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            logging::init(&log_dir);
            tracing::info!("luma {} starting", env!("CARGO_PKG_VERSION"));

            let db_path = app.path().app_data_dir()?.join("luma.db");
            let pool = tauri::async_runtime::block_on(storage::init(&db_path))?;
            app.manage(AppState { pool });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings_get_all,
            commands::settings_set,
            commands::settings_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
