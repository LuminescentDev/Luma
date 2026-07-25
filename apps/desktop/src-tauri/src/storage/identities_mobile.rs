use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use zeroize::Zeroizing;

use crate::errors::{LumaError, Result};
use crate::vault::{self, VaultState};

const PASSWORD_SECRET_TYPE: &str = "password";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub name: String,
    pub username: String,
    pub key_id: Option<String>,
    pub has_password: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInput {
    pub name: String,
    pub username: String,
    pub key_id: Option<String>,
    /// None preserves the existing password on update; an empty value removes it.
    pub password: Option<String>,
}

fn validate(input: &IdentityInput) -> Result<()> {
    if input.name.trim().is_empty() || input.name.len() > 128 {
        return Err(LumaError::InvalidInput(
            "identity name must be 1-128 characters".into(),
        ));
    }
    let username = input.username.trim();
    if username.is_empty()
        || username.len() > 255
        || username.chars().any(char::is_whitespace)
        || username.starts_with('-')
    {
        return Err(LumaError::InvalidInput(
            "identity username is invalid".into(),
        ));
    }
    if input
        .password
        .as_ref()
        .is_some_and(|value| value.len() > 16 * 1024)
    {
        return Err(LumaError::InvalidInput("password is too large".into()));
    }
    Ok(())
}

fn row(row: &sqlx::sqlite::SqliteRow) -> Identity {
    Identity {
        id: row.get("id"),
        name: row.get("name"),
        username: row.get("username"),
        key_id: row.get("key_id"),
        has_password: row.get::<i64, _>("has_password") != 0,
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Identity>> {
    let rows = sqlx::query("SELECT id, name, username, key_id, has_password FROM identities ORDER BY name COLLATE NOCASE").fetch_all(pool).await?;
    Ok(rows.iter().map(row).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Identity>> {
    let value =
        sqlx::query("SELECT id, name, username, key_id, has_password FROM identities WHERE id=?1")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    Ok(value.as_ref().map(row))
}

async fn check_key(pool: &SqlitePool, key_id: &Option<String>) -> Result<()> {
    if let Some(id) = key_id.as_ref().filter(|id| !id.trim().is_empty()) {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_references WHERE id=?1")
            .bind(id)
            .fetch_one(pool)
            .await?;
        if exists == 0 {
            return Err(LumaError::InvalidInput("unknown key reference".into()));
        }
    }
    Ok(())
}

pub async fn password(
    pool: &SqlitePool,
    vault_state: &VaultState,
    id: &str,
) -> Result<Option<Zeroizing<String>>> {
    vault::load(pool, vault_state, "identity", id, PASSWORD_SECRET_TYPE)
        .await
        .map(|value| value.map(Zeroizing::new))
}

pub async fn set_synced_password(
    pool: &SqlitePool,
    vault_state: &VaultState,
    id: &str,
    password: &str,
) -> Result<()> {
    vault::store(
        pool,
        vault_state,
        "identity",
        id,
        PASSWORD_SECRET_TYPE,
        password,
    )
    .await?;
    sqlx::query("UPDATE identities SET has_password=1 WHERE id=?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub fn purge_synced_password(_id: &str) {}

pub async fn create(
    pool: &SqlitePool,
    vault_state: &VaultState,
    input: IdentityInput,
) -> Result<Identity> {
    validate(&input)?;
    check_key(pool, &input.key_id).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let password = input.password.map(Zeroizing::new);
    let has_password = password.as_deref().is_some_and(|value| !value.is_empty());
    let mut transaction = pool.begin().await?;
    sqlx::query(
        "INSERT INTO identities (id,name,username,key_id,has_password) VALUES (?1,?2,?3,?4,?5)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(input.username.trim())
    .bind(input.key_id.as_ref().filter(|value| !value.is_empty()))
    .bind(has_password)
    .execute(&mut *transaction)
    .await?;
    if let Some(password) = password.as_deref().filter(|value| !value.is_empty()) {
        vault::store(
            &mut *transaction,
            vault_state,
            "identity",
            &id,
            PASSWORD_SECRET_TYPE,
            password,
        )
        .await?;
    }
    transaction.commit().await?;
    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("identity creation failed".into()))
}

pub async fn update(
    pool: &SqlitePool,
    vault_state: &VaultState,
    id: &str,
    input: IdentityInput,
) -> Result<Identity> {
    validate(&input)?;
    check_key(pool, &input.key_id).await?;
    let current = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))?;
    let password = input.password.map(Zeroizing::new);
    let has_password = password
        .as_ref()
        .map_or(current.has_password, |value| !value.is_empty());
    let mut transaction = pool.begin().await?;
    sqlx::query("UPDATE identities SET name=?2,username=?3,key_id=?4,has_password=?5,updated_at=unixepoch() WHERE id=?1")
        .bind(id)
        .bind(input.name.trim())
        .bind(input.username.trim())
        .bind(input.key_id.as_ref().filter(|value| !value.is_empty()))
        .bind(has_password)
        .execute(&mut *transaction)
        .await?;
    if let Some(password) = password.as_deref() {
        if password.is_empty() {
            sqlx::query("DELETE FROM vault_secrets WHERE owner_type='identity' AND owner_id=?1 AND secret_type=?2")
                .bind(id)
                .bind(PASSWORD_SECRET_TYPE)
                .execute(&mut *transaction)
                .await?;
        } else {
            vault::store(
                &mut *transaction,
                vault_state,
                "identity",
                id,
                PASSWORD_SECRET_TYPE,
                password,
            )
            .await?;
        }
    }
    transaction.commit().await?;
    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM identities WHERE id=?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown identity".into()));
    }
    vault::delete(&mut *transaction, "identity", id).await?;
    transaction.commit().await?;
    Ok(())
}
