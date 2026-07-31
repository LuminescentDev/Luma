//! Repository context (git status, diffs, file contents) for the directory a
//! terminal session is sitting in on a remote host.
//!
//! Every call runs one batched `sh -c` script over an SSH exec channel and
//! parses `===LUMA:<name>===` sections out of the result, the same convention
//! as `server_stats`, `web_preview` and `multiplexer`. Connections are cached
//! per host (like `server_stats`) because a status fetch is immediately
//! followed by several diff fetches as the user clicks through files.
//!
//! # Passing paths safely
//!
//! Unlike the sibling features, this one has to send user-controlled values —
//! the working directory and repository-relative paths — to the remote shell.
//! Both are validated here (absolute/relative shape, no `..` segments, no
//! control characters, no single quotes) AND base64-encoded before they reach
//! the script. Because base64 output is drawn from `A-Za-z0-9+/=` only, the
//! encoded value cannot contain a quote, `$`, backtick or newline, so the outer
//! `sh -c '...'` wrapper stays single-quote-free by construction and no
//! metacharacter in a filename can escape into shell syntax. The remote script
//! decodes each value into a shell variable and only ever uses it double-quoted
//! (`cd "$D"`, `git diff -- "$P"`), so filenames containing spaces, `$(…)`,
//! semicolons or newlines are handled as data.
//!
//! `git status` is asked for `-z` (NUL-terminated) records and the section is
//! base64-encoded on the way back, which keeps NUL bytes and exotic filenames
//! intact through a line-based section format. A "plain, un-encoded" fallback
//! for hosts without `base64` would be unreachable: decoding the arguments
//! already requires `base64` on the remote host, so a host that cannot encode
//! the reply could not have decoded the request either.

mod parse;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use russh::ChannelMsg;
use serde::Serialize;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::ssh::{
    connection_config, validate_host_id, AuthenticatedConnection, SshConnectionConfig,
};

// `RepoEntry` travels inside `RepoStatus` and is never named on its own, the
// same shape as `web_preview`'s listener type.
pub use parse::RepoStatus;

