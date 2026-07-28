use std::collections::HashMap;

use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_KEY_LENGTH: usize = 128;
const MAX_VALUE_BYTES: usize = 64 * 1024;
/// Superseded by each vault's `share_secrets` column, which migration 0014 seeds from
/// this value. The key stays readable and validated for one release so a downgrade or
/// an old peer's bundle still round-trips it.
pub(crate) const SYNC_INCLUDE_PRIVATE_KEYS_KEY: &str = "sync.includePrivateKeys";

pub(crate) fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > MAX_KEY_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "setting key must be 1-{MAX_KEY_LENGTH} characters"
        )));
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(LumaError::InvalidInput(
            "setting key may only contain letters, digits, '.', '_' and '-'".into(),
        ));
    }
    Ok(())
}

pub async fn all(pool: &SqlitePool) -> Result<HashMap<String, Value>> {
    let rows = sqlx::query("SELECT key, value FROM settings")
        .fetch_all(pool)
        .await?;

    let mut settings = HashMap::with_capacity(rows.len());
    for row in rows {
        let key: String = row.get("key");
        let raw: String = row.get("value");
        let value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        settings.insert(key, value);
    }
    settings
        .entry(SYNC_INCLUDE_PRIVATE_KEYS_KEY.to_string())
        .or_insert(Value::Bool(false));
    Ok(settings)
}

pub async fn set(pool: &SqlitePool, key: &str, value: &Value) -> Result<()> {
    validate_key(key)?;
    if key == SYNC_INCLUDE_PRIVATE_KEYS_KEY && !value.is_boolean() {
        return Err(LumaError::InvalidInput(format!(
            "{SYNC_INCLUDE_PRIVATE_KEYS_KEY} must be a boolean"
        )));
    }
    let serialized = serde_json::to_string(value)
        .map_err(|e| LumaError::InvalidInput(format!("value is not serializable: {e}")))?;
    if serialized.len() > MAX_VALUE_BYTES {
        return Err(LumaError::InvalidInput("setting value too large".into()));
    }

    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()",
    )
    .bind(key)
    .bind(serialized)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, key: &str) -> Result<()> {
    validate_key(key)?;
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM settings WHERE key = ?1")
        .bind(key)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() > 0 {
        // Settings sync only with the personal vault.
        sqlx::query(
            "INSERT INTO tombstones (vault_id, object_type, object_id, deleted_at)
             VALUES ('personal', 'setting', ?1, unixepoch())
             ON CONFLICT(vault_id, object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
        )
        .bind(key)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn settings_roundtrip() {
        let pool = crate::storage::init_in_memory().await.unwrap();

        set(&pool, "appearance.theme", &json!("dark"))
            .await
            .unwrap();
        set(&pool, "terminal.scrollback", &json!(5000))
            .await
            .unwrap();
        // Overwrite an existing key.
        set(&pool, "appearance.theme", &json!("light"))
            .await
            .unwrap();

        let settings = all(&pool).await.unwrap();
        assert_eq!(settings["appearance.theme"], json!("light"));
        assert_eq!(settings["terminal.scrollback"], json!(5000));
        assert_eq!(settings[SYNC_INCLUDE_PRIVATE_KEYS_KEY], json!(false));

        delete(&pool, "terminal.scrollback").await.unwrap();
        let settings = all(&pool).await.unwrap();
        assert!(!settings.contains_key("terminal.scrollback"));
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type='setting' AND object_id='terminal.scrollback'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);
    }

    #[tokio::test]
    async fn rejects_invalid_keys() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        assert!(set(&pool, "", &json!(1)).await.is_err());
        assert!(set(&pool, "bad key with spaces", &json!(1)).await.is_err());
        assert!(set(&pool, "drop table; --", &json!(1)).await.is_err());
        assert!(set(&pool, &"x".repeat(200), &json!(1)).await.is_err());
    }

    #[tokio::test]
    async fn private_key_sync_preference_is_boolean_and_defaults_off() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        assert_eq!(
            all(&pool).await.unwrap()[SYNC_INCLUDE_PRIVATE_KEYS_KEY],
            json!(false)
        );
        assert!(set(&pool, SYNC_INCLUDE_PRIVATE_KEYS_KEY, &json!("yes"))
            .await
            .is_err());
        set(&pool, SYNC_INCLUDE_PRIVATE_KEYS_KEY, &json!(true))
            .await
            .unwrap();
        assert_eq!(
            all(&pool).await.unwrap()[SYNC_INCLUDE_PRIVATE_KEYS_KEY],
            json!(true)
        );
    }
}
