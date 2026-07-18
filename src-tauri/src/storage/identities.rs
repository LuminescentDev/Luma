use keyring::Entry;
use serde::{Deserialize, Serialize};
use sqlx::{Executor, Row, Sqlite, SqlitePool};
use zeroize::Zeroizing;

use crate::errors::{LumaError, Result};

const KEYRING_SERVICE: &str = "luma.ssh.identity";

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
    if input.password.as_ref().is_some_and(|p| p.len() > 16 * 1024) {
        return Err(LumaError::InvalidInput("password is too large".into()));
    }
    Ok(())
}

fn entry(id: &str) -> Result<Entry> {
    Entry::new(KEYRING_SERVICE, id)
        .map_err(|e| LumaError::InvalidInput(format!("credential store unavailable: {e}")))
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

async fn check_key<'e, E>(executor: E, key_id: &Option<String>) -> Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    if let Some(id) = key_id.as_ref().filter(|id| !id.trim().is_empty()) {
        let exists: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM key_references WHERE id=?1")
            .bind(id)
            .fetch_one(executor)
            .await?;
        if exists == 0 {
            return Err(LumaError::InvalidInput("unknown key reference".into()));
        }
    }
    Ok(())
}

trait CredentialStore {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>>;
    fn set(&self, id: &str, password: &str) -> Result<()>;
    fn delete(&self, id: &str) -> Result<()>;
}

struct OsCredentialStore;

impl CredentialStore for OsCredentialStore {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>> {
        match entry(id)?.get_password() {
            Ok(password) => Ok(Some(Zeroizing::new(password))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(LumaError::InvalidInput(format!(
                "could not read password from OS credential store: {error}"
            ))),
        }
    }

    fn set(&self, id: &str, password: &str) -> Result<()> {
        entry(id)?.set_password(password).map_err(|error| {
            LumaError::InvalidInput(format!(
                "could not save password in OS credential store: {error}"
            ))
        })
    }

    fn delete(&self, id: &str) -> Result<()> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(LumaError::InvalidInput(format!(
                "could not remove password from OS credential store: {error}"
            ))),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum IdentityWriteFailure {
    None,
    AfterCredentialWrite,
}

async fn inject_failure(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    failure: IdentityWriteFailure,
) -> Result<()> {
    if failure == IdentityWriteFailure::AfterCredentialWrite {
        sqlx::query("INSERT INTO __luma_injected_identity_failure DEFAULT VALUES")
            .execute(&mut **transaction)
            .await?;
    }
    Ok(())
}

fn apply_password_change(
    store: &impl CredentialStore,
    id: &str,
    password: Option<&str>,
) -> Result<Option<Option<Zeroizing<String>>>> {
    let Some(password) = password else {
        return Ok(None);
    };
    let previous = store.get(id)?;
    if password.is_empty() {
        store.delete(id)?;
    } else {
        store.set(id, password)?;
    }
    Ok(Some(previous))
}

fn restore_password(store: &impl CredentialStore, id: &str, previous: Option<Zeroizing<String>>) {
    let result = match previous {
        Some(password) => store.set(id, &password),
        None => store.delete(id),
    };
    if let Err(error) = result {
        tracing::error!(identity_id = %id, %error, "could not restore OS credential after database failure");
    }
}

async fn create_with_store(
    pool: &SqlitePool,
    input: IdentityInput,
    store: &impl CredentialStore,
    failure: IdentityWriteFailure,
) -> Result<Identity> {
    validate(&input)?;
    let id = uuid::Uuid::new_v4().to_string();
    let has_password = input
        .password
        .as_ref()
        .is_some_and(|password| !password.is_empty());
    let mut transaction = pool.begin().await?;
    check_key(&mut *transaction, &input.key_id).await?;
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

    let previous = apply_password_change(store, &id, input.password.as_deref())?;
    if let Err(error) = inject_failure(&mut transaction, failure).await {
        if let Some(previous) = previous {
            restore_password(store, &id, previous);
        }
        return Err(error);
    }
    if let Err(error) = transaction.commit().await {
        if let Some(previous) = previous {
            restore_password(store, &id, previous);
        }
        return Err(error.into());
    }
    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("identity creation failed".into()))
}

pub async fn create(pool: &SqlitePool, input: IdentityInput) -> Result<Identity> {
    create_with_store(pool, input, &OsCredentialStore, IdentityWriteFailure::None).await
}

async fn update_with_store(
    pool: &SqlitePool,
    id: &str,
    input: IdentityInput,
    store: &impl CredentialStore,
    failure: IdentityWriteFailure,
) -> Result<Identity> {
    validate(&input)?;
    let mut transaction = pool.begin().await?;
    check_key(&mut *transaction, &input.key_id).await?;
    let current =
        sqlx::query("SELECT id, name, username, key_id, has_password FROM identities WHERE id=?1")
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await?
            .as_ref()
            .map(row)
            .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))?;
    let has_password = input
        .password
        .as_ref()
        .map_or(current.has_password, |password| !password.is_empty());
    sqlx::query("UPDATE identities SET name=?2,username=?3,key_id=?4,has_password=?5,updated_at=unixepoch() WHERE id=?1")
        .bind(id)
        .bind(input.name.trim())
        .bind(input.username.trim())
        .bind(input.key_id.as_ref().filter(|value| !value.is_empty()))
        .bind(has_password)
        .execute(&mut *transaction)
        .await?;

    let previous = apply_password_change(store, id, input.password.as_deref())?;
    if let Err(error) = inject_failure(&mut transaction, failure).await {
        if let Some(previous) = previous {
            restore_password(store, id, previous);
        }
        return Err(error);
    }
    if let Err(error) = transaction.commit().await {
        if let Some(previous) = previous {
            restore_password(store, id, previous);
        }
        return Err(error.into());
    }
    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))
}