/// Whole-script budget. Every script is a handful of cheap git reads, so a slow
/// answer means a wedged connection rather than a busy server.
const EXEC_TIMEOUT: Duration = Duration::from_secs(30);
/// Transport cap for the status script. Only the porcelain section can grow,
/// and it is bounded further by `parse::MAX_ENTRIES` once parsed.
const MAX_STATUS_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
/// Transport cap for diff/file scripts: the payload is capped remotely at
/// `MAX_CONTENT_BYTES`, and base64 inflates it by 4/3 plus line wrapping.
const MAX_CONTENT_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
/// Largest patch or file body handed to the frontend. Anything past this is cut
/// and flagged as truncated rather than erroring.
const MAX_CONTENT_BYTES: usize = 1024 * 1024;
/// Longest accepted directory or repository-relative path.
const MAX_PATH_LENGTH: usize = 4096;
/// Longest accepted revision string.
const MAX_REV_LENGTH: usize = 256;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoDiff {
    /// Unified patch text; empty when the file has no diff of that kind.
    pub patch: String,
    /// The patch hit `MAX_CONTENT_BYTES` and was cut short.
    pub truncated: bool,
    /// The patch was synthesised from an untracked file's contents, since git
    /// produces no diff for a path it does not track.
    pub untracked: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoFile {
    pub content: String,
    pub truncated: bool,
}

struct CachedConnection {
    connection: AuthenticatedConnection,
    // Keeps any ephemeral identity file alive for the lifetime of the
    // connection, mirroring SftpManager and ServerStatsManager.
    _config: SshConnectionConfig,
}

/// Holds one authenticated SSH connection per host so a status fetch and the
/// diff fetches that follow it reuse a session instead of re-handshaking.
#[derive(Default)]
pub struct RepositoryManager {
    connections: Mutex<HashMap<String, Arc<CachedConnection>>>,
}

impl RepositoryManager {
    /// Status of the repository containing `cwd`. A directory outside a work
    /// tree is not an error: it comes back as `is_repo: false`.
    pub async fn status(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        cwd: &str,
    ) -> Result<RepoStatus> {
        validate_host_id(host_id)?;
        let script = status_script(validate_directory(cwd)?);
        let output = self
            .run(
                pool,
                keystore_state,
                host_id,
                script,
                MAX_STATUS_OUTPUT_BYTES,
            )
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let section = |name: &str| sections.get(name).map(String::as_str).unwrap_or("");
        let porcelain = decode_section(section("porcelain"));
        Ok(parse::parse_status(&parse::StatusSections {
            root: section("root"),
            branch: section("branch"),
            symref: section("symref"),
            head: section("head"),
            upstream: section("upstream"),
            track: section("track"),
            porcelain: &porcelain,
        }))
    }

    /// Unified diff for one repository-relative path, staged or unstaged. An
    /// untracked file has no git diff, so its contents are rendered as an
    /// all-added patch instead.
    pub async fn diff(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        cwd: &str,
        path: &str,
        staged: bool,
    ) -> Result<RepoDiff> {
        validate_host_id(host_id)?;
        let cwd = validate_directory(cwd)?;
        let path = validate_repo_path(path)?;
        let output = self
            .run(
                pool,
                keystore_state,
                host_id,
                diff_script(cwd, path, staged),
                MAX_CONTENT_OUTPUT_BYTES,
            )
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let Some(raw_diff) = sections.get("diff") else {
            return Err(script_failed("could not read the diff"));
        };
        let (patch, truncated) = cap_text(decode_section(raw_diff));
        if !patch.is_empty() {
            return Ok(RepoDiff {
                patch,
                truncated,
                untracked: false,
            });
        }
        // No patch and the path is untracked: synthesise one from the file.
        if sections.get("untracked").map(|flag| flag.trim()) == Some("1") {
            let content = sections.get("content").map(String::as_str).unwrap_or("");
            let (content, truncated) = cap_text(decode_section(content));
            return Ok(RepoDiff {
                patch: untracked_patch(path, &content),
                truncated,
                untracked: true,
            });
        }
        Ok(RepoDiff {
            patch,
            truncated,
            untracked: false,
        })
    }

    /// Contents of one repository-relative path, either from a revision
    /// (`git show REV:PATH`) or from the work tree.
    pub async fn file(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        cwd: &str,
        path: &str,
        rev: Option<&str>,
    ) -> Result<RepoFile> {
        validate_host_id(host_id)?;
        let cwd = validate_directory(cwd)?;
        let path = validate_repo_path(path)?;
        let rev = rev.map(validate_rev).transpose()?;
        let output = self
            .run(
                pool,
                keystore_state,
                host_id,
                file_script(cwd, path, rev),
                MAX_CONTENT_OUTPUT_BYTES,
            )
            .await?;
        let sections = crate::server_stats::split_sections(&output);
        let Some(raw) = sections.get("content") else {
            return Err(script_failed("could not read the file"));
        };
        let (content, truncated) = cap_text(decode_section(raw));
        Ok(RepoFile { content, truncated })
    }

    pub async fn close(&self, host_id: &str) -> Result<()> {
        validate_host_id(host_id)?;
        if let Some(cached) = self.remove(host_id) {
            let _ = cached
                .connection
                .disconnect(russh::Disconnect::ByApplication, "repository closed", "en")
                .await;
            tracing::info!(host_id = %host_id, "closed repository connection");
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let count = {
            let mut connections = self.connections.lock().unwrap();
            let count = connections.len();
            connections.clear();
            count
        };
        if count > 0 {
            tracing::info!(count, "dropped repository connections on shutdown");
        }
    }

    /// Runs one script on the host's cached connection, reconnecting once if the
    /// cached session died since the previous call.
    async fn run(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        script: String,
        max_output: usize,
    ) -> Result<String> {
        let (cached, was_cached) = self.get_or_connect(pool, keystore_state, host_id).await?;
        match run_script(&cached.connection, &script, max_output).await {
            Ok(output) => Ok(output),
            Err(error) => {
                self.remove(host_id);
                if !was_cached {
                    return Err(error);
                }
                let (fresh, _) = self.get_or_connect(pool, keystore_state, host_id).await?;
                match run_script(&fresh.connection, &script, max_output).await {
                    Ok(output) => Ok(output),
                    Err(retry_error) => {
                        self.remove(host_id);
                        Err(retry_error)
                    }
                }
            }
        }
    }

    async fn get_or_connect(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<(Arc<CachedConnection>, bool)> {
        if let Some(cached) = self.connections.lock().unwrap().get(host_id) {
            return Ok((Arc::clone(cached), true));
        }
        let (mut config, _) = connection_config(pool, keystore_state, host_id).await?;
        // Repository reads are exec channels, never the host's interactive
        // startup command.
        config.startup_command = None;
        let connection = crate::ssh::authenticated_handle(&config).await?;
        let cached = Arc::new(CachedConnection {
            connection,
            _config: config,
        });
        let mut connections = self.connections.lock().unwrap();
        // A concurrent call may have connected first; keep the existing one.
        let entry = Arc::clone(
            connections
                .entry(host_id.to_string())
                .or_insert_with(|| Arc::clone(&cached)),
        );
        drop(connections);
        tracing::info!(host_id = %host_id, "opened repository connection");
        Ok((entry, false))
    }

    fn remove(&self, host_id: &str) -> Option<Arc<CachedConnection>> {
        self.connections.lock().unwrap().remove(host_id)
    }
}

// --- Validation -------------------------------------------------------------

/// The working directory reported by the terminal's OSC 7 shell integration.
/// Must be absolute, and free of anything that has no business in a path.
fn validate_directory(cwd: &str) -> Result<&str> {
    if cwd.is_empty() || cwd.len() > MAX_PATH_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "working directory must be 1-{MAX_PATH_LENGTH} bytes"
        )));
    }
    if !cwd.starts_with('/') {
        return Err(LumaError::InvalidInput(
            "working directory must be an absolute path".into(),
        ));
    }
    reject_unsafe_characters(cwd, "working directory")?;
    Ok(cwd)
}

