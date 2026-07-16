use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};
use crate::storage::hosts;

const MAX_NAME_LENGTH: usize = 128;
const MAX_ADDRESS_LENGTH: usize = 253;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: String,
    pub host_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub forward_type: String,
    pub bind_address: String,
    pub local_port: Option<u16>,
    pub destination_host: Option<String>,
    pub destination_port: Option<u16>,
    pub remote_port: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardInput {
    pub host_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub forward_type: String,
    #[serde(default = "default_bind_address")]
    pub bind_address: String,
    pub local_port: Option<i64>,
    pub destination_host: Option<String>,
    pub destination_port: Option<i64>,
    pub remote_port: Option<i64>,
}

fn default_bind_address() -> String {
    "127.0.0.1".into()
}

fn optional_trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn validate_port(value: Option<i64>, field: &str, required: bool) -> Result<()> {
    match value {
        Some(port) if (1..=65_535).contains(&port) => Ok(()),
        Some(_) => Err(LumaError::InvalidInput(format!(
            "{field} must be between 1 and 65535"
        ))),
        None if required => Err(LumaError::InvalidInput(format!("{field} is required"))),
        None => Ok(()),
    }
}

fn validate_bind_address(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_ADDRESS_LENGTH {
        return Err(LumaError::InvalidInput(format!(
            "bindAddress must be 1-{MAX_ADDRESS_LENGTH} characters"
        )));
    }
    if value.starts_with('-') {
        return Err(LumaError::InvalidInput(
            "bindAddress must not start with '-'".into(),
        ));
    }
    if !value.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(character, '.' | '-' | '_' | ':' | '[' | ']' | '%')
    }) {
        return Err(LumaError::InvalidInput(
            "bindAddress contains whitespace or unsupported characters".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_fields(input: &PortForwardInput) -> Result<()> {
    let name = input.name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH || name.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "port forward name must be 1-{MAX_NAME_LENGTH} characters"
        )));
    }

    validate_bind_address(input.bind_address.trim())?;

    match input.forward_type.as_str() {
        "local" => {
            validate_port(input.local_port, "localPort", true)?;
            validate_port(input.destination_port, "destinationPort", true)?;
            if input.remote_port.is_some() {
                return Err(LumaError::InvalidInput(
                    "remotePort must be null for local forwarding".into(),
                ));
            }
            let destination = input
                .destination_host
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| LumaError::InvalidInput("destinationHost is required".into()))?;
            hosts::validate_safe_hostname(destination)?;
        }
        "remote" => {
            validate_port(input.remote_port, "remotePort", true)?;
            validate_port(input.destination_port, "destinationPort", true)?;
            if input.local_port.is_some() {
                return Err(LumaError::InvalidInput(
                    "localPort must be null for remote forwarding".into(),
                ));
            }
            let destination = input
                .destination_host
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| LumaError::InvalidInput("destinationHost is required".into()))?;
            hosts::validate_safe_hostname(destination)?;
        }
        "dynamic" => {
            validate_port(input.local_port, "localPort", true)?;
            if input.destination_host.is_some()
                || input.destination_port.is_some()
                || input.remote_port.is_some()
            {
                return Err(LumaError::InvalidInput(
                    "destinationHost, destinationPort, and remotePort must be null for dynamic forwarding"
                        .into(),
                ));
            }
        }
        _ => {
            return Err(LumaError::InvalidInput(
                "type must be 'local', 'remote', or 'dynamic'".into(),
            ));
        }
    }

    Ok(())
}

async fn validate_host(pool: &SqlitePool, host_id: &str) -> Result<()> {
    if hosts::get(pool, host_id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown host".into()));
    }
    Ok(())
}

