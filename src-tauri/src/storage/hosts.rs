use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

const MAX_PROXY_JUMP_DEPTH: usize = 8;
const MAX_NAME_LENGTH: usize = 128;
const MAX_HOSTNAME_LENGTH: usize = 253;
const MAX_USERNAME_LENGTH: usize = 128;
const MAX_STARTUP_COMMAND_LENGTH: usize = 16 * 1024;
const MAX_PATH_LENGTH: usize = 4096;
const MAX_ENVIRONMENT_ENTRIES: usize = 128;
const MAX_TAGS: usize = 128;
const MAX_OS_PRETTY_NAME_LENGTH: usize = 256;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: Option<String>,
    pub group_id: Option<String>,
    pub authentication_type: String,
    pub key_id: Option<String>,
    pub identity_id: Option<String>,
    pub proxy_jump_host_id: Option<String>,
    pub startup_command: Option<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub os_id: Option<String>,
    pub os_pretty_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub name: String,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: i64,
    pub username: Option<String>,
    pub group_id: Option<String>,
    #[serde(default = "default_authentication_type")]
    pub authentication_type: String,
    pub key_id: Option<String>,
    pub identity_id: Option<String>,
    pub proxy_jump_host_id: Option<String>,
    pub startup_command: Option<String>,
    pub working_directory: Option<String>,
    pub environment: Option<HashMap<String, String>>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub favorite: bool,
}

fn default_port() -> i64 {
    22
}

fn default_authentication_type() -> String {
    "agent".into()
}

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn clear_host_credentials_when_using_identity(input: &mut HostInput) {
    if optional_trimmed(input.identity_id.clone()).is_some() {
        input.username = None;
        input.authentication_type = default_authentication_type();
        input.key_id = None;
    }
}

pub(crate) fn validate_safe_hostname(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_HOSTNAME_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "hostname must be 1-{MAX_HOSTNAME_LENGTH} characters"
        )));
    }
    if value.starts_with('-') {
        return Err(LumaError::InvalidInput(
            "hostname must not start with '-'".into(),
        ));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character, '.' | '-' | '_' | ':' | '[' | ']' | '%')
    }) {
        return Err(LumaError::InvalidInput(
            "hostname contains whitespace or unsupported characters".into(),
        ));
    }
    Ok(())
}

fn validate_safe_username(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_USERNAME_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "username must be 1-{MAX_USERNAME_LENGTH} characters"
        )));
    }
    if value.starts_with('-') {
        return Err(LumaError::InvalidInput(
            "username must not start with '-'".into(),
        ));
    }
    if !value
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        return Err(LumaError::InvalidInput(
            "username contains whitespace or unsupported characters".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_fields(input: &HostInput) -> Result<()> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "host name must be 1-{MAX_NAME_LENGTH} characters"
        )));
    }

    validate_safe_hostname(input.hostname.trim())?;
    if !(1..=65_535).contains(&input.port) {
        return Err(LumaError::InvalidInput(
            "port must be between 1 and 65535".into(),
        ));
    }

    if let Some(username) = input.username.as_deref().map(str::trim) {
        if !username.is_empty() {
            validate_safe_username(username)?;
        }
    }

    if !matches!(
        input.authentication_type.as_str(),
        "agent" | "key" | "password" | "interactive"
    ) {
        return Err(LumaError::InvalidInput(
            "authenticationType must be 'agent', 'key', 'password', or 'interactive'".into(),
        ));
    }
    if input.authentication_type == "key" && optional_trimmed(input.key_id.clone()).is_none() {
        return Err(LumaError::InvalidInput(
            "key authentication requires keyId".into(),
        ));
    }

    if input
        .startup_command
        .as_ref()
        .is_some_and(|value| value.len() > MAX_STARTUP_COMMAND_LENGTH || value.contains('\0'))
    {
        return Err(LumaError::InvalidInput(
            "startup command is too large or contains a null character".into(),
        ));
    }
    if input
        .working_directory
        .as_ref()
        .is_some_and(|value| value.len() > MAX_PATH_LENGTH || value.contains('\0'))
    {
        return Err(LumaError::InvalidInput(
            "working directory is too large or contains a null character".into(),
        ));
    }

    if let Some(environment) = &input.environment {
        if environment.len() > MAX_ENVIRONMENT_ENTRIES {
            return Err(LumaError::InvalidInput(
                "too many environment variables".into(),
            ));
        }
        for (key, value) in environment {
            if key.is_empty()
                || key.len() > 128
                || key.contains('=')
                || key.contains('\0')
                || value.contains('\0')
                || value.len() > 16 * 1024
            {
                return Err(LumaError::InvalidInput(format!(
                    "invalid environment variable: {key:?}"
                )));
            }
        }
    }

    if input.tags.len() > MAX_TAGS
        || input
            .tags
            .iter()
            .any(|tag| tag.trim().is_empty() || tag.len() > 128 || tag.contains('\0'))
    {
        return Err(LumaError::InvalidInput(
            "tags must be non-empty, at most 128 characters each, and limited to 128 entries"
                .into(),
        ));
    }

    Ok(())
}