/// A path from the status listing: relative to the work-tree root, with no
/// traversal. Traversal is rejected even though the remote `cd` lands in the
/// repository root first — it would otherwise let the dialog read files outside
/// the repository the user is looking at.
fn validate_repo_path(path: &str) -> Result<&str> {
    if path.is_empty() || path.len() > MAX_PATH_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "path must be 1-{MAX_PATH_LENGTH} bytes"
        )));
    }
    if path.starts_with('/') {
        return Err(LumaError::InvalidInput(
            "path must be relative to the repository root".into(),
        ));
    }
    reject_unsafe_characters(path, "path")?;
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(LumaError::InvalidInput(
                "path must not contain empty or traversal segments".into(),
            ));
        }
    }
    Ok(path)
}

/// Conservative revision syntax: branch names, tags and shas. Ranges, options
/// and revision modifiers (`^`, `~`, `@{…}`) are rejected because the browser
/// never needs them.
fn validate_rev(rev: &str) -> Result<&str> {
    if rev.is_empty() || rev.len() > MAX_REV_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "revision must be 1-{MAX_REV_LENGTH} bytes"
        )));
    }
    if rev.starts_with('-') || rev.contains("..") {
        return Err(LumaError::InvalidInput("invalid revision".into()));
    }
    if !rev
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
    {
        return Err(LumaError::InvalidInput("invalid revision".into()));
    }
    Ok(rev)
}

