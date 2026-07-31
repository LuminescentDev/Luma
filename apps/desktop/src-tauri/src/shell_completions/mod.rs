//! Remote completion sources for the terminal autocomplete overlay.
//!
//! Two batched exec probes over the host's existing SSH configuration, run with
//! the same conventions as `server_stats` / `web_preview`: one single-quote-free
//! `sh -c '...'` line, bounded output, hard timeout, and a cached authenticated
//! connection reused across probes.
//!
//! - executables: `ls` of every `$PATH` directory, for first-token completion.
//! - paths: `ls -A1p` of one directory, for path-token completion.
//!
//! Nothing here leaves the machine beyond the SSH session the user already
//! opened, and no output is logged.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use russh::ChannelMsg;
use sqlx::SqlitePool;

use crate::errors::{LumaError, Result};
use crate::keystore::KeystoreState;
use crate::ssh::{
    connection_config, validate_host_id, AuthenticatedConnection, SshConnectionConfig,
};

/// Both probes are a handful of `ls` calls; a slow answer means a wedged
/// connection rather than a busy server.
const EXEC_TIMEOUT: Duration = Duration::from_secs(15);
/// Output beyond the cap is truncated, never an error.
const MAX_OUTPUT_BYTES: usize = 512 * 1024;
/// Hard cap on names handed to the frontend, per source.
const MAX_NAMES: usize = 8000;
/// A single name longer than this is not something anyone is completing.
const MAX_NAME_LENGTH: usize = 512;
/// Directory listings are cheap but not free; re-fetch only after this long so
/// arrow-key browsing through a path does not re-exec per keystroke.
const PATH_CACHE_TTL: Duration = Duration::from_secs(15);
/// Most directories cached per host before the cache is dropped wholesale.
const MAX_CACHED_DIRS: usize = 64;
const MAX_DIR_LENGTH: usize = 4096;

/// Cache key for a directory listing: (host id, quoted directory).
type PathCacheKey = (String, String);
/// Cached directory listing: when it was fetched, and the names.
type PathCacheEntry = (Instant, Arc<Vec<String>>);

struct CachedConnection {
    connection: AuthenticatedConnection,
    // Keeps any ephemeral identity file alive for the lifetime of the
    // connection, mirroring ServerStatsManager.
    _config: SshConnectionConfig,
}

/// Holds one authenticated SSH connection per host plus the per-host completion
/// caches. Connections open lazily on the first probe and are dropped on probe
/// failure or shutdown.
#[derive(Default)]
pub struct ShellCompletionsManager {
    connections: Mutex<HashMap<String, Arc<CachedConnection>>>,
    /// `$PATH` executables per host — collected once and kept for the lifetime
    /// of the app, since a host's installed binaries barely change.
    executables: Mutex<HashMap<String, Arc<Vec<String>>>>,
    /// (host, directory) → (fetched at, names). Entries expire after
    /// `PATH_CACHE_TTL`.
    paths: Mutex<HashMap<PathCacheKey, PathCacheEntry>>,
}

impl ShellCompletionsManager {
    /// Names of every executable-looking entry on the host's `$PATH`, sorted and
    /// deduped. Cached per host after the first call.
    pub async fn executables(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
    ) -> Result<Vec<String>> {
        validate_host_id(host_id)?;
        if let Some(cached) = self.executables.lock().unwrap().get(host_id) {
            return Ok(cached.as_ref().clone());
        }
        let output = self
            .exec(pool, keystore_state, host_id, &executables_script())
            .await?;
        let names = Arc::new(parse_names(&output, false));
        self.executables
            .lock()
            .unwrap()
            .insert(host_id.to_string(), Arc::clone(&names));
        Ok(names.as_ref().clone())
    }

