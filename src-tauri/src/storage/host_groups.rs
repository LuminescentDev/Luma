use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_NAME_LENGTH: usize = 128;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroupInput {
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

fn row_to_group(row: &sqlx::sqlite::SqliteRow) -> HostGroup {
    HostGroup {
        id: row.get("id"),
        name: row.get("name"),
        parent_id: row.get("parent_id"),
        sort_order: row.get("sort_order"),
    }
}

pub(crate) fn validate_name(name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH || name.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "group name must be 1-{MAX_NAME_LENGTH} characters"
        )));
    }
    Ok(())
}

async fn validate_parent(
    pool: &SqlitePool,
    group_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };

    let mut seen = HashSet::new();
    if let Some(group_id) = group_id {
        seen.insert(group_id.to_string());
    }

    let mut next = Some(parent_id.to_string());
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return Err(LumaError::InvalidInput(
                "group parent relationship would create a cycle".into(),
            ));
        }
        let row = sqlx::query("SELECT parent_id FROM host_groups WHERE id = ?1")
            .bind(&id)
            .fetch_optional(pool)
            .await?;
        let Some(row) = row else {
            return Err(LumaError::InvalidInput("unknown parent group".into()));
        };
        next = row.get("parent_id");
    }
    Ok(())
}

fn normalized_parent(parent_id: Option<String>) -> Option<String> {
    parent_id.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<HostGroup>> {
    let rows = sqlx::query(
        "SELECT id, name, parent_id, sort_order
         FROM host_groups ORDER BY sort_order, name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_group).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<HostGroup>> {
    let row = sqlx::query("SELECT id, name, parent_id, sort_order FROM host_groups WHERE id = ?1")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.as_ref().map(row_to_group))
}

pub async fn create(pool: &SqlitePool, mut input: HostGroupInput) -> Result<HostGroup> {
    validate_name(&input.name)?;
    input.parent_id = normalized_parent(input.parent_id);
    validate_parent(pool, None, input.parent_id.as_deref()).await?;

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO host_groups (id, name, parent_id, sort_order) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.parent_id)
    .bind(input.sort_order)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("host group creation failed".into()))
}

pub async fn update(pool: &SqlitePool, id: &str, mut input: HostGroupInput) -> Result<HostGroup> {
    if get(pool, id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown host group".into()));
    }
    validate_name(&input.name)?;
    input.parent_id = normalized_parent(input.parent_id);
    validate_parent(pool, Some(id), input.parent_id.as_deref()).await?;

    sqlx::query(
        "UPDATE host_groups
         SET name = ?2, parent_id = ?3, sort_order = ?4, updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(&input.parent_id)
    .bind(input.sort_order)
    .execute(pool)
    .await?;

    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host group".into()))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM host_groups WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown host group".into()));
    }
    sqlx::query(
        "INSERT INTO tombstones (object_type, object_id, deleted_at)
         VALUES ('host_group', ?1, unixepoch())
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

    #[tokio::test]
    async fn group_crud_reparent_cycle_and_set_null() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let parent = create(
            &pool,
            HostGroupInput {
                name: "Parent".into(),
                parent_id: None,
                sort_order: 0,
            },
        )
        .await
        .unwrap();
        let child = create(
            &pool,
            HostGroupInput {
                name: "Child".into(),
                parent_id: Some(parent.id.clone()),
                sort_order: 1,
            },
        )
        .await
        .unwrap();

        let cycle = update(
            &pool,
            &parent.id,
            HostGroupInput {
                name: "Parent".into(),
                parent_id: Some(child.id.clone()),
                sort_order: 0,
            },
        )
        .await;
        assert!(cycle.is_err());

        let host = hosts::create(
            &pool,
            HostInput {
                name: "Grouped".into(),
                hostname: "grouped.example.com".into(),
                port: 22,
                username: None,
                group_id: Some(child.id.clone()),
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
        .unwrap();

        delete(&pool, &child.id).await.unwrap();
        assert!(hosts::get(&pool, &host.id)
            .await
            .unwrap()
            .unwrap()
            .group_id
            .is_none());
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type = 'host_group' AND object_id = ?1",
        )
        .bind(&child.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);
    }
}
