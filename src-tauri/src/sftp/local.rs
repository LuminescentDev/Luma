use std::fs;
use std::path::{Component, Path, PathBuf};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::time::UNIX_EPOCH;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::{sort_entries, DeleteBudget, DirectoryListing, FileEntry, MAX_DIRECTORY_ENTRIES};
use super::{MAX_DELETE_DEPTH, MAX_DELETE_ENTRIES, MAX_PATH_BYTES};
use crate::errors::{LumaError, Result};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::platform::home_dir;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalTransferFile {
    pub source: PathBuf,
    pub relative_path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct TransferWalkIssue {
    pub path: String,
    pub message: String,
    pub retryable: bool,
    pub skipped: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct LocalTransferPlan {
    pub directories: Vec<String>,
    pub files: Vec<LocalTransferFile>,
    pub issues: Vec<TransferWalkIssue>,
}

pub(super) fn build_local_transfer_plan(root: &Path) -> Result<LocalTransferPlan> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| local_io_error("could not inspect upload source", error))?;
    if !metadata.file_type().is_dir() {
        return Err(LumaError::InvalidInput(
            "upload source must be a local file or directory".into(),
        ));
    }

    let mut plan = LocalTransferPlan::default();
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut entries = 1_usize;
    while let Some((directory, depth)) = stack.pop() {
        if depth > MAX_DELETE_DEPTH {
            return Err(LumaError::SftpFailed(format!(
                "recursive transfer exceeds the maximum depth of {MAX_DELETE_DEPTH}"
            )));
        }
        let relative = relative_transfer_path(root, &directory)?;
        plan.directories.push(relative.clone());
        let read_dir = match fs::read_dir(&directory) {
            Ok(read_dir) => read_dir,
            Err(error) => {
                plan.issues.push(TransferWalkIssue {
                    path: relative,
                    message: format!("could not read local directory: {error}"),
                    retryable: true,
                    skipped: false,
                });
                continue;
            }
        };
        let mut children = Vec::new();
        for child in read_dir {
            entries += 1;
            if entries > MAX_DELETE_ENTRIES {
                return Err(LumaError::SftpFailed(format!(
                    "recursive transfer exceeds the maximum of {MAX_DELETE_ENTRIES} entries"
                )));
            }
            let child = match child {
                Ok(child) => child,
                Err(error) => {
                    plan.issues.push(TransferWalkIssue {
                        path: relative.clone(),
                        message: format!("could not read local entry: {error}"),
                        retryable: true,
                        skipped: false,
                    });
                    continue;
                }
            };
            let path = child.path();
            let relative_path = match relative_transfer_path(root, &path) {
                Ok(path) => path,
                Err(error) => {
                    plan.issues.push(TransferWalkIssue {
                        path: path.to_string_lossy().into_owned(),
                        message: error.to_string(),
                        retryable: false,
                        skipped: true,
                    });
                    continue;
                }
            };
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    plan.issues.push(TransferWalkIssue {
                        path: relative_path,
                        message: format!("could not inspect local entry: {error}"),
                        retryable: true,
                        skipped: false,
                    });
                    continue;
                }
            };
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                plan.issues.push(TransferWalkIssue {
                    path: relative_path,
                    message: "symlink skipped".into(),
                    retryable: false,
                    skipped: true,
                });
            } else if file_type.is_dir() {
                children.push(path);
            } else if file_type.is_file() {
                plan.files.push(LocalTransferFile {
                    source: path,
                    relative_path,
                    size: metadata.len(),
                });
            } else {
                plan.issues.push(TransferWalkIssue {
                    path: relative_path,
                    message: "non-regular filesystem entry skipped".into(),
                    retryable: false,
                    skipped: true,
                });
            }
        }
        children.sort();
        for child in children.into_iter().rev() {
            stack.push((child, depth + 1));
        }
    }
    plan.directories
        .sort_by_key(|path| path.matches('/').count());
    plan.files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(plan)
}

