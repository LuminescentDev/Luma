//! Per-scope command history backing the terminal autocomplete overlay.
//!
//! Commands are user data. They are recorded only while the (off-by-default)
//! autocomplete setting is on, they are never written to the log, and lines
//! that look secret-bearing are dropped here as well as in the frontend so a
//! future caller cannot bypass the filter. The table is device-local: it has no
//! vault and writes no tombstones, so it is outside the sync surface.

use serde::Serialize;
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

/// Newest rows kept per scope; older entries are pruned on every insert so a
/// long-lived host cannot grow the table without bound.
pub const MAX_ROWS_PER_SCOPE: i64 = 2000;
/// A prompt line longer than this is a paste or a here-doc, not something worth
/// completing.
const MAX_COMMAND_LENGTH: usize = 4096;
const MAX_SCOPE_KEY_LENGTH: usize = 256;
/// Upper bound on rows a single query may return, whatever the caller asks for.
const MAX_QUERY_LIMIT: i64 = 100;

/// Substrings that make a command line likely to carry a credential. Matched
/// case-insensitively against the whole line; a hit means the line is never
/// stored.
const SECRET_SUBSTRINGS: &[&str] = &[
    "password",
    "passwd",
    "token",
    "secret",
    "api_key",
    "api-key",
    "apikey",
    "credential",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub command: String,
    pub use_count: i64,
    pub last_used_at: i64,
}

fn validate_scope_key(scope_key: &str) -> Result<()> {
    if scope_key.trim().is_empty()
        || scope_key.len() > MAX_SCOPE_KEY_LENGTH
        || scope_key.contains('\0')
    {
        return Err(LumaError::InvalidInput("scopeKey is invalid".into()));
    }
    Ok(())
}

/// Whether a command line looks like it carries a credential and must never be
/// persisted. Deliberately over-eager: a false positive only costs one missing
/// suggestion, a false negative writes a secret to disk.
pub fn looks_secret_bearing(command: &str) -> bool {
    let lowered = command.to_ascii_lowercase();
    if SECRET_SUBSTRINGS
        .iter()
        .any(|needle| lowered.contains(needle))
    {
        return true;
    }
    // `mysql -pHunter2` — a short flag with its value glued on. `-p` alone (and
    // long flags such as `--prefix`) stay recordable.
    lowered.split_whitespace().any(|token| {
        !token.starts_with("--") && token.starts_with("-p") && token.chars().count() > 2
    })
}

/// Whether a line is eligible for history at all.
fn is_recordable(command: &str) -> bool {
    // The classic "don't record" convention: a leading space is how a user tells
    // their shell (HISTCONTROL=ignorespace) to forget the line, so honor it too.
    if command.starts_with(|c: char| c.is_whitespace()) {
        return false;
    }
    if command.trim().is_empty() || command.len() > MAX_COMMAND_LENGTH {
        return false;
    }
    if command.contains(['\0', '\n', '\r']) {
        return false;
    }
    !looks_secret_bearing(command)
}

/// Record one executed command, bumping `use_count`/`last_used_at` when the
/// (scope, command) pair already exists. Returns whether the line was stored;
/// filtered lines (empty, leading space, secret-bearing, oversized) are a silent
/// no-op rather than an error, because the caller records opportunistically.
pub async fn record(pool: &SqlitePool, scope_key: &str, command: &str) -> Result<bool> {
    validate_scope_key(scope_key)?;
    if !is_recordable(command) {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO command_history (scope_key, command, last_used_at, use_count)
         VALUES (?1, ?2, unixepoch(), 1)
         ON CONFLICT(scope_key, command) DO UPDATE SET
             use_count = command_history.use_count + 1,
             last_used_at = unixepoch()",
    )
    .bind(scope_key)
    .bind(command)
    .execute(pool)
    .await?;
    prune(pool, scope_key).await?;
    Ok(true)
}

/// Prefix-matched history for one scope, most-used first. The match is
/// case-sensitive (SQLite's BINARY collation): the overlay completes by writing
/// only the missing suffix, so a case-insensitive hit would corrupt the line.
/// An empty prefix matches everything.
pub async fn query(
    pool: &SqlitePool,
    scope_key: &str,
    prefix: &str,
    limit: i64,
) -> Result<Vec<CommandHistoryEntry>> {
    validate_scope_key(scope_key)?;
    if prefix.len() > MAX_COMMAND_LENGTH || prefix.contains('\0') {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_QUERY_LIMIT);
    let rows = sqlx::query(
        "SELECT command, use_count, last_used_at FROM command_history
         WHERE scope_key = ?1 AND substr(command, 1, length(?2)) = ?2
         ORDER BY use_count DESC, last_used_at DESC
         LIMIT ?3",
    )
    .bind(scope_key)
    .bind(prefix)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row: &sqlx::sqlite::SqliteRow| CommandHistoryEntry {
            command: row.get("command"),
            use_count: row.get("use_count"),
            last_used_at: row.get("last_used_at"),
        })
        .collect())
}

