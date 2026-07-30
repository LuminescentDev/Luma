use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_NAME_LENGTH: usize = 128;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroupInput {
    #[serde(default = "crate::storage::vaults::default_id")]
    pub vault_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

fn row_to_group(row: &sqlx::sqlite::SqliteRow) -> HostGroup {
    HostGroup {
        id: row.get("id"),
        vault_id: row.get("vault_id"),
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
    vault_id: &str,
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
        let row = sqlx::query("SELECT parent_id FROM host_groups WHERE id = ?1 AND vault_id = ?2")
            .bind(&id)
            .bind(vault_id)
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

pub async fn list(pool: &SqlitePool, vault_id: Option<&str>) -> Result<Vec<HostGroup>> {
    let rows = sqlx::query(
        "SELECT id, vault_id, name, parent_id, sort_order
         FROM host_groups WHERE ?1 IS NULL OR vault_id = ?1
         ORDER BY sort_order, name COLLATE NOCASE",
    )
    .bind(vault_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_group).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<HostGroup>> {
    let row = sqlx::query(
        "SELECT id, vault_id, name, parent_id, sort_order FROM host_groups WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(row_to_group))
}

pub async fn create(pool: &SqlitePool, mut input: HostGroupInput) -> Result<HostGroup> {
    validate_name(&input.name)?;
    crate::storage::vaults::require(pool, &input.vault_id).await?;
    input.parent_id = normalized_parent(input.parent_id);
    validate_parent(pool, &input.vault_id, None, input.parent_id.as_deref()).await?;

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO host_groups (id, vault_id, name, parent_id, sort_order)
         VALUES (?1, ?5, ?2, ?3, ?4)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.parent_id)
    .bind(input.sort_order)
    .bind(&input.vault_id)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("host group creation failed".into()))
}

pub async fn update(pool: &SqlitePool, id: &str, mut input: HostGroupInput) -> Result<HostGroup> {
    let current = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host group".into()))?;
    input.vault_id = current.vault_id;
    validate_name(&input.name)?;
    input.parent_id = normalized_parent(input.parent_id);
    validate_parent(pool, &input.vault_id, Some(id), input.parent_id.as_deref()).await?;

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
    let group = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host group".into()))?;
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM host_groups WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown host group".into()));
    }
    sqlx::query(
        "INSERT INTO tombstones (vault_id, object_type, object_id, deleted_at)
         VALUES (?2, 'host_group', ?1, unixepoch())
         ON CONFLICT(vault_id, object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
    )
    .bind(id)
    .bind(&group.vault_id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::hosts::{self, HostInput};
    use crate::storage::vaults::{self, VaultInput};

    fn group_input(name: &str, parent_id: Option<String>) -> HostGroupInput {
        HostGroupInput {
            vault_id: vaults::default_id(),
            name: name.into(),
            parent_id,
            sort_order: 0,
        }
    }

    #[tokio::test]
    async fn group_crud_reparent_cycle_and_set_null() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let parent = create(&pool, group_input("Parent", None)).await.unwrap();
        let child = create(&pool, group_input("Child", Some(parent.id.clone())))
            .await
            .unwrap();

        let cycle = update(
            &pool,
            &parent.id,
            group_input("Parent", Some(child.id.clone())),
        )
        .await;
        assert!(cycle.is_err());

        let host = hosts::create(
            &pool,
            HostInput {
                vault_id: vaults::default_id(),
                name: "Grouped".into(),
                hostname: "grouped.example.com".into(),
                port: 22,
                username: None,
                group_id: Some(child.id.clone()),
                authentication_type: "interactive".into(),
                key_id: None,
                identity_id: None,
                proxy_jump_host_id: None,
                startup_command: None,
                working_directory: None,
                environment: None,
                tags: vec![],
                favorite: false,
                tab_color: None,
                transport: "ssh".into(),
                mosh_server_path: None,
                mosh_port_range: None,
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

    #[tokio::test]
    async fn a_group_cannot_be_parented_into_another_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let shared = vaults::create(
            &pool,
            VaultInput {
                name: "Infra".into(),
                share_secrets: false,
                sort_order: 0,
            },
        )
        .await
        .unwrap();
        let personal_parent = create(&pool, group_input("Personal", None)).await.unwrap();

        let leaked = create(
            &pool,
            HostGroupInput {
                vault_id: shared.id.clone(),
                name: "Leaked".into(),
                parent_id: Some(personal_parent.id.clone()),
                sort_order: 0,
            },
        )
        .await;
        assert!(leaked.is_err());

        assert_eq!(list(&pool, Some(&shared.id)).await.unwrap().len(), 0);
        assert_eq!(list(&pool, None).await.unwrap().len(), 1);
    }
}
