//! Apple iCloud Drive container discovery.
//!
//! iOS must ask Foundation for the provisioned ubiquitous container. macOS
//! exposes the same container below `~/Library/Mobile Documents`; using that
//! path keeps the Rust provider independent of Objective-C on desktop.

use std::path::PathBuf;

use crate::errors::{LumaError, Result};

#[cfg(target_os = "macos")]
const CONTAINER_ID: &str = "iCloud.dev.bwmp.luma";

#[cfg(target_os = "ios")]
pub fn container_documents_dir() -> Result<PathBuf> {
    use std::ffi::CStr;

    unsafe extern "C" {
        fn luma_icloud_container_path() -> *mut libc::c_char;
    }

    // SAFETY: the Swift bridge returns either null or a strdup-allocated,
    // NUL-terminated UTF-8 string. Ownership is transferred to this call.
    let pointer = unsafe { luma_icloud_container_path() };
    if pointer.is_null() {
        return Err(unavailable());
    }
    let path = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { libc::free(pointer.cast()) };
    Ok(PathBuf::from(path).join("Documents").join("Luma"))
}

#[cfg(target_os = "macos")]
pub fn container_documents_dir() -> Result<PathBuf> {
    let home = std::env::var_os("HOME").ok_or_else(unavailable)?;
    let disk_name = CONTAINER_ID.replace('.', "~");
    Ok(PathBuf::from(home)
        .join("Library")
        .join("Mobile Documents")
        .join(disk_name)
        .join("Documents")
        .join("Luma"))
}

fn unavailable() -> LumaError {
    LumaError::SyncUnavailable(
        "iCloud Drive is unavailable; sign in to iCloud and enable iCloud Drive for Luma".into(),
    )
}
