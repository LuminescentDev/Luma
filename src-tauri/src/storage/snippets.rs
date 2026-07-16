//! Persistent reusable command snippets.
//!
//! Variable substitution is intentionally not performed here. The frontend
//! prompts for values and inserts the substituted command through `pty_write`.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_NAME_LENGTH: usize = 128;
const MAX_COMMAND_LENGTH: usize = 8 * 1024;
const MAX_DESCRIPTION_LENGTH: usize = 4 * 1024;
const MAX_TAGS: usize = 128;
const MAX_TAG_LENGTH: usize = 128;
const MAX_VARIABLES: usize = 32;
const MAX_VARIABLE_LENGTH: usize = 64;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub variables: Vec<String>,
    pub host_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetInput {
    pub name: String,
    pub command: String,
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub variables: Vec<String>,
    pub host_id: Option<String>,
}

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub(crate) fn validate_fields(input: &SnippetInput) -> Result<()> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH || name.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "snippet name must be 1-{MAX_NAME_LENGTH} characters"
        )));
    }

    if input.command.trim().is_empty()
        || input.command.len() > MAX_COMMAND_LENGTH
        || input.command.contains('\0')
    {
        return Err(LumaError::InvalidInput(format!(
            "snippet command must be non-empty, at most {MAX_COMMAND_LENGTH} bytes, and contain no null characters"
        )));
    }

    if input
        .description
        .as_ref()
        .is_some_and(|value| value.len() > MAX_DESCRIPTION_LENGTH || value.contains('\0'))
    {
        return Err(LumaError::InvalidInput(format!(
            "snippet description must be at most {MAX_DESCRIPTION_LENGTH} bytes and contain no null characters"
        )));
    }

    if input.tags.len() > MAX_TAGS
        || input
            .tags
            .iter()
            .any(|tag| tag.trim().is_empty() || tag.len() > MAX_TAG_LENGTH || tag.contains('\0'))
    {
        return Err(LumaError::InvalidInput(format!(
            "tags must be non-empty, at most {MAX_TAG_LENGTH} characters each, and limited to {MAX_TAGS} entries"
        )));
    }

    if input.variables.len() > MAX_VARIABLES
        || input.variables.iter().any(|variable| {
            let variable = variable.trim();
            variable.is_empty()
                || variable.len() > MAX_VARIABLE_LENGTH
                || !variable.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
        })
    {
        return Err(LumaError::InvalidInput(format!(
            "variables must contain only letters, digits, '_' or '-', be 1-{MAX_VARIABLE_LENGTH} characters each, and be limited to {MAX_VARIABLES} entries"
        )));
    }

    Ok(())
}

async fn validate_host(pool: &SqlitePool, host_id: Option<&str>) -> Result<()> {
    let Some(host_id) = host_id else {
        return Ok(());
    };
    if sqlx::query_scalar::<_, i64>("SELECT 1 FROM hosts WHERE id = ?1")
        .bind(host_id)
        .fetch_optional(pool)
        .await?
        .is_none()
    {
        return Err(LumaError::InvalidInput("unknown host".into()));
    }
    Ok(())
}

