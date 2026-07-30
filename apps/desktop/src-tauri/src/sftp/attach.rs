use russh_sftp::client::fs::Metadata as RemoteMetadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{join_remote_path, remote_error, validate_remote_path, SftpManager};
use crate::errors::{LumaError, Result};

/*
 * Terminal attachments: upload a local file into a private staging directory
 * (~/.luma/attachments, mode 0700) on an SSH host so the shell-escaped remote
 * path can be inserted at the terminal prompt. File contents are never logged.
 */

const MAX_ATTACHMENT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 128;
const COPY_CHUNK_BYTES: usize = 256 * 1024;

/// Upload `local_path` to `~/.luma/attachments/<short-id>-<sanitized-name>`
/// under the SFTP session's home directory and return the remote path. The
/// random prefix makes names collision-proof, so existing files are never
/// overwritten.
pub async fn upload_attachment(
    manager: &SftpManager,
    session_id: &str,
    home: &str,
    local_path: &str,
    file_name: Option<&str>,
) -> Result<String> {
    let metadata = tokio::fs::metadata(local_path).await?;
    if !metadata.is_file() {
        return Err(LumaError::InvalidInput(
            "attachment source is not a regular file".into(),
        ));
    }
    if metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(LumaError::InvalidInput(format!(
            "attachment exceeds the {} MiB limit",
            MAX_ATTACHMENT_BYTES / (1024 * 1024)
        )));
    }

    let client = manager.client(session_id)?;
    let luma_dir = join_remote_path(home, ".luma");
    let staging_dir = join_remote_path(&luma_dir, "attachments");
    ensure_private_dir(&client, &luma_dir).await?;
    ensure_private_dir(&client, &staging_dir).await?;

    let raw_name = match file_name {
        Some(name) => name.to_string(),
        None => std::path::Path::new(local_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    };
    let remote_name = format!("{}-{}", short_id(), sanitize_attachment_name(&raw_name));
    let remote_path = join_remote_path(&staging_dir, &remote_name);
    validate_remote_path(&remote_path)?;

    let mut local = tokio::fs::File::open(local_path).await?;
    let mut remote = client
        .open_with_flags_and_attributes(
            remote_path.clone(),
            OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::TRUNCATE,
            {
                let mut metadata = RemoteMetadata::empty();
                metadata.permissions = Some(0o600);
                metadata
            },
        )
        .await
        .map_err(remote_error)?;

    let mut buffer = vec![0_u8; COPY_CHUNK_BYTES];
    loop {
        let read = local.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        remote
            .write_all(&buffer[..read])
            .await
            .map_err(|error| LumaError::SftpFailed(error.to_string()))?;
    }
    remote
        .flush()
        .await
        .map_err(|error| LumaError::SftpFailed(error.to_string()))?;
    remote
        .shutdown()
        .await
        .map_err(|error| LumaError::SftpFailed(error.to_string()))?;

    tracing::debug!(remote_path = %remote_path, "uploaded terminal attachment");
    Ok(remote_path)
}

/// Create `path` with mode 0700 when missing; otherwise require it to already
/// be a directory (existing permissions are left untouched).
async fn ensure_private_dir(client: &SftpSession, path: &str) -> Result<()> {
    if client
        .try_exists(path.to_string())
        .await
        .map_err(remote_error)?
    {
        let metadata = client
            .metadata(path.to_string())
            .await
            .map_err(remote_error)?;
        if !metadata.is_dir() {
            return Err(LumaError::SftpFailed(format!(
                "remote path {path} exists but is not a directory"
            )));
        }
    } else {
        client
            .create_dir(path.to_string())
            .await
            .map_err(remote_error)?;
        let mut permissions = RemoteMetadata::empty();
        permissions.permissions = Some(0o700);
        client
            .set_metadata(path.to_string(), permissions)
            .await
            .map_err(remote_error)?;
    }
    Ok(())
}

/// Short random prefix so staged names never collide with existing files.
fn short_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    id[..8].to_string()
}

/// Reduce an arbitrary client-supplied name to a safe remote file name: keep
/// only the last path component, drop control characters, cap the length at a
/// UTF-8 boundary, and fall back to "attachment" for empty or dot-only names.
pub(super) fn sanitize_attachment_name(name: &str) -> String {
    let base = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control())
        .collect::<String>();
    let base = base.trim();
    let mut capped = String::new();
    for character in base.chars() {
        if capped.len() + character.len_utf8() > MAX_NAME_BYTES {
            break;
        }
        capped.push(character);
    }
    if capped.is_empty() || capped == "." || capped == ".." {
        return "attachment".to_string();
    }
    capped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_ordinary_names() {
        assert_eq!(sanitize_attachment_name("report.pdf"), "report.pdf");
        assert_eq!(sanitize_attachment_name("a b c.txt"), "a b c.txt");
    }

    #[test]
    fn keeps_dotfiles_but_rejects_dot_and_dot_dot() {
        assert_eq!(sanitize_attachment_name(".env"), ".env");
        assert_eq!(sanitize_attachment_name("."), "attachment");
        assert_eq!(sanitize_attachment_name(".."), "attachment");
    }

    #[test]
    fn strips_control_characters() {
        assert_eq!(
            sanitize_attachment_name("a\x00b\x1b[31mc\n.txt"),
            "ab[31mc.txt"
        );
        assert_eq!(sanitize_attachment_name("\x00\x01\x02"), "attachment");
    }

    #[test]
    fn takes_last_path_component_for_both_separator_styles() {
        assert_eq!(sanitize_attachment_name("/tmp/notes.txt"), "notes.txt");
        assert_eq!(
            sanitize_attachment_name("C:\\Users\\me\\notes.txt"),
            "notes.txt"
        );
        assert_eq!(sanitize_attachment_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_attachment_name("trailing/"), "attachment");
    }

    #[test]
    fn caps_long_names_at_a_utf8_boundary() {
        let long = "x".repeat(300);
        assert_eq!(sanitize_attachment_name(&long).len(), MAX_NAME_BYTES);
        let multibyte = "é".repeat(200); // 2 bytes each
        let capped = sanitize_attachment_name(&multibyte);
        assert!(capped.len() <= MAX_NAME_BYTES);
        assert_eq!(capped.chars().count(), MAX_NAME_BYTES / 2);
    }

    #[test]
    fn empty_and_whitespace_fall_back() {
        assert_eq!(sanitize_attachment_name(""), "attachment");
        assert_eq!(sanitize_attachment_name("   "), "attachment");
    }
}
