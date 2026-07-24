use tauri::State;

use crate::errors::Result;
use crate::ssh::{self, KnownHostsEntry};
use crate::AppState;

#[tauri::command]
pub async fn known_hosts_list(state: State<'_, AppState>) -> Result<Vec<KnownHostsEntry>> {
    let path = ssh::known_hosts_file_path(&state.app_data_dir);
    ssh::known_hosts_list(&path)
}

#[tauri::command]
pub async fn known_hosts_remove(state: State<'_, AppState>, line_number: usize) -> Result<()> {
    let path = ssh::known_hosts_file_path(&state.app_data_dir);
    ssh::known_hosts_remove(&path, line_number)
}