fn row_to_snippet(row: &sqlx::sqlite::SqliteRow) -> Snippet {
    let tags: String = row.get("tags");
    let variables: String = row.get("variables");
    Snippet {
        id: row.get("id"),
        name: row.get("name"),
        command: row.get("command"),
        description: row.get("description"),
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        variables: serde_json::from_str(&variables).unwrap_or_default(),
        host_id: row.get("host_id"),
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Snippet>> {
    let rows = sqlx::query(
        "SELECT id, name, command, description, tags, variables, host_id
         FROM snippets ORDER BY name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_snippet).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Snippet>> {
    let row = sqlx::query(
        "SELECT id, name, command, description, tags, variables, host_id
         FROM snippets WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(row_to_snippet))
}

pub async fn create(pool: &SqlitePool, mut input: SnippetInput) -> Result<Snippet> {
    validate_fields(&input)?;
    input.description = optional_trimmed(input.description);
    input.host_id = optional_trimmed(input.host_id);
    validate_host(pool, input.host_id.as_deref()).await?;
    input.tags = input
        .tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .collect();
    input.variables = input
        .variables
        .into_iter()
        .map(|variable| variable.trim().to_string())
        .collect();

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO snippets (id, name, command, description, tags, variables, host_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.command)
    .bind(&input.description)
    .bind(
        serde_json::to_string(&input.tags)
            .map_err(|error| LumaError::InvalidInput(format!("invalid tags: {error}")))?,
    )
    .bind(
        serde_json::to_string(&input.variables)
            .map_err(|error| LumaError::InvalidInput(format!("invalid variables: {error}")))?,
    )
    .bind(&input.host_id)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("snippet creation failed".into()))
}

pub async fn update(pool: &SqlitePool, id: &str, mut input: SnippetInput) -> Result<Snippet> {
    if get(pool, id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown snippet".into()));
    }
    validate_fields(&input)?;
    input.description = optional_trimmed(input.description);
    input.host_id = optional_trimmed(input.host_id);
    validate_host(pool, input.host_id.as_deref()).await?;
    input.tags = input
        .tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .collect();
    input.variables = input
        .variables
        .into_iter()
        .map(|variable| variable.trim().to_string())
        .collect();

    sqlx::query(
        "UPDATE snippets SET name = ?2, command = ?3, description = ?4, tags = ?5,
             variables = ?6, host_id = ?7, updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(&input.command)
    .bind(&input.description)
    .bind(
        serde_json::to_string(&input.tags)
            .map_err(|error| LumaError::InvalidInput(format!("invalid tags: {error}")))?,
    )
    .bind(
        serde_json::to_string(&input.variables)
            .map_err(|error| LumaError::InvalidInput(format!("invalid variables: {error}")))?,
    )
    .bind(&input.host_id)
    .execute(pool)
    .await?;

    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown snippet".into()))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM snippets WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown snippet".into()));
    }
    sqlx::query(
        "INSERT INTO tombstones (object_type, object_id, deleted_at)
         VALUES ('snippet', ?1, unixepoch())
         ON CONFLICT(object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
    )
    .bind(id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::hosts::{self, HostInput};

    fn sample_input() -> SnippetInput {
        SnippetInput {
            name: "Deploy".into(),
            command: "deploy --environment {{environment}}".into(),
            description: Some("Deploy the current service".into()),
            tags: vec!["deployment".into()],
            variables: vec!["environment".into()],
            host_id: None,
        }
    }

    async fn create_host(pool: &SqlitePool) -> String {
        hosts::create(
            pool,
            HostInput {
                name: "Server".into(),
                hostname: "server.example.com".into(),
                port: 22,
                username: None,
                group_id: None,
                authentication_type: "agent".into(),
                key_id: None,
                identity_id: None,
                proxy_jump_host_id: None,
                startup_command: None,
                working_directory: None,
                environment: None,
                tags: vec![],
                favorite: false,
            },
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn snippet_crud_host_set_null_and_tombstone() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let host_id = create_host(&pool).await;
        let mut input = sample_input();
        input.host_id = Some(host_id.clone());
        let created = create(&pool, input).await.unwrap();
        assert_eq!(created.host_id.as_deref(), Some(host_id.as_str()));

        let mut updated_input = sample_input();
        updated_input.name = "Deploy service".into();
        updated_input.variables = vec!["environment-name".into()];
        let updated = update(&pool, &created.id, updated_input).await.unwrap();
        assert_eq!(updated.name, "Deploy service");
        assert_eq!(list(&pool).await.unwrap(), vec![updated.clone()]);

        delete(&pool, &created.id).await.unwrap();
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type = 'snippet' AND object_id = ?1",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);

        let mut host_specific = sample_input();
        host_specific.host_id = Some(host_id.clone());
        let host_specific = create(&pool, host_specific).await.unwrap();
        hosts::delete(&pool, &host_id).await.unwrap();
        assert!(get(&pool, &host_specific.id)
            .await
            .unwrap()
            .unwrap()
            .host_id
            .is_none());
    }

    #[tokio::test]
    async fn validates_snippet_fields_and_host_reference() {
        let pool = crate::storage::init_in_memory().await.unwrap();

        let mut empty_name = sample_input();
        empty_name.name = "  ".into();
        assert!(create(&pool, empty_name).await.is_err());

        let mut empty_command = sample_input();
        empty_command.command = "\n\t".into();
        assert!(create(&pool, empty_command).await.is_err());

        let mut nul_command = sample_input();
        nul_command.command = "echo\0bad".into();
        assert!(create(&pool, nul_command).await.is_err());

        for invalid_variable in ["has space", "bad.dot", "slash/name", ""] {
            let mut input = sample_input();
            input.variables = vec![invalid_variable.into()];
            assert!(
                create(&pool, input).await.is_err(),
                "accepted variable {invalid_variable:?}"
            );
        }

        let mut unknown_host = sample_input();
        unknown_host.host_id = Some("missing".into());
        assert!(create(&pool, unknown_host).await.is_err());
    }
}