/// Single quotes and control characters (NUL included) are rejected outright.
/// Base64 already neutralises them on the way to the shell; rejecting them is a
/// second, cheaper line of defence that also catches obvious tampering.
fn reject_unsafe_characters(value: &str, label: &str) -> Result<()> {
    if value.contains('\'') {
        return Err(LumaError::InvalidInput(format!(
            "{label} must not contain single quotes"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(LumaError::InvalidInput(format!(
            "{label} must not contain control characters"
        )));
    }
    Ok(())
}

// --- Script construction ----------------------------------------------------

/// Shell prelude shared by every script: decode the working directory, enter it,
/// then move to the work-tree root so that every path in and out of git is
/// root-relative. Bails out (producing no sections at all) when the directory is
/// gone or is not inside a repository.
///
/// `X` is the base64 decoder; GNU/busybox spell the decode flag `-d` and older
/// BSD/macOS builds `-D`, so both are tried.
fn prelude(cwd: &str) -> String {
    let cwd = STANDARD.encode(cwd);
    format!(
        "exec 2>/dev/null; \
         X(){{ R=$(printf %s \"$1\" | base64 -d); [ -n \"$R\" ] || R=$(printf %s \"$1\" | base64 -D); printf %s \"$R\"; }}; \
         D=$(X \"{cwd}\"); [ -n \"$D\" ] || exit 3; cd \"$D\" || exit 3; \
         G=$(git rev-parse --show-toplevel); [ -n \"$G\" ] || exit 4; cd \"$G\" || exit 4"
    )
}

/// Wraps a script body for a remote login shell of unknown flavour. The body is
/// single-quote-free by construction (all user values are base64), so the
/// single-quoted wrapper is exact.
fn wrap(body: String) -> String {
    debug_assert!(!body.contains('\''), "script body must be quote-free");
    debug_assert!(!body.contains('\n'), "script body must be a single line");
    format!("sh -c '{body}'")
}

fn section(name: &str) -> String {
    format!("; printf \"\\n===LUMA:{name}===\\n\"; ")
}

fn status_script(cwd: &str) -> String {
    let mut body = prelude(cwd);
    body.push_str(&section("root"));
    body.push_str("printf %s \"$G\"");
    body.push_str(&section("branch"));
    body.push_str("git rev-parse --abbrev-ref HEAD");
    body.push_str(&section("symref"));
    body.push_str("git symbolic-ref --short HEAD");
    body.push_str(&section("head"));
    body.push_str("git rev-parse --short HEAD");
    body.push_str(&section("upstream"));
    body.push_str("git rev-parse --abbrev-ref @{u}");
    body.push_str(&section("track"));
    body.push_str("git rev-list --left-right --count @{u}...HEAD");
    body.push_str(&section("porcelain"));
    // -z keeps git from quoting exotic filenames; base64 keeps the NULs alive
    // through the line-based section format.
    body.push_str("git status --porcelain=v1 -z --untracked-files=all | base64");
    wrap(body)
}

fn diff_script(cwd: &str, path: &str, staged: bool) -> String {
    let mut body = prelude(cwd);
    body.push_str(&format!("; P=$(X \"{}\")", STANDARD.encode(path)));
    body.push_str("; [ -n \"$P\" ] || exit 5");
    body.push_str(&section("diff"));
    let staged_flag = if staged { "--cached " } else { "" };
    // One byte past the cap so a payload that fills it can be reported as
    // truncated rather than silently ending on a hunk boundary.
    let cap = MAX_CONTENT_BYTES + 1;
    body.push_str(&format!(
        "git diff --no-color {staged_flag}-- \"$P\" | head -c {cap} | base64"
    ));
    body.push_str("; U=$(git ls-files --others --exclude-standard -- \"$P\")");
    body.push_str(&section("untracked"));
    body.push_str("[ -n \"$U\" ] && printf 1");
    body.push_str(&section("content"));
    // Read through a redirect so the filename is never an argument to head.
    body.push_str(&format!("[ -n \"$U\" ] && head -c {cap} < \"$P\" | base64"));
    wrap(body)
}

fn file_script(cwd: &str, path: &str, rev: Option<&str>) -> String {
    let mut body = prelude(cwd);
    body.push_str(&format!("; P=$(X \"{}\")", STANDARD.encode(path)));
    body.push_str("; [ -n \"$P\" ] || exit 5");
    let cap = MAX_CONTENT_BYTES + 1;
    let reader = match rev {
        Some(rev) => {
            body.push_str(&format!("; V=$(X \"{}\")", STANDARD.encode(rev)));
            body.push_str("; [ -n \"$V\" ] || exit 6");
            "git show \"$V:$P\"".to_string()
        }
        None => "cat < \"$P\"".to_string(),
    };
    body.push_str(&section("content"));
    body.push_str(&format!("{reader} | head -c {cap} | base64"));
    wrap(body)
}

// --- Output handling --------------------------------------------------------

/// Decodes a base64 section, ignoring the line wrapping `base64(1)` applies.
/// A section that is not valid base64 is passed through verbatim: that only
/// happens when the remote `base64` misbehaved, and showing its raw output beats
/// showing nothing.
fn decode_section(section: &str) -> Vec<u8> {
    let compact: String = section
        .chars()
        .filter(|c| !c.is_ascii_whitespace())
        .collect();
    if compact.is_empty() {
        return Vec::new();
    }
    STANDARD
        .decode(compact)
        .unwrap_or_else(|_| section.as_bytes().to_vec())
}

/// Caps a payload at `MAX_CONTENT_BYTES`, reporting whether it was cut. Lossy
/// conversion also repairs the partial UTF-8 sequence a byte-wise cut can leave.
fn cap_text(bytes: Vec<u8>) -> (String, bool) {
    let truncated = bytes.len() > MAX_CONTENT_BYTES;
    let slice = if truncated {
        &bytes[..MAX_CONTENT_BYTES]
    } else {
        &bytes[..]
    };
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

/// Renders an untracked file as an all-added patch so the viewer has something
/// to show for a path git itself will not diff.
fn untracked_patch(path: &str, content: &str) -> String {
    let mut patch = format!(
        "diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n"
    );
    if content.is_empty() {
        return patch;
    }
    let trailing_newline = content.ends_with('\n');
    let body = if trailing_newline {
        &content[..content.len() - 1]
    } else {
        content
    };
    let lines: Vec<&str> = body.split('\n').collect();
    patch.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
    for line in &lines {
        patch.push('+');
        patch.push_str(line);
        patch.push('\n');
    }
    if !trailing_newline {
        patch.push_str("\\ No newline at end of file\n");
    }
    patch
}

// --- Exec channel -----------------------------------------------------------

async fn run_script(
    connection: &AuthenticatedConnection,
    script: &str,
    max_output: usize,
) -> Result<String> {
    let operation = async {
        let mut channel = connection
            .channel_open_session()
            .await
            .map_err(exec_error)?;
        channel
            .exec(true, script.as_bytes())
            .await
            .map_err(exec_error)?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    let remaining = max_output.saturating_sub(output.len());
                    output.extend_from_slice(&data[..data.len().min(remaining)]);
                }
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    };
    tokio::time::timeout(EXEC_TIMEOUT, operation)
        .await
        .map_err(|_| LumaError::SshConnection {
            category: "timeout",
            message: "repository command timed out".into(),
        })?
}

fn exec_error(error: russh::Error) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("repository exec failed: {error}"),
    }
}

/// The script bailed out before printing its sections: the directory is gone,
/// it is not inside a repository, or git is missing.
fn script_failed(what: &str) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("{what}: the directory is no longer a git repository on the host"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE64_ALPHABET: &str =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

    fn body_of(script: &str) -> &str {
        assert!(script.starts_with("sh -c '"), "{script}");
        assert!(script.ends_with('\''), "{script}");
        &script["sh -c '".len()..script.len() - 1]
    }

    /// Every script must survive an arbitrary login shell inside `sh -c '...'`.
    fn assert_wrapper_intact(script: &str) {
        let body = body_of(script);
        assert!(
            !body.contains('\''),
            "body must be single-quote free: {body}"
        );
        assert!(!body.contains('\n'), "body must be one line: {body}");
    }

    #[test]
    fn status_script_is_quote_free_and_marks_every_section() {
        let script = status_script("/home/dev/project");
        assert_wrapper_intact(&script);
        for name in [
            "root",
            "branch",
            "symref",
            "head",
            "upstream",
            "track",
            "porcelain",
        ] {
            assert!(script.contains(&format!("===LUMA:{name}===")), "{name}");
        }
        assert!(script.contains("git status --porcelain=v1 -z --untracked-files=all | base64"));
        assert!(script.contains("git rev-parse --show-toplevel"));
    }

    #[test]
    fn diff_script_selects_staged_or_worktree_changes() {
        let unstaged = diff_script("/srv/app", "src/main.rs", false);
        assert_wrapper_intact(&unstaged);
        assert!(unstaged.contains("git diff --no-color -- \"$P\""));
        assert!(!unstaged.contains("--cached"));

        let staged = diff_script("/srv/app", "src/main.rs", true);
        assert_wrapper_intact(&staged);
        assert!(staged.contains("git diff --no-color --cached -- \"$P\""));
        for name in ["diff", "untracked", "content"] {
            assert!(staged.contains(&format!("===LUMA:{name}===")), "{name}");
        }
    }

    #[test]
    fn file_script_reads_a_revision_or_the_work_tree() {
        let work_tree = file_script("/srv/app", "src/main.rs", None);
        assert_wrapper_intact(&work_tree);
        assert!(work_tree.contains("cat < \"$P\""));
        assert!(!work_tree.contains("git show"));

        let revision = file_script("/srv/app", "src/main.rs", Some("HEAD"));
        assert_wrapper_intact(&revision);
        assert!(revision.contains("git show \"$V:$P\""));
    }

    #[test]
    fn scripts_cap_their_payload_one_byte_past_the_limit() {
        let expected = format!("head -c {} ", MAX_CONTENT_BYTES + 1);
        assert!(diff_script("/a", "b", false).contains(&expected));
        assert!(file_script("/a", "b", None).contains(&expected));
    }

    /// The heart of the safety argument: hostile values never appear literally
    /// in the script, only as base64 that decodes into a shell VARIABLE.
    #[test]
    fn hostile_paths_are_neutralised_by_base64() {
        // Filenames like these are legal on disk, so they must be accepted and
        // rendered harmless rather than rejected.
        for path in [
            "src/$(rm -rf ~).rs",
            "src/`id`.rs",
            "a;rm -rf ~",
            "a|b",
            "a&b",
            "a\"b\".rs",
            "a b/c d.rs",
            "-rf",
            "--upload-pack=evil",
            "a\\b.rs",
            "a$IFS.rs",
            "café/naïve.rs",
        ] {
            let path = validate_repo_path(path).expect("legal filename");
            for script in [
                diff_script("/srv/app", path, false),
                diff_script("/srv/app", path, true),
                file_script("/srv/app", path, None),
            ] {
                assert_wrapper_intact(&script);
                let body = body_of(&script);
                assert!(
                    !body.contains(path),
                    "raw path leaked into the script: {body}"
                );
                assert!(body.contains(&STANDARD.encode(path)));
            }
        }
    }

    #[test]
    fn encoded_values_only_use_the_base64_alphabet() {
        let script = diff_script("/srv/dev ops/$(id)", "a b/`x`.rs", false);
        let body = body_of(&script);
        for encoded in [
            STANDARD.encode("/srv/dev ops/$(id)"),
            STANDARD.encode("a b/`x`.rs"),
        ] {
            assert!(encoded.chars().all(|c| BASE64_ALPHABET.contains(c)));
            assert!(body.contains(&encoded));
        }
    }

    #[test]
    fn directories_must_be_absolute_and_tame() {
        assert!(validate_directory("/home/dev/project").is_ok());
        assert!(validate_directory("/home/dev/my project").is_ok());
        assert!(validate_directory("/home/dev/$(id)").is_ok());
        assert!(validate_directory("relative/path").is_err());
        assert!(validate_directory("").is_err());
        assert!(validate_directory("/home/dev/it's").is_err());
        assert!(validate_directory("/home/dev/\nrm -rf /").is_err());
        assert!(validate_directory("/home/dev/\0").is_err());
        assert!(validate_directory("/home/dev/\u{7f}").is_err());
        assert!(validate_directory(&format!("/{}", "x".repeat(MAX_PATH_LENGTH))).is_err());
    }

    #[test]
    fn repository_paths_must_be_relative_without_traversal() {
        assert!(validate_repo_path("src/main.rs").is_ok());
        assert!(validate_repo_path("a b.rs").is_ok());
        assert!(validate_repo_path("..hidden.rs").is_ok());
        assert!(validate_repo_path("/etc/passwd").is_err());
        assert!(validate_repo_path("../../etc/passwd").is_err());
        assert!(validate_repo_path("src/../../etc/passwd").is_err());
        assert!(validate_repo_path("src/./main.rs").is_err());
        assert!(validate_repo_path("src//main.rs").is_err());
        // A directory-looking path has a trailing empty segment.
        assert!(validate_repo_path("src/").is_err());
        assert!(validate_repo_path("").is_err());
        assert!(validate_repo_path("a'b.rs").is_err());
        assert!(validate_repo_path("a\nb.rs").is_err());
        assert!(validate_repo_path("a\0b.rs").is_err());
    }

    #[test]
    fn revisions_reject_options_ranges_and_metacharacters() {
        assert!(validate_rev("HEAD").is_ok());
        assert!(validate_rev("1a2b3c4").is_ok());
        assert!(validate_rev("origin/main").is_ok());
        assert!(validate_rev("v1.2.3").is_ok());
        assert!(validate_rev("").is_err());
        assert!(validate_rev("-o").is_err());
        assert!(validate_rev("HEAD~1").is_err());
        assert!(validate_rev("HEAD^").is_err());
        assert!(validate_rev("@{u}").is_err());
        assert!(validate_rev("main...other").is_err());
        assert!(validate_rev("a'b").is_err());
        assert!(validate_rev("$(id)").is_err());
        assert!(validate_rev(&"x".repeat(MAX_REV_LENGTH + 1)).is_err());
    }

    #[test]
    fn sections_decode_through_base64_line_wrapping() {
        let payload = b"M  a\0 M b\0";
        let encoded = STANDARD.encode(payload);
        let wrapped = format!("{}\n{}\n", &encoded[..4], &encoded[4..]);
        assert_eq!(decode_section(&wrapped), payload);
        assert_eq!(decode_section(""), Vec::<u8>::new());
        assert_eq!(decode_section("   \n "), Vec::<u8>::new());
        // Not base64 at all: passed through rather than lost.
        assert_eq!(decode_section("!!not base64!!"), b"!!not base64!!".to_vec());
    }

    #[test]
    fn payloads_are_capped_and_flagged() {
        let (text, truncated) = cap_text(b"short".to_vec());
        assert_eq!(text, "short");
        assert!(!truncated);

        let (text, truncated) = cap_text(vec![b'x'; MAX_CONTENT_BYTES + 10]);
        assert_eq!(text.len(), MAX_CONTENT_BYTES);
        assert!(truncated);

        // A cut through a multi-byte character must not produce invalid UTF-8.
        let mut oversized = "é".repeat(MAX_CONTENT_BYTES).into_bytes();
        oversized.truncate(MAX_CONTENT_BYTES + 1);
        let (text, truncated) = cap_text(oversized);
        assert!(truncated);
        assert!(text.chars().count() <= MAX_CONTENT_BYTES);
    }

    #[test]
    fn untracked_files_render_as_all_added_patches() {
        let patch = untracked_patch("src/new.rs", "one\ntwo\n");
        assert!(patch.starts_with("diff --git a/src/new.rs b/src/new.rs\n"));
        assert!(patch.contains("--- /dev/null\n+++ b/src/new.rs\n"));
        assert!(patch.contains("@@ -0,0 +1,2 @@\n+one\n+two\n"));
        assert!(!patch.contains("No newline"));
    }

    #[test]
    fn untracked_patches_mark_a_missing_trailing_newline() {
        let patch = untracked_patch("a.txt", "only");
        assert!(patch.contains("@@ -0,0 +1,1 @@\n+only\n"));
        assert!(patch.ends_with("\\ No newline at end of file\n"));
    }

    #[test]
    fn empty_untracked_files_have_no_hunk() {
        let patch = untracked_patch("empty.txt", "");
        assert!(patch.ends_with("+++ b/empty.txt\n"));
        assert!(!patch.contains("@@"));
    }
}