fn row_to_host(row: &sqlx::sqlite::SqliteRow) -> Host {
    let environment: Option<String> = row.get("environment");
    let tags: String = row.get("tags");
    let port: i64 = row.get("port");
    Host {
        id: row.get("id"),
        name: row.get("name"),
        hostname: row.get("hostname"),
        port: u16::try_from(port).unwrap_or(22),
        username: row.get("username"),
        group_id: row.get("group_id"),
        authentication_type: row.get("auth_type"),
        key_id: row.get("key_id"),
        identity_id: row.get("identity_id"),
        proxy_jump_host_id: row.get("proxy_jump_host_id"),
        startup_command: row.get("startup_command"),
        working_directory: row.get("working_directory"),
        environment: environment.and_then(|value| serde_json::from_str(&value).ok()),
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        favorite: row.get::<i64, _>("favorite") != 0,
        os_id: row.get("os_id"),
        os_pretty_name: row.get("os_pretty_name"),
    }
}

const HOST_COLUMNS: &str =
    "id, name, hostname, port, username, group_id, auth_type, key_id, identity_id, proxy_jump_host_id, \
     startup_command, working_directory, environment, tags, favorite, os_id, os_pretty_name";

pub async fn list(pool: &SqlitePool) -> Result<Vec<Host>> {
    let query =
        format!("SELECT {HOST_COLUMNS} FROM hosts ORDER BY favorite DESC, name COLLATE NOCASE");
    let rows = sqlx::query(&query).fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_host).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Host>> {
    let query = format!("SELECT {HOST_COLUMNS} FROM hosts WHERE id = ?1");
    let row = sqlx::query(&query).bind(id).fetch_optional(pool).await?;
    Ok(row.as_ref().map(row_to_host))
}

async fn validate_reference(pool: &SqlitePool, table: &str, id: &str, label: &str) -> Result<()> {
    let query = format!("SELECT 1 FROM {table} WHERE id = ?1");
    if sqlx::query_scalar::<_, i64>(&query)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .is_none()
    {
        return Err(LumaError::InvalidInput(format!("unknown {label}")));
    }
    Ok(())
}

pub(crate) async fn validate_proxy_jump(
    pool: &SqlitePool,
    current_host_id: Option<&str>,
    proxy_jump_host_id: Option<&str>,
) -> Result<()> {
    let Some(proxy_id) = proxy_jump_host_id else {
        return Ok(());
    };

    let mut seen = HashSet::new();
    if let Some(current_id) = current_host_id {
        seen.insert(current_id.to_string());
    }

    let mut next = Some(proxy_id.to_string());
    let mut depth = 0;
    while let Some(id) = next {
        if !seen.insert(id.clone()) {
            return Err(LumaError::InvalidInput(
                "proxy jump relationship would create a cycle".into(),
            ));
        }
        depth += 1;
        if depth > MAX_PROXY_JUMP_DEPTH {
            return Err(LumaError::InvalidInput(format!(
                "proxy jump chain may contain at most {MAX_PROXY_JUMP_DEPTH} hosts"
            )));
        }
        let row = sqlx::query("SELECT proxy_jump_host_id FROM hosts WHERE id = ?1")
            .bind(&id)
            .fetch_optional(pool)
            .await?;
        let Some(row) = row else {
            return Err(LumaError::InvalidInput("unknown proxy jump host".into()));
        };
        next = row.get("proxy_jump_host_id");
    }
    Ok(())
}

