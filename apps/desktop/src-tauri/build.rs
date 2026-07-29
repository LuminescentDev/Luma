fn main() {
    println!("cargo:rerun-if-changed=permissions");
    allow_undefined_swift_bridge_symbols();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["derive_public_key"]));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}

/// The Live Activity bridge in `commands/live_activity.rs` and the native tab bar
/// bridge in `commands/tab_bar.rs` call `@_cdecl` functions that only exist once
/// Xcode links the staticlib against the app target's Swift sources. Cargo builds
/// a cdylib from the same crate and links it eagerly, so without this that unused
/// artifact fails on the missing symbols.
fn allow_undefined_swift_bridge_symbols() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    for symbol in [
        "_luma_live_activity_sync",
        "_luma_live_activity_end",
        "_luma_tab_bar_attach",
        "_luma_tab_bar_update",
        "_luma_tab_bar_set_visible",
        "_luma_menu_present",
        "_luma_tab_bar_lab_present",
    ] {
        println!("cargo:rustc-link-arg=-Wl,-U,{symbol}");
    }
}
