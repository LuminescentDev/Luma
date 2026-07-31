//! Local draft history for the voice composer.
//!
//! Drafts are user data — very often the most sensitive text in the app, since
//! dictation captures whatever the user said. Three rules follow from that:
//!
//!  * Draft contents are NEVER written to the log. Errors and traces carry row
//!    counts and ids, never the text.
//!  * A row is written only on an explicit send, not while typing or dictating.
//!  * The table is device-local: no vault, no tombstones, outside the sync
//!    surface, so a draft cannot replicate to another device.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

/// Newest drafts kept; older rows are pruned on every insert so history cannot
/// grow without bound.
pub const MAX_ENTRIES: i64 = 200;
/// A draft longer than this is a paste of a file, not a command to remember.
const MAX_DRAFT_LENGTH: usize = 8192;
/// Upper bound on rows one `list` call may return.
const MAX_LIST_LIMIT: i64 = MAX_ENTRIES;

/// How a draft was produced. Stored so the history panel can label entries
/// without inspecting their contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceSource {
    /// Typed or pasted only.
    Typed,
    /// Produced entirely by speech recognition.
    Dictated,
    /// Dictated then edited, or typed then dictated into.
    Mixed,
}

impl VoiceSource {
    fn as_str(self) -> &'static str {
        match self {
            VoiceSource::Typed => "typed",
            VoiceSource::Dictated => "dictated",
            VoiceSource::Mixed => "mixed",
        }
    }

    /// Unknown values decay to `Typed` rather than failing a whole listing: a
    /// mislabelled row is harmless, a panel that will not render is not.
    fn from_str(value: &str) -> Self {
        match value {
            "dictated" => VoiceSource::Dictated,
            "mixed" => VoiceSource::Mixed,
            _ => VoiceSource::Typed,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHistoryEntry {
    pub id: i64,
    pub draft: String,
    pub source: VoiceSource,
    pub created_at: i64,
}

/// Record one sent draft. Returns the stored entry, or `None` when the draft is
/// empty or oversized — the caller records opportunistically on send, so a
/// filtered draft is a silent no-op rather than an error that would block a send
/// that already happened.
pub async fn add(
    pool: &SqlitePool,
    draft: &str,
    source: VoiceSource,
) -> Result<Option<VoiceHistoryEntry>> {
    let trimmed = draft.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_DRAFT_LENGTH || trimmed.contains('\0') {
        return Ok(None);
    }
    let row = sqlx::query(
        "INSERT INTO voice_history (draft, source, created_at)
         VALUES (?1, ?2, unixepoch())
         RETURNING id, draft, source, created_at",
    )
    .bind(trimmed)
    .bind(source.as_str())
    .fetch_one(pool)
    .await?;
    let entry = VoiceHistoryEntry {
        id: row.get("id"),
        draft: row.get("draft"),
        source: VoiceSource::from_str(row.get::<String, _>("source").as_str()),
        created_at: row.get("created_at"),
    };
    prune(pool).await?;
    Ok(Some(entry))
}

/// Most recent drafts first.
pub async fn list(pool: &SqlitePool, limit: i64) -> Result<Vec<VoiceHistoryEntry>> {
    let limit = limit.clamp(1, MAX_LIST_LIMIT);
    let rows = sqlx::query(
        "SELECT id, draft, source, created_at FROM voice_history
         ORDER BY created_at DESC, id DESC
         LIMIT ?1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .iter()
        .map(|row: &sqlx::sqlite::SqliteRow| VoiceHistoryEntry {
            id: row.get("id"),
            draft: row.get("draft"),
            source: VoiceSource::from_str(row.get::<String, _>("source").as_str()),
            created_at: row.get("created_at"),
        })
        .collect())
}

/// Remove one entry. Returns whether a row was actually deleted.
pub async fn delete(pool: &SqlitePool, id: i64) -> Result<bool> {
    if id <= 0 {
        return Err(LumaError::InvalidInput("id is invalid".into()));
    }
    let result = sqlx::query("DELETE FROM voice_history WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Remove every entry. Returns how many rows were removed.
pub async fn clear(pool: &SqlitePool) -> Result<u64> {
    let result = sqlx::query("DELETE FROM voice_history")
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Drop everything past the newest `MAX_ENTRIES` rows. Returns how many rows
/// were removed.
pub async fn prune(pool: &SqlitePool) -> Result<u64> {
    let result = sqlx::query(
        "DELETE FROM voice_history
         WHERE id NOT IN (
             SELECT id FROM voice_history
             ORDER BY created_at DESC, id DESC
             LIMIT ?1
         )",
    )
    .bind(MAX_ENTRIES)
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

    async fn count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM voice_history")
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn adds_and_lists_newest_first() {
        let pool = pool().await;
        let first = add(&pool, "git status", VoiceSource::Dictated)
            .await
            .unwrap()
            .unwrap();
        let second = add(&pool, "cargo test", VoiceSource::Mixed)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(first.draft, "git status");
        assert_eq!(first.source, VoiceSource::Dictated);
        assert!(first.created_at > 0);

        let entries = list(&pool, 10).await.unwrap();
        assert_eq!(entries.len(), 2);
        // Same-second inserts tie on created_at, so id breaks the tie.
        assert_eq!(entries[0].id, second.id);
        assert_eq!(entries[0].draft, "cargo test");
        assert_eq!(entries[0].source, VoiceSource::Mixed);
        assert_eq!(entries[1].id, first.id);
    }

    #[tokio::test]
    async fn drafts_are_trimmed_and_duplicates_are_kept_as_separate_entries() {
        let pool = pool().await;
        add(&pool, "  ls -la  ", VoiceSource::Typed).await.unwrap();
        add(&pool, "ls -la", VoiceSource::Typed).await.unwrap();

        let entries = list(&pool, 10).await.unwrap();
        // History is a timeline, not a set: sending the same draft twice is two
        // events worth showing.
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.draft == "ls -la"));
    }

    #[tokio::test]
    async fn empty_and_oversized_drafts_are_dropped_silently() {
        let pool = pool().await;
        for draft in ["", "   ", "\n\t ", "with\0nul"] {
            assert!(
                add(&pool, draft, VoiceSource::Typed)
                    .await
                    .unwrap()
                    .is_none(),
                "should not store {draft:?}"
            );
        }
        let oversized = "a".repeat(MAX_DRAFT_LENGTH + 1);
        assert!(add(&pool, &oversized, VoiceSource::Typed)
            .await
            .unwrap()
            .is_none());

        // The largest allowed draft still stores.
        let at_limit = "b".repeat(MAX_DRAFT_LENGTH);
        assert!(add(&pool, &at_limit, VoiceSource::Typed)
            .await
            .unwrap()
            .is_some());
        assert_eq!(count(&pool).await, 1);
    }

    #[tokio::test]
    async fn list_limit_is_clamped() {
        let pool = pool().await;
        for index in 0..5 {
            add(&pool, &format!("cmd{index}"), VoiceSource::Typed)
                .await
                .unwrap();
        }
        assert_eq!(list(&pool, 0).await.unwrap().len(), 1);
        assert_eq!(list(&pool, -10).await.unwrap().len(), 1);
        assert_eq!(list(&pool, 3).await.unwrap().len(), 3);
        assert_eq!(list(&pool, i64::MAX).await.unwrap().len(), 5);
    }

    #[tokio::test]
    async fn delete_removes_one_entry_and_reports_misses() {
        let pool = pool().await;
        let entry = add(&pool, "whoami", VoiceSource::Typed)
            .await
            .unwrap()
            .unwrap();
        add(&pool, "uptime", VoiceSource::Typed).await.unwrap();

        assert!(delete(&pool, entry.id).await.unwrap());
        assert_eq!(count(&pool).await, 1);
        // Deleting the same row twice is a miss, not an error.
        assert!(!delete(&pool, entry.id).await.unwrap());
        assert!(delete(&pool, 0).await.is_err());
        assert!(delete(&pool, -1).await.is_err());
    }

    #[tokio::test]
    async fn clear_empties_the_table() {
        let pool = pool().await;
        for index in 0..3 {
            add(&pool, &format!("cmd{index}"), VoiceSource::Typed)
                .await
                .unwrap();
        }
        assert_eq!(clear(&pool).await.unwrap(), 3);
        assert_eq!(count(&pool).await, 0);
        // Clearing an empty table is a no-op, not an error.
        assert_eq!(clear(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn adding_prunes_to_the_cap_keeping_the_newest() {
        let pool = pool().await;
        // Seed past the cap directly with increasing timestamps, then let one
        // real insert trigger the prune.
        for index in 0..(MAX_ENTRIES + 5) {
            sqlx::query(
                "INSERT INTO voice_history (draft, source, created_at) VALUES (?1, 'typed', ?2)",
            )
            .bind(format!("cmd{index}"))
            .bind(index)
            .execute(&pool)
            .await
            .unwrap();
        }
        assert_eq!(count(&pool).await, MAX_ENTRIES + 5);

        add(&pool, "newest", VoiceSource::Dictated).await.unwrap();
        assert_eq!(count(&pool).await, MAX_ENTRIES);

        let entries = list(&pool, MAX_ENTRIES).await.unwrap();
        assert_eq!(entries[0].draft, "newest");
        // The oldest seeded rows are the ones that went.
        assert!(!entries.iter().any(|entry| entry.draft == "cmd0"));
        assert!(entries.iter().any(|entry| entry.draft == "cmd200"));
    }

    #[tokio::test]
    async fn unknown_source_values_decay_to_typed() {
        let pool = pool().await;
        sqlx::query("INSERT INTO voice_history (draft, source) VALUES ('ls', 'telepathy')")
            .execute(&pool)
            .await
            .unwrap();
        let entries = list(&pool, 10).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, VoiceSource::Typed);
    }
}