fn row_port(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<u16> {
    row.get::<Option<i64>, _>(column)
        .and_then(|port| u16::try_from(port).ok())
}

fn row_to_port_forward(row: &sqlx::sqlite::SqliteRow) -> PortForward {
    PortForward {
        id: row.get("id"),
        host_id: row.get("host_id"),
        name: row.get("name"),
        forward_type: row.get("type"),
        bind_address: row.get("bind_address"),
        local_port: row_port(row, "local_port"),
        destination_host: row.get("destination_host"),
        destination_port: row_port(row, "destination_port"),
        remote_port: row_port(row, "remote_port"),
    }
}

const PORT_FORWARD_COLUMNS: &str =
    "id, host_id, name, type, bind_address, local_port, destination_host, destination_port, remote_port";

pub async fn list(pool: &SqlitePool, host_id: Option<&str>) -> Result<Vec<PortForward>> {
    let rows = if let Some(host_id) = host_id {
        let query = format!(
            "SELECT {PORT_FORWARD_COLUMNS} FROM port_forwards
             WHERE host_id = ?1 ORDER BY name COLLATE NOCASE"
        );
        sqlx::query(&query).bind(host_id).fetch_all(pool).await?
    } else {
        let query = format!(
            "SELECT {PORT_FORWARD_COLUMNS} FROM port_forwards
             ORDER BY name COLLATE NOCASE"
        );
        sqlx::query(&query).fetch_all(pool).await?
    };
    Ok(rows.iter().map(row_to_port_forward).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<PortForward>> {
    let query = format!("SELECT {PORT_FORWARD_COLUMNS} FROM port_forwards WHERE id = ?1");
    let row = sqlx::query(&query).bind(id).fetch_optional(pool).await?;
    Ok(row.as_ref().map(row_to_port_forward))
}

pub async fn create(pool: &SqlitePool, mut input: PortForwardInput) -> Result<PortForward> {
    validate_fields(&input)?;
    input.host_id = input.host_id.trim().to_string();
    validate_host(pool, &input.host_id).await?;
    input.destination_host = optional_trimmed(input.destination_host);

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO port_forwards (
             id, host_id, name, type, bind_address, local_port, destination_host,
             destination_port, remote_port
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(&id)
    .bind(&input.host_id)
    .bind(input.name.trim())
    .bind(&input.forward_type)
    .bind(input.bind_address.trim())
    .bind(input.local_port)
    .bind(&input.destination_host)
    .bind(input.destination_port)
    .bind(input.remote_port)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("port forward creation failed".into()))
}

pub async fn update(
    pool: &SqlitePool,
    id: &str,
    mut input: PortForwardInput,
) -> Result<PortForward> {
    if get(pool, id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown port forward".into()));
    }
    validate_fields(&input)?;
    input.host_id = input.host_id.trim().to_string();
    validate_host(pool, &input.host_id).await?;
    input.destination_host = optional_trimmed(input.destination_host);

    sqlx::query(
        "UPDATE port_forwards SET host_id = ?2, name = ?3, type = ?4, bind_address = ?5,
             local_port = ?6, destination_host = ?7, destination_port = ?8,
             remote_port = ?9, updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(&input.host_id)
    .bind(input.name.trim())
    .bind(&input.forward_type)
    .bind(input.bind_address.trim())
    .bind(input.local_port)
    .bind(&input.destination_host)
    .bind(input.destination_port)
    .bind(input.remote_port)
    .execute(pool)
    .await?;

    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown port forward".into()))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM port_forwards WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown port forward".into()));
    }
    sqlx::query(
        "INSERT INTO tombstones (object_type, object_id, deleted_at)
         VALUES ('port_forward', ?1, unixepoch())
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
    use crate::storage::hosts::HostInput;

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

    fn local_input(host_id: &str) -> PortForwardInput {
        PortForwardInput {
            host_id: host_id.into(),
            name: "Web".into(),
            forward_type: "local".into(),
            bind_address: "127.0.0.1".into(),
            local_port: Some(8080),
            destination_host: Some("web.internal".into()),
            destination_port: Some(80),
            remote_port: None,
        }
    }

    #[tokio::test]
    async fn port_forward_crud_filter_and_tombstone() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let host_id = create_host(&pool).await;
        let created = create(&pool, local_input(&host_id)).await.unwrap();
        assert_eq!(created.local_port, Some(8080));
        assert_eq!(
            list(&pool, Some(&host_id)).await.unwrap(),
            vec![created.clone()]
        );

        let updated = update(
            &pool,
            &created.id,
            PortForwardInput {
                host_id: host_id.clone(),
                name: "SOCKS".into(),
                forward_type: "dynamic".into(),
                bind_address: "localhost".into(),
                local_port: Some(1080),
                destination_host: None,
                destination_port: None,
                remote_port: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.forward_type, "dynamic");

        delete(&pool, &created.id).await.unwrap();
        let tombstone: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones WHERE object_type = 'port_forward' AND object_id = ?1",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone, 1);
    }

    #[test]
    fn validates_type_specific_fields_and_ports() {
        let mut local = local_input("host");
        assert!(validate_fields(&local).is_ok());
        local.local_port = Some(0);
        assert!(validate_fields(&local).is_err());
        local.local_port = Some(8080);
        local.destination_port = None;
        assert!(validate_fields(&local).is_err());

        let remote = PortForwardInput {
            host_id: "host".into(),
            name: "Remote database".into(),
            forward_type: "remote".into(),
            bind_address: "127.0.0.1".into(),
            local_port: None,
            destination_host: Some("db.internal".into()),
            destination_port: Some(5432),
            remote_port: Some(15432),
        };
        assert!(validate_fields(&remote).is_ok());

        let mut dynamic = PortForwardInput {
            host_id: "host".into(),
            name: "SOCKS".into(),
            forward_type: "dynamic".into(),
            bind_address: "127.0.0.1".into(),
            local_port: Some(1080),
            destination_host: None,
            destination_port: None,
            remote_port: None,
        };
        assert!(validate_fields(&dynamic).is_ok());
        dynamic.destination_host = Some("example.com".into());
        assert!(validate_fields(&dynamic).is_err());
    }

    #[test]
    fn rejects_forwarding_option_injection() {
        for bind_address in ["-Rmalicious", "127.0.0.1 -oProxyCommand=bad", "has space"] {
            let mut input = local_input("host");
            input.bind_address = bind_address.into();
            assert!(
                validate_fields(&input).is_err(),
                "accepted bind address {bind_address:?}"
            );
        }
        for destination_host in ["-oProxyCommand=bad", "host name", "bad@example.com"] {
            let mut input = local_input("host");
            input.destination_host = Some(destination_host.into());
            assert!(
                validate_fields(&input).is_err(),
                "accepted destination {destination_host:?}"
            );
        }
    }
}