fn relative_transfer_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| LumaError::SftpFailed("local transfer path escaped its source root".into()))?;
    let mut components = Vec::new();
    for component in relative.components() {
        let Component::Normal(value) = component else {
            return Err(LumaError::SftpFailed(
                "local transfer path contains an invalid component".into(),
            ));
        };
        let value = value.to_str().ok_or_else(|| {
            LumaError::SftpFailed("local transfer filename is not valid Unicode".into())
        })?;
        if value.contains('\0') {
            return Err(LumaError::SftpFailed(
                "local transfer filename contains NUL".into(),
            ));
        }
        components.push(value);
    }
    Ok(components.join("/"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_list(path: Option<String>) -> Result<DirectoryListing> {
    tokio::task::spawn_blocking(move || list_blocking(path.as_deref()))
        .await
        .map_err(|error| LumaError::SftpFailed(format!("local directory task failed: {error}")))?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_mkdir(path: String) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let path = validated_creation_path(&path)?;
        if path.exists() {
            return Err(LumaError::SftpFailed(
                "local destination already exists".into(),
            ));
        }
        fs::create_dir(&path)
            .map_err(|error| local_io_error("could not create local directory", error))
    })
    .await
    .map_err(|error| LumaError::SftpFailed(format!("local directory task failed: {error}")))?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_rename(from: String, to: String, app_data_dir: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let from = validated_existing_path(&from)?;
        let to = validated_creation_path(&to)?;
        reject_filesystem_root(&from)?;
        reject_app_data_path(&from, &app_data_dir)?;
        reject_app_data_path(&to, &app_data_dir)?;
        if to.exists() {
            return Err(LumaError::SftpFailed(
                "local destination already exists".into(),
            ));
        }
        fs::rename(&from, &to).map_err(|error| local_io_error("could not rename local path", error))
    })
    .await
    .map_err(|error| LumaError::SftpFailed(format!("local rename task failed: {error}")))?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn local_delete(path: String, recursive: bool, app_data_dir: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        let path = validated_existing_path(&path)?;
        reject_filesystem_root(&path)?;
        reject_app_data_path(&path, &app_data_dir)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| local_io_error("could not inspect local path", error))?;
        if !metadata.file_type().is_dir() {
            return fs::remove_file(&path)
                .map_err(|error| local_io_error("could not delete local file", error));
        }
        if !recursive {
            return fs::remove_dir(&path)
                .map_err(|error| local_io_error("could not delete local directory", error));
        }

        let plan = build_local_delete_plan(path)?;
        for operation in plan {
            match operation {
                LocalDeleteOperation::File(path) => fs::remove_file(path)
                    .map_err(|error| local_io_error("could not delete local file", error))?,
                LocalDeleteOperation::Directory(path) => fs::remove_dir(path)
                    .map_err(|error| local_io_error("could not delete local directory", error))?,
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| LumaError::SftpFailed(format!("local delete task failed: {error}")))?
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn list_blocking(path: Option<&str>) -> Result<DirectoryListing> {
    let requested = match path {
        None | Some("") => home_dir().ok_or_else(|| {
            LumaError::SftpFailed("the current user's home directory is unavailable".into())
        })?,
        Some(path) => validate_local_path(path)?,
    };
    let canonical = requested
        .canonicalize()
        .map_err(|error| local_io_error("could not resolve local directory", error))?;
    if !canonical.is_dir() {
        return Err(LumaError::InvalidInput(
            "local path must identify a directory".into(),
        ));
    }
    let canonical_text = path_to_string(&canonical)?;
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&canonical)
        .map_err(|error| local_io_error("could not read local directory", error))?;
    for entry in read_dir {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            return Err(LumaError::SftpFailed(format!(
                "directory contains more than {MAX_DIRECTORY_ENTRIES} entries"
            )));
        }
        let entry = entry.map_err(|error| local_io_error("could not read local entry", error))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| LumaError::SftpFailed("local filename is not valid Unicode".into()))?;
        if name.contains('\0') {
            return Err(LumaError::SftpFailed("local filename contains NUL".into()));
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| local_io_error("could not inspect local entry", error))?;
        entries.push(local_entry(name, entry.path(), &metadata)?);
    }
    sort_entries(&mut entries);
    Ok(DirectoryListing {
        path: canonical_text,
        entries,
    })
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn local_entry(name: String, path: PathBuf, metadata: &fs::Metadata) -> Result<FileEntry> {
    let file_type = metadata.file_type();
    let kind = if file_type.is_dir() {
        "dir"
    } else if file_type.is_file() {
        "file"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let size = file_type.is_file().then_some(metadata.len());
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_secs()).ok());
    Ok(FileEntry {
        name,
        path: path_to_string(&path)?,
        kind: kind.into(),
        size,
        modified_at,
        permissions: local_permissions(metadata),
    })
}

#[cfg(unix)]
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn local_permissions(metadata: &fs::Metadata) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    Some(format_permissions(metadata.permissions().mode()))
}