async fn validate_references(
    pool: &SqlitePool,
    current_host_id: Option<&str>,
    input: &HostInput,
) -> Result<()> {
    if let Some(group_id) = optional_trimmed(input.group_id.clone()) {
        validate_reference(pool, "host_groups", &group_id, "host group").await?;
    }
    if let Some(key_id) = optional_trimmed(input.key_id.clone()) {
        validate_reference(pool, "key_references", &key_id, "key reference").await?;
    }
    if let Some(identity_id) = optional_trimmed(input.identity_id.clone()) {
        validate_reference(pool, "identities", &identity_id, "identity").await?;
    }
    let proxy_id = optional_trimmed(input.proxy_jump_host_id.clone());
    validate_proxy_jump(pool, current_host_id, proxy_id.as_deref()).await
}

pub async fn create(pool: &SqlitePool, mut input: HostInput) -> Result<Host> {
    clear_host_credentials_when_using_identity(&mut input);
    validate_fields(&input)?;
    validate_references(pool, None, &input).await?;

    input.username = optional_trimmed(input.username);
    input.group_id = optional_trimmed(input.group_id);
    input.key_id = optional_trimmed(input.key_id);
    input.identity_id = optional_trimmed(input.identity_id);
    input.proxy_jump_host_id = optional_trimmed(input.proxy_jump_host_id);
    input.startup_command = optional_trimmed(input.startup_command);
    input.working_directory = optional_trimmed(input.working_directory);
    input.tags = input
        .tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .collect();

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO hosts (
             id, name, hostname, port, username, group_id, auth_type, key_id, identity_id,
             proxy_jump_host_id, startup_command, working_directory, environment, tags, favorite
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(input.hostname.trim())
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.group_id)
    .bind(&input.authentication_type)
    .bind(&input.key_id)
    .bind(&input.identity_id)
    .bind(&input.proxy_jump_host_id)
    .bind(&input.startup_command)
    .bind(&input.working_directory)
    .bind(
        input
            .environment
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| LumaError::InvalidInput(format!("invalid environment: {error}")))?,
    )
    .bind(
        serde_json::to_string(&input.tags)
            .map_err(|error| LumaError::InvalidInput(format!("invalid tags: {error}")))?,
    )
    .bind(input.favorite)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("host creation failed".into()))
}

pub async fn update(pool: &SqlitePool, id: &str, mut input: HostInput) -> Result<Host> {
    if get(pool, id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown host".into()));
    }
    clear_host_credentials_when_using_identity(&mut input);
    validate_fields(&input)?;
    validate_references(pool, Some(id), &input).await?;

    input.username = optional_trimmed(input.username);
    input.group_id = optional_trimmed(input.group_id);
    input.key_id = optional_trimmed(input.key_id);
    input.identity_id = optional_trimmed(input.identity_id);
    input.proxy_jump_host_id = optional_trimmed(input.proxy_jump_host_id);
    input.startup_command = optional_trimmed(input.startup_command);
    input.working_directory = optional_trimmed(input.working_directory);
    input.tags = input
        .tags
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .collect();

    sqlx::query(
        "UPDATE hosts SET
             name = ?2, hostname = ?3, port = ?4, username = ?5, group_id = ?6,
             auth_type = ?7, key_id = ?8, identity_id = ?9, proxy_jump_host_id = ?10,
             startup_command = ?11, working_directory = ?12, environment = ?13,
             tags = ?14, favorite = ?15,
             os_id = CASE WHEN hostname <> ?3 OR port <> ?4 THEN NULL ELSE os_id END,
             os_pretty_name = CASE WHEN hostname <> ?3 OR port <> ?4 THEN NULL ELSE os_pretty_name END,
             updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(input.hostname.trim())
    .bind(input.port)
    .bind(&input.username)
    .bind(&input.group_id)
    .bind(&input.authentication_type)
    .bind(&input.key_id)
    .bind(&input.identity_id)
    .bind(&input.proxy_jump_host_id)
    .bind(&input.startup_command)
    .bind(&input.working_directory)
    .bind(
        input
            .environment
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| LumaError::InvalidInput(format!("invalid environment: {error}")))?,
    )
    .bind(
        serde_json::to_string(&input.tags)
            .map_err(|error| LumaError::InvalidInput(format!("invalid tags: {error}")))?,
    )
    .bind(input.favorite)
    .execute(pool)
    .await?;

    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))
}

