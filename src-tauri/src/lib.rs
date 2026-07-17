mod commands;
mod errors;
mod import;
mod logging;
mod platform;
mod serial;
mod sftp;
mod ssh;
mod storage;
mod sync;
mod terminal;
mod vault;

use std::path::PathBuf;

use sqlx::SqlitePool;
use tauri::Manager;

use serial::SerialManager;
use sftp::SftpManager;
use ssh::TunnelManager;
use terminal::PtyManager;

pub struct AppState {
    pub pool: SqlitePool,
    pub app_data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let log_dir = app.path().app_log_dir()?;
            logging::init(&log_dir);
            tracing::info!("luma {} starting", env!("CARGO_PKG_VERSION"));

            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join("luma.db");
            let pool = tauri::async_runtime::block_on(storage::init(&db_path))?;
            app.manage(AppState { pool, app_data_dir });
            let vault_state = vault::VaultState::default();
            tauri::async_runtime::block_on(vault::try_device_unlock(
                &app.state::<AppState>().pool,
                &vault_state,
            ));
            app.manage(vault_state);
            let sync_state = sync::SyncRuntimeState::default();
            tauri::async_runtime::block_on(sync::initialize(
                &app.state::<AppState>().pool,
                &sync_state,
            ))?;
            app.manage(sync_state);
            app.manage(PtyManager::default());
            app.manage(SerialManager::default());
            app.manage(TunnelManager::default());
            app.manage(SftpManager::default());

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
            commands::hosts_list,
            commands::host_get,
            commands::host_create,
            commands::host_update,
            commands::host_delete,
            commands::host_duplicate,
            commands::recent_hosts_list,
            commands::host_groups_list,
            commands::host_group_create,
            commands::host_group_update,
            commands::host_group_delete,
            commands::key_references_list,
            commands::key_reference_secrets,
            commands::key_reference_create,
            commands::key_reference_update,
            commands::key_reference_delete,
            commands::ssh_key_generate,
            commands::identities_list,
            commands::identity_create,
            commands::identity_update,
            commands::identity_delete,
            commands::ssh_detect,
            commands::ssh_host_key_status,
            commands::ssh_host_key_trust,
            commands::ssh_spawn,
            commands::ssh_config_preview,
            commands::ssh_config_import,
            commands::import_hosts_preview,
            commands::import_hosts_apply,
            commands::snippets_list,
            commands::snippet_create,
            commands::snippet_update,
            commands::snippet_delete,
            commands::port_forwards_list,
            commands::port_forward_create,
            commands::port_forward_update,
            commands::port_forward_delete,
            commands::tunnel_start,
            commands::tunnel_stop,
            commands::tunnels_list,
            commands::sftp_connect,
            commands::sftp_disconnect,
            commands::sftp_sessions,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_delete,
            commands::local_list,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_delete,
            commands::sftp_upload,
            commands::sftp_download,
            commands::sftp_cancel,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_kill,
            commands::serial_ports_list,
            commands::serial_spawn,
            commands::serial_write,
            commands::serial_kill,
            commands::vault_status,
            commands::vault_setup,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_set_policy,
            commands::export_encrypted,
            commands::import_preview,
            commands::import_apply,
            commands::sync_get_config,
            commands::sync_configure,
            commands::sync_set_passphrase,
            commands::sync_disable,
            commands::sync_now,
            commands::sync_resolve,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // No serial device, tunnel, SFTP, transfer, or shell may outlive the application.
            app_handle.state::<SerialManager>().kill_all();
            app_handle.state::<SftpManager>().kill_all();
            let pty = app_handle.state::<PtyManager>();
            app_handle.state::<TunnelManager>().kill_all(&pty);
            pty.kill_all();
        }
    });
}