#[cfg(windows)]
fn local_permissions(metadata: &fs::Metadata) -> Option<String> {
    let mode = if metadata.permissions().readonly() {
        0o555
    } else {
        0o777
    };
    Some(format_permissions(mode))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn format_permissions(mode: u32) -> String {
    let flags = [
        0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001,
    ];
    let symbols = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
    flags
        .into_iter()
        .zip(symbols)
        .map(|(flag, symbol)| if mode & flag != 0 { symbol } else { '-' })
        .collect()
}

pub(super) fn validate_local_path(path: &str) -> Result<PathBuf> {
    if path.is_empty() {
        return Err(LumaError::InvalidInput("local path is empty".into()));
    }
    if path.contains('\0') {
        return Err(LumaError::InvalidInput(
            "local path may not contain NUL".into(),
        ));
    }
    if path.len() > MAX_PATH_BYTES {
        return Err(LumaError::InvalidInput(format!(
            "local path exceeds {MAX_PATH_BYTES} bytes"
        )));
    }
    if has_empty_component(path) {
        return Err(LumaError::InvalidInput(
            "local path contains an empty component".into(),
        ));
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(LumaError::InvalidInput(
            "local path must be absolute".into(),
        ));
    }
    normalize_absolute(&path)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn validated_existing_path(path: &str) -> Result<PathBuf> {
    let path = validate_local_path(path)?;
    fs::symlink_metadata(&path)
        .map_err(|error| local_io_error("local path does not exist", error))?;
    Ok(path)
}

pub(super) fn validated_creation_path(path: &str) -> Result<PathBuf> {
    let path = validate_local_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| LumaError::InvalidInput("local path has no parent directory".into()))?;
    let name = path
        .file_name()
        .ok_or_else(|| LumaError::InvalidInput("local path has no final component".into()))?;
    let parent = parent
        .canonicalize()
        .map_err(|error| local_io_error("local parent directory does not exist", error))?;
    if !parent.is_dir() {
        return Err(LumaError::InvalidInput(
            "local parent path must be a directory".into(),
        ));
    }
    Ok(parent.join(name))
}

fn normalize_absolute(path: &Path) -> Result<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return Err(LumaError::InvalidInput(
                        "local path escapes its filesystem root".into(),
                    ));
                }
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    if !normalized.is_absolute() {
        return Err(LumaError::InvalidInput(
            "local path must be absolute".into(),
        ));
    }
    Ok(normalized)
}

#[cfg(windows)]
fn has_empty_component(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    let remainder = if let Some(remainder) = normalized.strip_prefix("//") {
        remainder
    } else if let Some(remainder) = normalized.strip_prefix('/') {
        remainder
    } else {
        normalized.as_str()
    };
    remainder.contains("//")
}

#[cfg(not(windows))]
fn has_empty_component(path: &str) -> bool {
    path.strip_prefix('/').unwrap_or(path).contains("//") || path.starts_with("//")
}

