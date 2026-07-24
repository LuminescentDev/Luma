fn main() {
    println!("cargo:rerun-if-changed=permissions");
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(&["derive_public_key"]));
    tauri_build::try_build(attributes).expect("failed to build Tauri application");
}
