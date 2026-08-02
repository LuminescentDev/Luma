use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::analytics;
use crate::errors::Result;
use crate::storage::settings;
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsInfo {
    /// Whether this build carries an analytics endpoint at all. False in local
    /// dev and in any fork, which is what keeps the consent prompt from
    /// appearing where it would have nothing to talk to.
    pub configured: bool,
    pub enabled: bool,
    /// The install identifier, shown in Settings so a user can quote it when
    /// asking for their analytics records to be deleted. `None` while opted
    /// out, because it does not exist then. The ingest endpoint is
    /// deliberately NOT exposed here.
    pub install_id: Option<String>,
}

#[tauri::command]
pub fn analytics_config() -> AnalyticsInfo {
    let analytics = analytics::handle();
    AnalyticsInfo {
        configured: analytics.is_configured(),
        enabled: analytics.is_enabled(),
        install_id: analytics.install_id(),
    }
}

/// Applies the consent choice to the running process, and owns the install
/// identifier's whole lifetime.
///
/// The identifier is minted here rather than in the frontend so it is never
/// created for someone who has not opted in, and it is deleted on opt-out —
/// so turning analytics off genuinely forgets the device rather than pausing
/// it, and turning it back on starts a new identity.
///
/// Persisting the consent flag itself stays with the frontend (`settings_set`)
/// so the settings cache stays coherent and the two writes can be ordered to
/// fail toward not sending.
#[tauri::command]
pub async fn analytics_set_enabled(app_state: State<'_, AppState>, enabled: bool) -> Result<()> {
    let analytics = analytics::handle();
    if enabled {
        let existing = settings::all(&app_state.pool)
            .await?
            .get(analytics::INSTALL_ID_SETTING_KEY)
            .and_then(Value::as_str)
            .map(str::to_string);
        let install_id = match existing {
            Some(id) => id,
            None => {
                let id = analytics::new_install_id();
                settings::set(
                    &app_state.pool,
                    analytics::INSTALL_ID_SETTING_KEY,
                    &Value::String(id.clone()),
                )
                .await?;
                id
            }
        };
        analytics.set_install_id(Some(install_id));
        analytics.set_enabled(true);
    } else {
        analytics.set_enabled(false);
        analytics.set_install_id(None);
        settings::delete(&app_state.pool, analytics::INSTALL_ID_SETTING_KEY).await?;
    }
    Ok(())
}
