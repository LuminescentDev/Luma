fn main() {
    println!("cargo:rerun-if-changed=permissions");
    // Without these, a cached crate compiled against different values would be
    // reused and the override would silently not apply.
    println!("cargo:rerun-if-env-changed=LUMA_ANALYTICS_HOST");
    println!("cargo:rerun-if-env-changed=LUMA_ANALYTICS_KEY");
    allow_undefined_swift_bridge_symbols();
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["derive_public_key"]));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}

/// The Live Activity and native menu bridges call `@_cdecl` functions that only
/// exist once Xcode links the staticlib against the app target's Swift sources.
/// Cargo builds a cdylib from the same crate and links it eagerly, so without
/// this that unused artifact fails on the missing symbols.
fn allow_undefined_swift_bridge_symbols() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("ios") {
        return;
    }
    for symbol in [
        "_luma_live_activity_sync",
        "_luma_live_activity_end",
        "_luma_menu_present",
    ] {
        println!("cargo:rustc-link-arg=-Wl,-U,{symbol}");
    }
}