/// Drop everything past the newest `MAX_ROWS_PER_SCOPE` rows of one scope.
/// Returns how many rows were removed.
pub async fn prune(pool: &SqlitePool, scope_key: &str) -> Result<u64> {
    validate_scope_key(scope_key)?;
    let result = sqlx::query(
        "DELETE FROM command_history
         WHERE scope_key = ?1
           AND id NOT IN (
               SELECT id FROM command_history
               WHERE scope_key = ?1
               ORDER BY last_used_at DESC, id DESC
               LIMIT ?2
           )",
    )
    .bind(scope_key)
    .bind(MAX_ROWS_PER_SCOPE)
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool() -> SqlitePool {
        crate::storage::init_in_memory().await.unwrap()
    }

    async fn count(pool: &SqlitePool, scope_key: &str) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM command_history WHERE scope_key = ?1")
            .bind(scope_key)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn recording_dedups_and_bumps_use_count() {
        let pool = pool().await;
        assert!(record(&pool, "host:a", "git status").await.unwrap());
        assert!(record(&pool, "host:a", "git status").await.unwrap());
        assert!(record(&pool, "host:a", "git push").await.unwrap());

        assert_eq!(count(&pool, "host:a").await, 2);
        let entries = query(&pool, "host:a", "git", 10).await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].command, "git status");
        assert_eq!(entries[0].use_count, 2);
        assert_eq!(entries[1].command, "git push");
        assert_eq!(entries[1].use_count, 1);
    }

    #[tokio::test]
    async fn scopes_are_isolated() {
        let pool = pool().await;
        record(&pool, "host:a", "systemctl status nginx")
            .await
            .unwrap();
        record(&pool, "local:pwsh", "Get-Process").await.unwrap();

        assert_eq!(query(&pool, "host:a", "", 10).await.unwrap().len(), 1);
        assert_eq!(
            query(&pool, "local:pwsh", "sys", 10).await.unwrap().len(),
            0
        );
        assert_eq!(
            query(&pool, "local:pwsh", "Get", 10).await.unwrap()[0].command,
            "Get-Process"
        );
    }

    #[tokio::test]
    async fn prefix_match_is_case_sensitive_and_anchored() {
        let pool = pool().await;
        record(&pool, "s", "Docker ps").await.unwrap();
        record(&pool, "s", "docker ps").await.unwrap();
        record(&pool, "s", "sudo docker ps").await.unwrap();

        let entries = query(&pool, "s", "docker", 10).await.unwrap();
        assert_eq!(
            entries.iter().map(|e| &e.command).collect::<Vec<_>>(),
            vec!["docker ps"],
            "a case-insensitive or unanchored match would corrupt the line on accept"
        );
        // An empty prefix lists the whole scope.
        assert_eq!(query(&pool, "s", "", 10).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn secret_bearing_and_ignorespace_lines_are_not_recorded() {
        let pool = pool().await;
        for line in [
            " ssh prod",                                    // leading space
            "export API_KEY=abc",                           // api_key
            "mysql -u root -pHunter2",                      // -p<value>
            "curl -H \"Authorization: token x\" https://x", // token
            "echo $PASSWORD",                               // password
            "vault read secret/db",                         // secret
            "",                                             // empty
            "   ",                                          // whitespace only
        ] {
            assert!(
                !record(&pool, "host:a", line).await.unwrap(),
                "should not record {line:?}"
            );
        }
        assert_eq!(count(&pool, "host:a").await, 0);

        // Neighbours that must stay recordable.
        for line in ["ls -p", "cargo build --release", "find . -name x"] {
            assert!(record(&pool, "host:a", line).await.unwrap(), "{line:?}");
        }
    }

    #[tokio::test]
    async fn recording_prunes_to_the_cap() {
        let pool = pool().await;
        // Seed past the cap directly (recording 2000+ rows one by one is slow),
        // then let one real insert trigger the prune.
        for index in 0..(MAX_ROWS_PER_SCOPE + 5) {
            sqlx::query(
                "INSERT INTO command_history (scope_key, command, last_used_at, use_count)
                 VALUES ('host:a', ?1, ?2, 1)",
            )
            .bind(format!("cmd{index}"))
            .bind(index)
            .execute(&pool)
            .await
            .unwrap();
        }
        assert_eq!(count(&pool, "host:a").await, MAX_ROWS_PER_SCOPE + 5);

        record(&pool, "host:a", "newest").await.unwrap();
        assert_eq!(count(&pool, "host:a").await, MAX_ROWS_PER_SCOPE);
        // The pruned rows are the oldest ones, and the fresh insert survives.
        assert_eq!(query(&pool, "host:a", "cmd0", 10).await.unwrap().len(), 0);
        assert_eq!(query(&pool, "host:a", "newest", 10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn query_limit_is_clamped_and_scope_key_validated() {
        let pool = pool().await;
        record(&pool, "host:a", "ls").await.unwrap();
        assert_eq!(query(&pool, "host:a", "", 0).await.unwrap().len(), 1);
        assert_eq!(query(&pool, "host:a", "", i64::MAX).await.unwrap().len(), 1);
        assert!(query(&pool, "  ", "", 10).await.is_err());
        assert!(record(&pool, "", "ls").await.is_err());
    }
}