    /// Entries of one remote directory. Directories keep the trailing `/` that
    /// `ls -p` appends, so the frontend can render and complete them as such.
    /// Cached per (host, directory) for `PATH_CACHE_TTL`.
    pub async fn paths(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        dir: &str,
    ) -> Result<Vec<String>> {
        validate_host_id(host_id)?;
        let quoted = quote_dir(dir)?;
        let key = (host_id.to_string(), quoted.clone());
        if let Some((fetched_at, names)) = self.paths.lock().unwrap().get(&key) {
            if fetched_at.elapsed() < PATH_CACHE_TTL {
                return Ok(names.as_ref().clone());
            }
        }
        let output = self
            .exec(pool, keystore_state, host_id, &paths_script(&quoted))
            .await?;
        let names = Arc::new(parse_names(&output, true));
        let mut cache = self.paths.lock().unwrap();
        // Bounded rather than LRU: the working set is a handful of directories,
        // and dropping it wholesale costs one re-exec.
        if cache.len() >= MAX_CACHED_DIRS {
            cache.clear();
        }
        cache.insert(key, (Instant::now(), Arc::clone(&names)));
        drop(cache);
        Ok(names.as_ref().clone())
    }

    /// Run one probe script, reconnecting once if a previously cached session
    /// has died since the last probe.
    async fn exec(
        &self,
        pool: &SqlitePool,
        keystore_state: &KeystoreState,
        host_id: &str,
        script: &str,
    ) -> Result<String> {
        let (cached, was_cached) = self.get_or_connect(pool, keystore_state, host_id).await?;
        match run_script(&cached.connection, script).await {
            Ok(output) => Ok(output),
            Err(error) => {
                self.remove(host_id);
                if !was_cached {
                    return Err(error);
                }
                let (fresh, _) = self.get_or_connect(pool, keystore_state, host_id).await?;
                match run_script(&fresh.connection, script).await {
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
        config.startup_command = None;
        let connection = crate::ssh::authenticated_handle(&config).await?;
        let cached = Arc::new(CachedConnection {
            connection,
            _config: config,
        });
        let mut connections = self.connections.lock().unwrap();
        // A concurrent probe may have connected first; keep the existing one.
        let entry = Arc::clone(
            connections
                .entry(host_id.to_string())
                .or_insert_with(|| Arc::clone(&cached)),
        );
        drop(connections);
        tracing::info!(host_id = %host_id, "opened shell completions connection");
        Ok((entry, false))
    }

    fn remove(&self, host_id: &str) -> Option<Arc<CachedConnection>> {
        self.connections.lock().unwrap().remove(host_id)
    }

    /// Drop every cached connection and completion set (app shutdown).
    pub fn kill_all(&self) {
        let count = {
            let mut connections = self.connections.lock().unwrap();
            let count = connections.len();
            connections.clear();
            count
        };
        self.executables.lock().unwrap().clear();
        self.paths.lock().unwrap().clear();
        if count > 0 {
            tracing::info!(count, "dropped shell completion connections on shutdown");
        }
    }
}

/// One `ls` per `$PATH` entry. Word splitting on the unquoted `$(...)` is
/// deliberate — that is what turns the colon-separated list into arguments.
fn executables_script() -> String {
    let body = r#"exec 2>/dev/null; for d in $(echo $PATH | tr : " "); do ls "$d"; done"#;
    debug_assert!(!body.contains('\''));
    format!("sh -c '{body}'")
}

/// `-A` includes dotfiles but not `.`/`..`; `-1` is one name per line; `-p`
/// marks directories with a trailing `/`.
fn paths_script(quoted_dir: &str) -> String {
    let body = format!(r#"exec 2>/dev/null; ls -A1p "{quoted_dir}""#);
    debug_assert!(!body.contains('\''));
    format!("sh -c '{body}'")
}

/// Validate a directory for interpolation into the double-quoted `ls` argument
/// inside the single-quoted `sh -c` body. Anything that could terminate either
/// quoting context or trigger an expansion is rejected outright rather than
/// escaped, so there is no escaping bug to get wrong. A leading `~` is rewritten
/// to `$HOME` because tilde expansion does not happen inside double quotes.
fn quote_dir(dir: &str) -> Result<String> {
    let invalid = || LumaError::InvalidInput("dir is invalid".into());
    if dir.is_empty() || dir.len() > MAX_DIR_LENGTH {
        return Err(invalid());
    }
    if dir
        .chars()
        .any(|c| matches!(c, '\'' | '"' | '`' | '$' | '\\') || c.is_control())
    {
        return Err(invalid());
    }
    if dir == "~" {
        return Ok("$HOME".to_string());
    }
    if let Some(rest) = dir.strip_prefix("~/") {
        return Ok(format!("$HOME/{rest}"));
    }
    Ok(dir.to_string())
}

/// Split an `ls` blob into sorted, deduped, bounded names. `keep_slash` retains
/// the trailing `/` that `ls -p` puts on directories (path completion wants it;
/// `$PATH` executables never have one).
fn parse_names(output: &str, keep_slash: bool) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut names: Vec<String> = Vec::new();
    for line in output.lines() {
        let name = line.trim_end_matches(['\r', ' ']);
        if name.is_empty() || name.len() > MAX_NAME_LENGTH {
            continue;
        }
        // `ls` prints "<dir>:" headers when handed several directories, and a
        // name containing a separator is not a plain entry. Byte-slicing to
        // drop the `-p` marker would panic on a multi-byte final character, so
        // strip the suffix as a char.
        let core = if keep_slash {
            name.strip_suffix('/').unwrap_or(name)
        } else {
            name
        };
        if core.contains('/') {
            continue;
        }
        if !seen.insert(name) {
            continue;
        }
        names.push(name.to_string());
        if names.len() >= MAX_NAMES {
            break;
        }
    }
    names.sort_unstable();
    names
}

async fn run_script(connection: &AuthenticatedConnection, script: &str) -> Result<String> {
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
                    let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
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
            message: "shell completion probe timed out".into(),
        })?
}

fn exec_error(error: russh::Error) -> LumaError {
    LumaError::SshConnection {
        category: "ssh-error",
        message: format!("shell completion exec failed: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_shell_safe(script: &str) {
        assert!(script.starts_with("sh -c '"));
        assert!(script.ends_with('\''));
        // Multi-line quoted strings break under csh-style login shells; the
        // inner body must also never terminate the outer quoting early.
        assert!(!script.contains('\n'));
        let body = &script["sh -c '".len()..script.len() - 1];
        assert!(!body.contains('\''));
    }

    #[test]
    fn scripts_are_single_line_and_single_quote_free() {
        assert_shell_safe(&executables_script());
        assert_shell_safe(&paths_script("/usr/local/bin"));
        assert_shell_safe(&paths_script(&quote_dir("~/src").unwrap()));
        assert!(executables_script().contains("$PATH"));
        assert!(paths_script("/tmp").contains("ls -A1p \"/tmp\""));
    }

    #[test]
    fn quote_dir_rewrites_tilde_and_rejects_expansion() {
        assert_eq!(quote_dir("/var/log").unwrap(), "/var/log");
        assert_eq!(quote_dir("~").unwrap(), "$HOME");
        assert_eq!(quote_dir("~/projects/api").unwrap(), "$HOME/projects/api");
        // A directory that could break out of, or expand inside, the quoting.
        for bad in [
            "",
            "/tmp'; rm -rf /; echo '",
            "/tmp\"",
            "/tmp/`id`",
            "/tmp/$HOME",
            "/tmp\\x",
            "/tmp\nls",
        ] {
            assert!(quote_dir(bad).is_err(), "should reject {bad:?}");
        }
        assert!(quote_dir(&"a".repeat(MAX_DIR_LENGTH + 1)).is_err());
    }

    #[test]
    fn parse_names_dedups_sorts_and_bounds() {
        let output = "zsh\nbash\nbash\n\nls\n";
        assert_eq!(parse_names(output, false), vec!["bash", "ls", "zsh"]);

        // `ls` headers and nested names are dropped from the executables list.
        assert_eq!(parse_names("/usr/bin:\nawk\n", false), vec!["awk"]);

        // Path listings keep the `-p` directory marker.
        let listing = "src/\nCargo.toml\n.env\n";
        assert_eq!(
            parse_names(listing, true),
            vec![".env", "Cargo.toml", "src/"]
        );

        let many = (0..MAX_NAMES + 500)
            .map(|index| format!("name{index:06}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(parse_names(&many, false).len(), MAX_NAMES);
    }

    #[test]
    fn parse_names_handles_multibyte_names() {
        // Dropping the `-p` marker by byte index would split the final `é`.
        assert_eq!(
            parse_names("café\ndossier é/\n", true),
            vec!["café", "dossier é/"]
        );
    }

    #[test]
    fn parse_names_drops_overlong_entries() {
        let long = "x".repeat(MAX_NAME_LENGTH + 1);
        let output = format!("ok\n{long}\n");
        assert_eq!(parse_names(&output, false), vec!["ok"]);
    }
}
