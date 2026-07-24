//! Apple iCloud Drive container discovery.
//!
//! Ask Foundation for the provisioned ubiquitous container on both iOS and
//! macOS. Constructing the path below `~/Library/Mobile Documents` directly
//! bypasses the API that grants the process access to the container.

use std::path::PathBuf;

use crate::errors::{LumaError, Result};

#[cfg(any(target_os = "ios", target_os = "macos"))]
pub fn container_documents_dir() -> Result<PathBuf> {
    use objc2_foundation::{ns_string, NSFileManager};

    let file_manager = NSFileManager::defaultManager();
    if file_manager.ubiquityIdentityToken().is_none() {
        return Err(unavailable());
    }
    let url = file_manager
        .URLForUbiquityContainerIdentifier(Some(ns_string!("iCloud.dev.bwmp.luma")))
        .ok_or_else(container_unavailable)?;
    let path = url.to_file_path().ok_or_else(container_unavailable)?;
    Ok(path.join("Documents").join("Luma"))
}

fn unavailable() -> LumaError {
    LumaError::SyncUnavailable(
        "iCloud Drive is unavailable; sign in to iCloud and enable iCloud Drive for Luma".into(),
    )
}

fn container_unavailable() -> LumaError {
    #[cfg(all(target_os = "macos", dev))]
    let message = "the iCloud container is unavailable because `tauri dev` runs an unsigned \
                   executable; test iCloud sync from a signed Luma.app bundle";

    #[cfg(not(all(target_os = "macos", dev)))]
    let message = "the provisioned iCloud container is unavailable; verify that this build is \
                   signed with Luma's iCloud entitlements";

    LumaError::SyncUnavailable(message.into())
}
