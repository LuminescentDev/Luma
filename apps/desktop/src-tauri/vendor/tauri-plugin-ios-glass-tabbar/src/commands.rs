use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::IosGlassTabbarExt;
use crate::Result;

#[command]
pub(crate) async fn set_items<R: Runtime>(
    app: AppHandle<R>,
    payload: SetItemsRequest,
) -> Result<()> {
    app.ios_glass_tabbar().set_items(payload)
}

#[command]
pub(crate) async fn set_active_tab<R: Runtime>(
    app: AppHandle<R>,
    payload: SetActiveTabRequest,
) -> Result<()> {
    app.ios_glass_tabbar().set_active_tab(payload)
}

#[command]
pub(crate) async fn set_hidden<R: Runtime>(
    app: AppHandle<R>,
    payload: SetHiddenRequest,
) -> Result<()> {
    app.ios_glass_tabbar().set_hidden(payload)
}

#[command]
pub(crate) async fn set_badge<R: Runtime>(
    app: AppHandle<R>,
    payload: SetBadgeRequest,
) -> Result<()> {
    app.ios_glass_tabbar().set_badge(payload)
}

#[command]
pub(crate) async fn set_tint_color<R: Runtime>(
    app: AppHandle<R>,
    payload: SetTintColorRequest,
) -> Result<()> {
    app.ios_glass_tabbar().set_tint_color(payload)
}