pub async fn update(pool: &SqlitePool, id: &str, input: IdentityInput) -> Result<Identity> {
    update_with_store(
        pool,
        id,
        input,
        &OsCredentialStore,
        IdentityWriteFailure::None,
    )
    .await
}

async fn delete_with_store(
    pool: &SqlitePool,
    id: &str,
    store: &impl CredentialStore,
    failure: IdentityWriteFailure,
) -> Result<()> {
    let mut transaction = pool.begin().await?;
    let result = sqlx::query("DELETE FROM identities WHERE id=?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown identity".into()));
    }
    let previous = store.get(id)?;
    store.delete(id)?;
    if let Err(error) = inject_failure(&mut transaction, failure).await {
        restore_password(store, id, previous);
        return Err(error);
    }
    if let Err(error) = transaction.commit().await {
        restore_password(store, id, previous);
        return Err(error.into());
    }
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    delete_with_store(pool, id, &OsCredentialStore, IdentityWriteFailure::None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryCredentialStore(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, id: &str) -> Result<Option<Zeroizing<String>>> {
            Ok(self.0.lock().unwrap().get(id).cloned().map(Zeroizing::new))
        }

        fn set(&self, id: &str, password: &str) -> Result<()> {
            self.0
                .lock()
                .unwrap()
                .insert(id.to_string(), password.to_string());
            Ok(())
        }

        fn delete(&self, id: &str) -> Result<()> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn input(name: &str, password: Option<&str>) -> IdentityInput {
        IdentityInput {
            name: name.into(),
            username: "alice".into(),
            key_id: None,
            password: password.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn create_failure_removes_new_os_credential_and_metadata() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let store = MemoryCredentialStore::default();
        let error = create_with_store(
            &pool,
            input("Create", Some("secret")),
            &store,
            IdentityWriteFailure::AfterCredentialWrite,
        )
        .await
        .unwrap_err();
        assert_eq!(error.category(), "database");
        assert!(store.0.lock().unwrap().is_empty());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM identities")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn update_failure_restores_previous_os_credential_and_metadata() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let store = MemoryCredentialStore::default();
        let created = create_with_store(
            &pool,
            input("Original", Some("old secret")),
            &store,
            IdentityWriteFailure::None,
        )
        .await
        .unwrap();
        let error = update_with_store(
            &pool,
            &created.id,
            input("Changed", Some("new secret")),
            &store,
            IdentityWriteFailure::AfterCredentialWrite,
        )
        .await
        .unwrap_err();
        assert_eq!(error.category(), "database");
        assert_eq!(
            store.0.lock().unwrap().get(&created.id).map(String::as_str),
            Some("old secret")
        );
        assert_eq!(
            get(&pool, &created.id).await.unwrap().unwrap().name,
            "Original"
        );
    }

    #[tokio::test]
    async fn delete_failure_restores_previous_os_credential_and_metadata() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let store = MemoryCredentialStore::default();
        let created = create_with_store(
            &pool,
            input("Delete", Some("keep secret")),
            &store,
            IdentityWriteFailure::None,
        )
        .await
        .unwrap();
        let error = delete_with_store(
            &pool,
            &created.id,
            &store,
            IdentityWriteFailure::AfterCredentialWrite,
        )
        .await
        .unwrap_err();
        assert_eq!(error.category(), "database");
        assert_eq!(
            store.0.lock().unwrap().get(&created.id).map(String::as_str),
            Some("keep secret")
        );
        assert!(get(&pool, &created.id).await.unwrap().is_some());
    }
}
