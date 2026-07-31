use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_NAME_LENGTH: usize = 128;

/// Defaults a group hands down to the hosts inside it (and, through
/// `parent_id`, to nested groups). Every field is optional: `None` means "this
/// group sets no default", which is what makes resolution keep walking up the
/// parent chain. See [`crate::storage::host_inheritance`] for the resolution
/// order.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostGroupDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_jump_host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mosh_server_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mosh_port_range: Option<String>,
}

impl HostGroupDefaults {
    /// True when the group configures nothing, which lets the resolver skip it
    /// and the UI hide the "inherited" affordances entirely.
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGroup {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
    /// Flattened so the frontend sees `username`, `transport`, … directly on
    /// the group object, matching how the same fields appear on a host.
    #[serde(flatten)]
    pub defaults: HostGroupDefaults,
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
    #[serde(flatten)]
    pub defaults: HostGroupDefaults,
}

const GROUP_COLUMNS: &str = "id, vault_id, name, parent_id, sort_order, username, identity_id, \
     proxy_jump_host_id, startup_command, working_directory, environment, tab_color, transport, \
     mosh_server_path, mosh_port_range";

fn row_to_group(row: &sqlx::sqlite::SqliteRow) -> HostGroup {
    let environment: Option<String> = row.get("environment");
    HostGroup {
        id: row.get("id"),
        vault_id: row.get("vault_id"),
        name: row.get("name"),
        parent_id: row.get("parent_id"),
        sort_order: row.get("sort_order"),
        defaults: HostGroupDefaults {
            username: row.get("username"),
            identity_id: row.get("identity_id"),
            proxy_jump_host_id: row.get("proxy_jump_host_id"),
            startup_command: row.get("startup_command"),
            working_directory: row.get("working_directory"),
            environment: environment.and_then(|value| serde_json::from_str(&value).ok()),
            tab_color: row.get("tab_color"),
            transport: row.get("transport"),
            mosh_server_path: row.get("mosh_server_path"),
            mosh_port_range: row.get("mosh_port_range"),
        },
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

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// Group defaults go through exactly the validators the equivalent host fields
/// use, so nothing can reach a connection through a group that a host would
/// have refused.
pub(crate) fn validate_defaults(defaults: &HostGroupDefaults) -> Result<()> {
    if let Some(username) = defaults.username.as_deref().map(str::trim) {
        if !username.is_empty() {
            crate::storage::hosts::validate_safe_username(username)?;
        }
    }
    if let Some(startup_command) = defaults.startup_command.as_deref() {
        crate::storage::hosts::validate_startup_command(startup_command)?;
    }
    if let Some(working_directory) = defaults.working_directory.as_deref() {
        crate::storage::hosts::validate_working_directory(working_directory)?;
    }
    if let Some(environment) = &defaults.environment {
        crate::storage::hosts::validate_environment(environment)?;
    }
    crate::storage::hosts::validate_tab_color(defaults.tab_color.as_deref())?;
    crate::storage::hosts::validate_transport_settings(
        defaults.transport.as_deref(),
        defaults.mosh_server_path.as_deref(),
        defaults.mosh_port_range.as_deref(),
    )
}

fn normalize_defaults(defaults: &mut HostGroupDefaults) {
    defaults.username = optional_trimmed(defaults.username.take());
    defaults.identity_id = optional_trimmed(defaults.identity_id.take());
    defaults.proxy_jump_host_id = optional_trimmed(defaults.proxy_jump_host_id.take());
    defaults.startup_command = optional_trimmed(defaults.startup_command.take());
    defaults.working_directory = optional_trimmed(defaults.working_directory.take());
    defaults.transport = optional_trimmed(defaults.transport.take());
    defaults.mosh_server_path = optional_trimmed(defaults.mosh_server_path.take());
    defaults.mosh_port_range = optional_trimmed(defaults.mosh_port_range.take());
    defaults.environment = defaults
        .environment
        .take()
        .filter(|environment| !environment.is_empty());
}

/// A group may only point at an identity or jump host from its own vault, for
/// the same reason a host may not: otherwise a shared group would leak a
/// reference no other member can resolve.
async fn validate_default_references(
    pool: &SqlitePool,
    vault_id: &str,
    defaults: &HostGroupDefaults,
) -> Result<()> {
    for (table, id, label) in [
        ("identities", defaults.identity_id.as_deref(), "identity"),
        (
            "hosts",
            defaults.proxy_jump_host_id.as_deref(),
            "proxy jump host",
        ),
    ] {
        let Some(id) = id else {
            continue;
        };
        let query = format!("SELECT 1 FROM {table} WHERE id = ?1 AND vault_id = ?2");
        if sqlx::query_scalar::<_, i64>(&query)
            .bind(id)
            .bind(vault_id)
            .fetch_optional(pool)
            .await?
            .is_none()
        {
            return Err(LumaError::InvalidInput(format!("unknown {label}")));
        }
    }
    crate::storage::hosts::validate_proxy_jump(
        pool,
        vault_id,
        None,
        defaults.proxy_jump_host_id.as_deref(),
    )
    .await
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
    let query = format!(
        "SELECT {GROUP_COLUMNS}
         FROM host_groups WHERE ?1 IS NULL OR vault_id = ?1
         ORDER BY sort_order, name COLLATE NOCASE"
    );
    let rows = sqlx::query(&query).bind(vault_id).fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_group).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<HostGroup>> {
    let query = format!("SELECT {GROUP_COLUMNS} FROM host_groups WHERE id = ?1");
    let row = sqlx::query(&query).bind(id).fetch_optional(pool).await?;
    Ok(row.as_ref().map(row_to_group))
}

fn environment_json(defaults: &HostGroupDefaults) -> Result<Option<String>> {
    defaults
        .environment
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| LumaError::InvalidInput(format!("invalid environment: {error}")))
}

pub async fn create(pool: &SqlitePool, mut input: HostGroupInput) -> Result<HostGroup> {
    validate_name(&input.name)?;
    crate::storage::vaults::require(pool, &input.vault_id).await?;
    input.parent_id = normalized_parent(input.parent_id);
    validate_parent(pool, &input.vault_id, None, input.parent_id.as_deref()).await?;
    normalize_defaults(&mut input.defaults);
    validate_defaults(&input.defaults)?;
    validate_default_references(pool, &input.vault_id, &input.defaults).await?;

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO host_groups (
             id, vault_id, name, parent_id, sort_order, username, identity_id, proxy_jump_host_id,
             startup_command, working_directory, environment, tab_color, transport,
             mosh_server_path, mosh_port_range
         ) VALUES (?1, ?5, ?2, ?3, ?4, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(&input.parent_id)
    .bind(input.sort_order)
    .bind(&input.vault_id)
    .bind(&input.defaults.username)
    .bind(&input.defaults.identity_id)
    .bind(&input.defaults.proxy_jump_host_id)
    .bind(&input.defaults.startup_command)
    .bind(&input.defaults.working_directory)
    .bind(environment_json(&input.defaults)?)
    .bind(&input.defaults.tab_color)
    .bind(&input.defaults.transport)
    .bind(&input.defaults.mosh_server_path)
    .bind(&input.defaults.mosh_port_range)
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
    normalize_defaults(&mut input.defaults);
    validate_defaults(&input.defaults)?;
    validate_default_references(pool, &input.vault_id, &input.defaults).await?;

    sqlx::query(
        "UPDATE host_groups
         SET name = ?2, parent_id = ?3, sort_order = ?4, username = ?5, identity_id = ?6,
             proxy_jump_host_id = ?7, startup_command = ?8, working_directory = ?9,
             environment = ?10, tab_color = ?11, transport = ?12, mosh_server_path = ?13,
             mosh_port_range = ?14, updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(&input.parent_id)
    .bind(input.sort_order)
    .bind(&input.defaults.username)
    .bind(&input.defaults.identity_id)
    .bind(&input.defaults.proxy_jump_host_id)
    .bind(&input.defaults.startup_command)
    .bind(&input.defaults.working_directory)
    .bind(environment_json(&input.defaults)?)
    .bind(&input.defaults.tab_color)
    .bind(&input.defaults.transport)
    .bind(&input.defaults.mosh_server_path)
    .bind(&input.defaults.mosh_port_range)
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
            defaults: HostGroupDefaults::default(),
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
    async fn group_defaults_round_trip_and_normalize_blanks_to_unset() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let mut input = group_input("Team", None);
        input.defaults = HostGroupDefaults {
            username: Some("  deploy  ".into()),
            startup_command: Some("tmux attach".into()),
            working_directory: Some("/srv".into()),
            environment: Some(HashMap::from([("REGION".to_string(), "eu".to_string())])),
            tab_color: Some("#123456".into()),
            transport: Some("auto".into()),
            mosh_server_path: Some("/usr/local/bin/mosh-server".into()),
            mosh_port_range: Some("60000-60010".into()),
            // Whitespace-only input is "unset", never an empty-string value.
            identity_id: Some("   ".into()),
            proxy_jump_host_id: None,
        };
        let created = create(&pool, input).await.unwrap();
        assert_eq!(created.defaults.username.as_deref(), Some("deploy"));
        assert_eq!(created.defaults.identity_id, None);
        assert_eq!(created.defaults.transport.as_deref(), Some("auto"));
        assert_eq!(
            created.defaults.environment.as_ref().unwrap()["REGION"],
            "eu"
        );

        let listed = list(&pool, None).await.unwrap();
        assert_eq!(listed[0].defaults, created.defaults);

        // Clearing every default puts the group back to inheriting nothing.
        let cleared = update(&pool, &created.id, group_input("Team", None))
            .await
            .unwrap();
        assert!(cleared.defaults.is_empty());
    }

    #[tokio::test]
    async fn group_defaults_are_validated_with_the_host_field_rules() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let cases = [
            HostGroupDefaults {
                username: Some("-Fmalicious".into()),
                ..HostGroupDefaults::default()
            },
            HostGroupDefaults {
                transport: Some("telnet".into()),
                ..HostGroupDefaults::default()
            },
            HostGroupDefaults {
                mosh_port_range: Some("61000-60000".into()),
                ..HostGroupDefaults::default()
            },
            HostGroupDefaults {
                mosh_server_path: Some("mosh-server; rm -rf /".into()),
                ..HostGroupDefaults::default()
            },
            HostGroupDefaults {
                tab_color: Some("red".into()),
                ..HostGroupDefaults::default()
            },
            HostGroupDefaults {
                identity_id: Some("does-not-exist".into()),
                ..HostGroupDefaults::default()
            },
            HostGroupDefaults {
                proxy_jump_host_id: Some("does-not-exist".into()),
                ..HostGroupDefaults::default()
            },
        ];
        for defaults in cases {
            let mut input = group_input("Invalid", None);
            input.defaults = defaults.clone();
            let error = create(&pool, input).await.unwrap_err();
            assert_eq!(error.category(), "invalid-input", "accepted {defaults:?}");
        }
    }

    #[tokio::test]
    async fn a_group_cannot_default_to_a_jump_host_in_another_vault() {
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
        let personal_host = hosts::create(
            &pool,
            HostInput {
                vault_id: vaults::default_id(),
                name: "Bastion".into(),
                hostname: "bastion.example.com".into(),
                port: 22,
                username: None,
                group_id: None,
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

        let mut leaked = group_input("Leaked", None);
        leaked.vault_id = shared.id.clone();
        leaked.defaults.proxy_jump_host_id = Some(personal_host.id);
        let error = create(&pool, leaked).await.unwrap_err();
        assert_eq!(error.category(), "invalid-input");
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
                defaults: HostGroupDefaults::default(),
            },
        )
        .await;
        assert!(leaked.is_err());

        assert_eq!(list(&pool, Some(&shared.id)).await.unwrap().len(), 0);
        assert_eq!(list(&pool, None).await.unwrap().len(), 1);
    }
}