pub(super) fn reject_app_data_path(path: &Path, app_data_dir: &Path) -> Result<()> {
    let canonical_app = app_data_dir
        .canonicalize()
        .unwrap_or_else(|_| app_data_dir.to_path_buf());
    let canonical_path = if path.exists() {
        path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
    } else if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        parent
            .canonicalize()
            .unwrap_or_else(|_| parent.to_path_buf())
            .join(name)
    } else {
        path.to_path_buf()
    };
    if path_is_within(&canonical_path, &canonical_app) {
        return Err(LumaError::InvalidInput(
            "local operation may not modify Luma's application data directory".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn path_is_within(path: &Path, parent: &Path) -> bool {
    let path_components = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    let parent_components = parent
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_lowercase())
        .collect::<Vec<_>>();
    path_components.starts_with(&parent_components)
}

#[cfg(not(windows))]
fn path_is_within(path: &Path, parent: &Path) -> bool {
    path.starts_with(parent)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn reject_filesystem_root(path: &Path) -> Result<()> {
    if path.parent().is_none() {
        return Err(LumaError::InvalidInput(
            "filesystem roots may not be renamed or deleted".into(),
        ));
    }
    Ok(())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn path_to_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_string)
        .ok_or_else(|| LumaError::SftpFailed("local path is not valid Unicode".into()))
}

fn local_io_error(context: &str, error: std::io::Error) -> LumaError {
    LumaError::SftpFailed(format!("{context}: {error}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum LocalDeleteOperation {
    File(PathBuf),
    Directory(PathBuf),
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
enum PendingLocalDelete {
    Visit { path: PathBuf, depth: usize },
    RemoveDirectory(PathBuf),
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn build_local_delete_plan(root: PathBuf) -> Result<Vec<LocalDeleteOperation>> {
    let mut stack = vec![PendingLocalDelete::Visit {
        path: root,
        depth: 0,
    }];
    let mut budget = DeleteBudget::new(MAX_DELETE_DEPTH, MAX_DELETE_ENTRIES);
    budget.visit(0)?;
    let mut plan = Vec::new();

    while let Some(pending) = stack.pop() {
        match pending {
            PendingLocalDelete::RemoveDirectory(path) => {
                plan.push(LocalDeleteOperation::Directory(path));
            }
            PendingLocalDelete::Visit { path, depth } => {
                let metadata = fs::symlink_metadata(&path)
                    .map_err(|error| local_io_error("could not inspect local path", error))?;
                if !metadata.file_type().is_dir() {
                    plan.push(LocalDeleteOperation::File(path));
                    continue;
                }
                let mut children = Vec::new();
                for child in fs::read_dir(&path)
                    .map_err(|error| local_io_error("could not read local directory", error))?
                {
                    budget.visit(depth + 1)?;
                    children.push(
                        child
                            .map_err(|error| local_io_error("could not read local entry", error))?
                            .path(),
                    );
                }
                stack.push(PendingLocalDelete::RemoveDirectory(path));
                for child in children.into_iter().rev() {
                    stack.push(PendingLocalDelete::Visit {
                        path: child,
                        depth: depth + 1,
                    });
                }
            }
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_paths_must_be_absolute_bounded_and_nul_free() {
        assert_eq!(
            validate_local_path("relative/path").unwrap_err().category(),
            "invalid-input"
        );
        assert_eq!(
            validate_local_path("bad\0path").unwrap_err().category(),
            "invalid-input"
        );
        let long = if cfg!(windows) {
            format!("C:\\{}", "a".repeat(MAX_PATH_BYTES))
        } else {
            format!("/{}", "a".repeat(MAX_PATH_BYTES))
        };
        assert_eq!(
            validate_local_path(&long).unwrap_err().category(),
            "invalid-input"
        );
    }

    #[test]
    fn local_paths_normalize_dot_and_parent_components() {
        let input = if cfg!(windows) {
            r"C:\Users\.\alice\docs\..\file.txt"
        } else {
            "/home/./alice/docs/../file.txt"
        };
        let normalized = validate_local_path(input).unwrap();
        let text = normalized.to_string_lossy();
        assert!(!text.contains("/./"));
        assert!(!text.contains("\\.\\"));
        assert!(!text.contains("docs/.."));
        assert!(!text.contains("docs\\.."));
    }

    #[test]
    fn local_paths_reject_empty_components() {
        let input = if cfg!(windows) {
            r"C:\Users\\alice"
        } else {
            "/home//alice"
        };
        assert_eq!(
            validate_local_path(input).unwrap_err().category(),
            "invalid-input"
        );
    }

    #[test]
    fn permission_format_is_nine_rwx_characters() {
        assert_eq!(format_permissions(0o755), "rwxr-xr-x");
        assert_eq!(format_permissions(0o600), "rw-------");
    }

    #[test]
    fn transfer_walker_preserves_structure_and_empty_directories() {
        let base = std::env::temp_dir().join(format!("luma-walk-test-{}", uuid::Uuid::new_v4()));
        let root = base.join("source");
        fs::create_dir_all(root.join("nested").join("empty")).unwrap();
        fs::create_dir_all(root.join("empty-root-child")).unwrap();
        fs::write(root.join("root.txt"), b"root").unwrap();
        fs::write(root.join("nested").join("child.txt"), b"child").unwrap();

        let plan = build_local_transfer_plan(&root).unwrap();
        assert!(plan.directories.contains(&String::new()));
        assert!(plan.directories.contains(&"nested".to_string()));
        assert!(plan.directories.contains(&"nested/empty".to_string()));
        assert!(plan.directories.contains(&"empty-root-child".to_string()));
        assert_eq!(
            plan.files
                .iter()
                .map(|file| file.relative_path.as_str())
                .collect::<Vec<_>>(),
            vec!["nested/child.txt", "root.txt"]
        );
        assert!(plan.issues.is_empty());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn transfer_walker_skips_symlinks_without_following_them() {
        let base = std::env::temp_dir().join(format!("luma-walk-link-{}", uuid::Uuid::new_v4()));
        let root = base.join("source");
        fs::create_dir_all(&root).unwrap();
        let target = base.join("outside.txt");
        fs::write(&target, b"outside").unwrap();
        let link = root.join("link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            let _ = fs::remove_dir_all(base);
            return;
        }

        let plan = build_local_transfer_plan(&root).unwrap();
        assert!(plan.files.is_empty());
        assert_eq!(plan.issues.len(), 1);
        assert_eq!(plan.issues[0].path, "link.txt");
        assert!(plan.issues[0].skipped);
        assert!(!plan.issues[0].retryable);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn refuses_to_modify_app_data_descendants() {
        let base = std::env::temp_dir().join(format!("luma-sftp-test-{}", uuid::Uuid::new_v4()));
        let app_data = base.join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        let protected = app_data.join("luma.db");
        fs::write(&protected, b"db").unwrap();
        let error = reject_app_data_path(&protected, &app_data).unwrap_err();
        assert_eq!(error.category(), "invalid-input");
        fs::remove_dir_all(base).unwrap();
    }
}
