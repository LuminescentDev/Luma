use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProfile {
    pub id: String,
    pub name: String,
    pub shell_path: String,
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub name: String,
    pub shell_path: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
}

pub(crate) fn validate(input: &ProfileInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.len() > 64 {
        return Err(LumaError::InvalidInput(
            "profile name must be 1-64 characters".into(),
        ));
    }
    if !std::path::Path::new(&input.shell_path).is_file() {
        return Err(LumaError::InvalidInput(format!(
            "shell executable not found: {}",
            input.shell_path
        )));
    }
    if input.args.len() > 32 {
        return Err(LumaError::InvalidInput("too many shell arguments".into()));
    }
    if let Some(dir) = &input.working_directory {
        if !dir.is_empty() && !std::path::Path::new(dir).is_dir() {
            return Err(LumaError::InvalidInput(format!(
                "working directory does not exist: {dir}"
            )));
        }
    }
    if let Some(env) = &input.environment {
        if env.len() > 64 {
            return Err(LumaError::InvalidInput(
                "too many environment variables".into(),
            ));
        }
        for key in env.keys() {
            if key.is_empty() || key.contains('=') || key.len() > 128 {
                return Err(LumaError::InvalidInput(format!(
                    "invalid environment variable name: {key:?}"
                )));
            }
        }
    }
    Ok(())
}

fn row_to_profile(row: &sqlx::sqlite::SqliteRow) -> TerminalProfile {
    let args: String = row.get("args");
    let environment: Option<String> = row.get("environment");
    TerminalProfile {
        id: row.get("id"),
        name: row.get("name"),
        shell_path: row.get("shell_path"),
        args: serde_json::from_str(&args).unwrap_or_default(),
        working_directory: row.get("working_directory"),
        environment: environment.and_then(|e| serde_json::from_str(&e).ok()),
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<TerminalProfile>> {
    let rows = sqlx::query(
        "SELECT id, name, shell_path, args, working_directory, environment
         FROM terminal_profiles ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_profile).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<TerminalProfile>> {
    let row = sqlx::query(
        "SELECT id, name, shell_path, args, working_directory, environment
         FROM terminal_profiles WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(row_to_profile))
}

pub async fn create(pool: &SqlitePool, input: ProfileInput) -> Result<TerminalProfile> {
    validate(&input)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO terminal_profiles (id, name, shell_path, args, working_directory, environment)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.shell_path)
    .bind(serde_json::to_string(&input.args).unwrap_or_else(|_| "[]".into()))
    .bind(&input.working_directory)
    .bind(
        input
            .environment
            .as_ref()
            .and_then(|e| serde_json::to_string(e).ok()),
    )
    .execute(pool)
    .await?;
    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("profile creation failed".into()))
}

pub async fn update(pool: &SqlitePool, id: &str, input: ProfileInput) -> Result<TerminalProfile> {
    validate(&input)?;
    let result = sqlx::query(
        "UPDATE terminal_profiles
         SET name = ?2, shell_path = ?3, args = ?4, working_directory = ?5,
             environment = ?6, updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(&input.shell_path)
    .bind(serde_json::to_string(&input.args).unwrap_or_else(|_| "[]".into()))
    .bind(&input.working_directory)
    .bind(
        input
            .environment
            .as_ref()
            .and_then(|e| serde_json::to_string(e).ok()),
    )
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown profile".into()));
    }
    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown profile".into()))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM terminal_profiles WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() > 0 {
        sqlx::query(
            "INSERT INTO tombstones (object_type, object_id, deleted_at)
             VALUES ('terminal_profile', ?1, unixepoch())
             ON CONFLICT(object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
        )
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_input() -> ProfileInput {
        // Use the running test binary's directory as a guaranteed-existing dir
        // and any real file as the "shell".
        let exe = std::env::current_exe().unwrap();
        ProfileInput {
            name: "Test profile".into(),
            shell_path: exe.to_string_lossy().into_owned(),
            args: vec!["-x".into()],
            working_directory: Some(exe.parent().unwrap().to_string_lossy().into_owned()),
            environment: Some(HashMap::from([("FOO".into(), "bar".into())])),
        }
    }

    #[tokio::test]
    async fn profile_crud_roundtrip() {
        let pool = crate::storage::init_in_memory().await.unwrap();

        let created = create(&pool, sample_input()).await.unwrap();
        assert_eq!(created.name, "Test profile");
        assert_eq!(created.args, vec!["-x"]);

        let listed = list(&pool).await.unwrap();
        assert_eq!(listed.len(), 1);

        let mut updated_input = sample_input();
        updated_input.name = "Renamed".into();
        let updated = update(&pool, &created.id, updated_input).await.unwrap();
        assert_eq!(updated.name, "Renamed");

        delete(&pool, &created.id).await.unwrap();
        assert!(list(&pool).await.unwrap().is_empty());
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type='terminal_profile' AND object_id=?1",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);
    }

    #[tokio::test]
    async fn rejects_missing_shell_path() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let mut input = sample_input();
        input.shell_path = "Z:\\does\\not\\exist\\shell.exe".into();
        assert!(create(&pool, input).await.is_err());
    }
}
