mod agent_events;
mod collaboration;
mod commands;
mod errors;
mod import;
mod keystore;
mod logging;
mod mosh;
mod platform;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod serial;
mod server_stats;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod session_logging;
mod sftp;
mod snippet_runs;
mod ssh;
mod storage;
mod sync;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod terminal;

use std::path::PathBuf;

use sqlx::SqlitePool;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::Emitter;
use tauri::Manager;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use serial::SerialManager;
use server_stats::ServerStatsManager;
use sftp::SftpManager;
use snippet_runs::SnippetRunManager;
use ssh::EmbeddedSshManager;
use ssh::TunnelManager;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use terminal::PtyManager;

pub struct AppState {
    pub pool: SqlitePool,
    pub app_data_dir: PathBuf,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        if let Some(url) = argv.iter().find(|arg| arg.starts_with("luma://")) {
            let _ = app.emit("deep-link", url);
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_ios_glass_tabbar::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    let builder = builder.setup(|app| {
        let log_dir = app.path().app_log_dir()?;
        logging::init(&log_dir);
        tracing::info!("luma {} starting", env!("CARGO_PKG_VERSION"));

        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let _ = app_handle.emit("deep-link", url.as_str());
                }
            });

            #[cfg(debug_assertions)]
            if let Err(error) = app.deep_link().register_all() {
                tracing::warn!(%error, "could not register development deep links");
            }
        }

        let app_data_dir = app.path().app_data_dir()?;
        let db_path = app_data_dir.join("luma.db");
        let pool = tauri::async_runtime::block_on(storage::init(&db_path))?;
        let removed_ephemeral =
            tauri::async_runtime::block_on(storage::hosts::cleanup_stale_ephemeral(&pool))?;
        if removed_ephemeral > 0 {
            tracing::info!(removed_ephemeral, "removed stale quick-connect hosts");
        }
        let keystore_state = keystore::KeystoreState::new(&app_data_dir);
        app.manage(AppState { pool, app_data_dir });
        tauri::async_runtime::block_on(keystore::try_device_unlock(
            &app.state::<AppState>().pool,
            &keystore_state,
        ));
        app.manage(keystore_state);
        let sync_state = sync::SyncRuntimeState::default();
        tauri::async_runtime::block_on(sync::initialize(
            &app.state::<AppState>().pool,
            &sync_state,
            &app.state::<keystore::KeystoreState>(),
        ))?;
        app.manage(sync_state);
        app.manage(collaboration::CollaborationRuntimeState::default());
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        app.manage(PtyManager::default());
        app.manage(EmbeddedSshManager::default());
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        app.manage(SerialManager::default());
        // Tunnels run on every platform: ssh/tunnels.rs is plain tokio over the
        // russh session, so mobile forwards work too (see platform.rs).
        app.manage(TunnelManager::default());
        app.manage(SftpManager::default());
        app.manage(ServerStatsManager::default());
        app.manage(SnippetRunManager::default());

        // Lets native menu Swift callbacks emit into the frontend.
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            commands::register_menu(app.handle());
        }

        Ok(())
    });

    // Tauri's generate_handler! macro cannot compose command sub-lists. Keep the
    // desktop and mobile registrations adjacent so capability boundaries remain
    // explicit and reviewable when commands are added.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::platform_capabilities,
        commands::settings_get_all,
        commands::settings_set,
        commands::settings_delete,
        commands::shells_detect,
        commands::profiles_list,
        commands::profile_create,
        commands::profile_update,
        commands::profile_delete,
        commands::vaults_list,
        commands::vault_get,
        commands::vault_create,
        commands::vault_update,
        commands::vault_delete,
        commands::vault_create_managed,
        commands::vault_join_managed,
        commands::vault_create_invite,
        commands::vault_remove_member,
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
        commands::derive_public_key,
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
        commands::quick_connect_prepare,
        commands::quick_connect_save,
        commands::ssh_ping,
        commands::ssh_write,
        commands::ssh_resize,
        commands::ssh_disconnect,
        commands::ssh_probe,
        commands::ssh_key_install,
        commands::ssh_host_key_status,
        commands::ssh_host_key_trust,
        commands::known_hosts_list,
        commands::known_hosts_remove,
        commands::ssh_spawn,
        commands::mosh_spawn,
        commands::ssh_config_preview,
        commands::ssh_config_import,
        commands::import_hosts_preview,
        commands::import_hosts_apply,
        commands::snippets_list,
        commands::snippet_create,
        commands::snippet_update,
        commands::snippet_delete,
        commands::snippet_run_hosts,
        commands::snippet_run_cancel,
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
        commands::sftp_retry,
        commands::server_stats_fetch,
        commands::server_stats_close,
        commands::pty_spawn,
        commands::pty_write,
        commands::pty_resize,
        commands::pty_kill,
        commands::session_log_start,
        commands::session_log_stop,
        commands::session_log_status,
        commands::serial_ports_list,
        commands::serial_spawn,
        commands::serial_write,
        commands::serial_kill,
        commands::keystore_status,
        commands::keystore_setup,
        commands::keystore_unlock,
        commands::keystore_lock,
        commands::keystore_set_policy,
        commands::export_encrypted,
        commands::import_preview,
        commands::import_apply,
        commands::collab_get_config,
        commands::collab_set_server_url,
        commands::collab_auth_start,
        commands::collab_auth_poll,
        commands::collab_auth_status,
        commands::collab_auth_sign_out,
        commands::collab_get_device_identity,
        commands::collab_set_device_identity,
        commands::collab_register_device,
        commands::collab_list_devices,
        commands::collab_create_room,
        commands::collab_add_room_member,
        commands::collab_mint_room_capability,
        commands::collab_join_room_with_capability,
        commands::collab_get_room,
        commands::collab_issue_realtime_ticket,
        commands::collab_rotate_room_key,
        commands::collab_get_snapshot,
        commands::collab_put_snapshot,
        commands::collab_create_invite,
        commands::collab_parse_invite,
        commands::sync_get_config,
        commands::sync_list_configs,
        commands::sync_configure,
        commands::sync_set_passphrase,
        commands::sync_disable,
        commands::sync_now,
        commands::sync_resolve,
    ]);

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        commands::platform_capabilities,
        commands::settings_get_all,
        commands::settings_set,
        commands::settings_delete,
        commands::vaults_list,
        commands::vault_get,
        commands::vault_create,
        commands::vault_update,
        commands::vault_delete,
        commands::vault_create_managed,
        commands::vault_join_managed,
        commands::vault_create_invite,
        commands::vault_remove_member,
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
        commands::derive_public_key,
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
        commands::quick_connect_prepare,
        commands::quick_connect_save,
        commands::ssh_ping,
        commands::ssh_write,
        commands::ssh_resize,
        commands::ssh_disconnect,
        commands::ssh_probe,
        commands::ssh_key_install,
        commands::ssh_host_key_status,
        commands::ssh_host_key_trust,
        commands::known_hosts_list,
        commands::known_hosts_remove,
        commands::ssh_spawn,
        commands::import_hosts_preview,
        commands::import_hosts_apply,
        commands::snippets_list,
        commands::snippet_create,
        commands::snippet_update,
        commands::snippet_delete,
        commands::snippet_run_hosts,
        commands::snippet_run_cancel,
        commands::port_forwards_list,
        commands::port_forward_create,
        commands::port_forward_update,
        commands::port_forward_delete,
        commands::tunnel_start,
        commands::tunnel_stop,
        commands::tunnels_list,
        commands::menu_present,
        commands::sftp_connect,
        commands::sftp_disconnect,
        commands::sftp_sessions,
        commands::sftp_list,
        commands::sftp_mkdir,
        commands::sftp_rename,
        commands::sftp_delete,
        commands::sftp_upload,
        commands::sftp_download,
        commands::sftp_cancel,
        commands::sftp_retry,
        commands::server_stats_fetch,
        commands::server_stats_close,
        commands::keystore_status,
        commands::keystore_setup,
        commands::keystore_unlock,
        commands::keystore_lock,
        commands::keystore_set_policy,
        commands::export_encrypted,
        commands::import_preview,
        commands::import_apply,
        commands::collab_get_config,
        commands::collab_set_server_url,
        commands::collab_auth_start,
        commands::collab_auth_poll,
        commands::collab_auth_status,
        commands::collab_auth_sign_out,
        commands::collab_get_device_identity,
        commands::collab_set_device_identity,
        commands::collab_register_device,
        commands::collab_list_devices,
        commands::collab_create_room,
        commands::collab_add_room_member,
        commands::collab_mint_room_capability,
        commands::collab_join_room_with_capability,
        commands::collab_get_room,
        commands::collab_issue_realtime_ticket,
        commands::collab_rotate_room_key,
        commands::collab_get_snapshot,
        commands::collab_put_snapshot,
        commands::collab_create_invite,
        commands::collab_parse_invite,
        commands::sync_get_config,
        commands::sync_list_configs,
        commands::sync_configure,
        commands::sync_set_passphrase,
        commands::sync_disable,
        commands::sync_now,
        commands::sync_resolve,
        commands::live_activity_sync,
    ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // No serial device, tunnel, SFTP, transfer, or shell may outlive the application.
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app_handle.state::<SerialManager>().kill_all();
            app_handle.state::<SftpManager>().kill_all();
            app_handle.state::<ServerStatsManager>().kill_all();
            app_handle.state::<SnippetRunManager>().kill_all();
            app_handle.state::<EmbeddedSshManager>().kill_all();
            app_handle.state::<TunnelManager>().kill_all();
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app_handle.state::<PtyManager>().kill_all();
        }
    });
}