pub async fn duplicate(pool: &SqlitePool, id: &str) -> Result<Host> {
    let host = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown host".into()))?;
    let suffix = " Copy";
    let max_base_length = MAX_NAME_LENGTH.saturating_sub(suffix.len());
    let mut base = host.name;
    base.truncate(base.floor_char_boundary(max_base_length));
    create(
        pool,
        HostInput {
            name: format!("{base}{suffix}"),
            hostname: host.hostname,
            port: i64::from(host.port),
            username: host.username,
            group_id: host.group_id,
            authentication_type: host.authentication_type,
            key_id: host.key_id,
            identity_id: host.identity_id,
            proxy_jump_host_id: host.proxy_jump_host_id,
            startup_command: host.startup_command,
            working_directory: host.working_directory,
            environment: host.environment,
            tags: host.tags,
            favorite: false,
        },
    )
    .await
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM hosts WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown host".into()));
    }
    sqlx::query(
        "INSERT INTO tombstones (object_type, object_id, deleted_at)
         VALUES ('host', ?1, unixepoch())
         ON CONFLICT(object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
    )
    .bind(id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

pub async fn record_recent_connection(pool: &SqlitePool, host_id: &str) -> Result<()> {
    validate_reference(pool, "hosts", host_id, "host").await?;
    sqlx::query("INSERT INTO recent_connections (host_id, connected_at) VALUES (?1, unixepoch())")
        .bind(host_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Retain best-effort remote OS metadata for host-list presentation. This is
/// learned state, not user-authored host configuration, so it intentionally
/// does not advance `updated_at` or participate in sync conflict resolution.
pub async fn record_remote_os(
    pool: &SqlitePool,
    host_id: &str,
    os_id: &str,
    pretty_name: Option<&str>,
) -> Result<()> {
    const IDS: [&str; 25] = [
        "ubuntu",
        "debian",
        "fedora",
        "rhel",
        "centos",
        "rocky",
        "almalinux",
        "arch",
        "manjaro",
        "alpine",
        "opensuse",
        "suse",
        "mint",
        "kali",
        "gentoo",
        "void",
        "nixos",
        "amazon",
        "oracle",
        "raspbian",
        "freebsd",
        "macos",
        "windows",
        "linux",
        "unknown",
    ];
    if !IDS.contains(&os_id) || os_id.is_empty() {
        return Err(LumaError::InvalidInput("unsupported remote OS id".into()));
    }
    let pretty_name = pretty_name
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.len() <= MAX_OS_PRETTY_NAME_LENGTH);
    let result = sqlx::query("UPDATE hosts SET os_id = ?2, os_pretty_name = ?3 WHERE id = ?1")
        .bind(host_id)
        .bind(os_id)
        .bind(pretty_name)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown host".into()));
    }
    Ok(())
}

pub async fn recent(pool: &SqlitePool, limit: u8) -> Result<Vec<Host>> {
    let limit = i64::from(limit.clamp(1, 50));
    let query = format!(
        "SELECT {} FROM hosts h
         JOIN (
             SELECT host_id, MAX(connected_at) AS last_connected_at, MAX(id) AS latest_id
             FROM recent_connections
             GROUP BY host_id
             ORDER BY last_connected_at DESC, latest_id DESC
             LIMIT ?1
         ) recent ON recent.host_id = h.id
         ORDER BY recent.last_connected_at DESC, recent.latest_id DESC, h.name COLLATE NOCASE",
        HOST_COLUMNS
            .split(", ")
            .map(|column| format!("h.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let rows = sqlx::query(&query).bind(limit).fetch_all(pool).await?;
    Ok(rows.iter().map(row_to_host).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::key_references::{self, KeyReferenceInput};

    fn sample_input(name: &str, hostname: &str) -> HostInput {
        HostInput {
            name: name.into(),
            hostname: hostname.into(),
            port: 22,
            username: Some("alice".into()),
            group_id: None,
            authentication_type: "agent".into(),
            key_id: None,
            identity_id: None,
            proxy_jump_host_id: None,
            startup_command: None,
            working_directory: None,
            environment: None,
            tags: vec!["test".into()],
            favorite: false,
        }
    }

    #[test]
    fn identity_selection_discards_host_specific_credentials() {
        let mut input = sample_input("Identity host", "example.com");
        input.identity_id = Some("identity-1".into());
        input.username = Some("duplicate-user".into());
        input.authentication_type = "key".into();
        input.key_id = Some("duplicate-key".into());

        clear_host_credentials_when_using_identity(&mut input);

        assert_eq!(input.username, None);
        assert_eq!(input.authentication_type, "agent");
        assert_eq!(input.key_id, None);
    }

    #[tokio::test]
    async fn host_crud_duplicate_recent_and_tombstone() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let created = create(&pool, sample_input("Server", "server.example.com"))
            .await
            .unwrap();
        assert_eq!(created.port, 22);

        let duplicate = duplicate(&pool, &created.id).await.unwrap();
        assert_eq!(duplicate.name, "Server Copy");
        assert!(!duplicate.favorite);

        record_recent_connection(&pool, &created.id).await.unwrap();
        record_recent_connection(&pool, &created.id).await.unwrap();
        record_recent_connection(&pool, &duplicate.id)
            .await
            .unwrap();
        let recent_hosts = recent(&pool, 10).await.unwrap();
        assert_eq!(recent_hosts.len(), 2);

        delete(&pool, &created.id).await.unwrap();
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type = 'host' AND object_id = ?1",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);
    }

    #[tokio::test]
    async fn retains_remote_os_until_the_connection_target_changes() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let created = create(&pool, sample_input("Server", "server.example.com"))
            .await
            .unwrap();

        record_remote_os(&pool, &created.id, "ubuntu", Some("Ubuntu 24.04 LTS"))
            .await
            .unwrap();
        let detected = get(&pool, &created.id).await.unwrap().unwrap();
        assert_eq!(detected.os_id.as_deref(), Some("ubuntu"));
        assert_eq!(detected.os_pretty_name.as_deref(), Some("Ubuntu 24.04 LTS"));

        let mut moved = sample_input("Server", "replacement.example.com");
        moved.port = 2222;
        let moved = update(&pool, &created.id, moved).await.unwrap();
        assert_eq!(moved.os_id, None);
        assert_eq!(moved.os_pretty_name, None);
    }

    #[tokio::test]
    async fn validates_hosts_and_rejects_option_injection() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        for hostname in ["", "-oProxyCommand=bad", "has space", "bad@example.com"] {
            let result = create(&pool, sample_input("Bad", hostname)).await;
            assert!(result.is_err(), "accepted hostname {hostname:?}");
        }

        let mut bad_username = sample_input("Bad user", "example.com");
        bad_username.username = Some("-Fmalicious".into());
        assert!(create(&pool, bad_username).await.is_err());

        let mut bad_port = sample_input("Bad port", "example.com");
        bad_port.port = 65_536;
        assert!(create(&pool, bad_port).await.is_err());

        let mut key_auth = sample_input("Missing key", "example.com");
        key_auth.authentication_type = "key".into();
        assert!(create(&pool, key_auth).await.is_err());

        let key = key_references::create(
            &pool,
            KeyReferenceInput {
                name: "Test key".into(),
                public_key: None,
                storage_mode: "local-path".into(),
                local_path: Some("/not/required/to/exist/yet".into()),
                fingerprint: None,
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();
        let mut valid_key_auth = sample_input("Key", "example.com");
        valid_key_auth.authentication_type = "key".into();
        valid_key_auth.key_id = Some(key.id);
        assert!(create(&pool, valid_key_auth).await.is_ok());
    }

    #[tokio::test]
    async fn rejects_proxy_jump_cycles() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let first = create(&pool, sample_input("First", "first.example.com"))
            .await
            .unwrap();
        let mut second_input = sample_input("Second", "second.example.com");
        second_input.proxy_jump_host_id = Some(first.id.clone());
        let second = create(&pool, second_input).await.unwrap();

        let mut first_update = sample_input("First", "first.example.com");
        first_update.proxy_jump_host_id = Some(second.id.clone());
        let error = update(&pool, &first.id, first_update).await.unwrap_err();
        assert_eq!(error.category(), "invalid-input");

        let mut self_jump = sample_input("First", "first.example.com");
        self_jump.proxy_jump_host_id = Some(first.id.clone());
        assert!(update(&pool, &first.id, self_jump).await.is_err());
    }
}
