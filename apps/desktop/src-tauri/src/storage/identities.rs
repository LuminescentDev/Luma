//! Identities on desktop keep their password in the OS credential store when
//! they belong to the personal vault, and in the encrypted keystore when they
//! belong to a shared one. The OS keyring is device-local and cannot be shared,
//! so a shared identity's password has to live where sync can reach it.

use keyring::Entry;
use serde::{Deserialize, Serialize};
use sqlx::{Executor, Row, Sqlite, SqlitePool};
use zeroize::Zeroizing;

use crate::errors::{LumaError, Result};
use crate::keystore::{self, KeystoreState};
use crate::storage::vaults::PERSONAL_VAULT_ID;

const KEYRING_SERVICE: &str = "luma.ssh.identity";
const PASSWORD_SECRET_TYPE: &str = "password";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub id: String,
    pub vault_id: String,
    pub name: String,
    pub username: String,
    pub key_id: Option<String>,
    pub has_password: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityInput {
    #[serde(default = "crate::storage::vaults::default_id")]
    pub vault_id: String,
    pub name: String,
    pub username: String,
    pub key_id: Option<String>,
    /// None preserves the existing password on update; an empty value removes it.
    pub password: Option<String>,
}

fn uses_keystore(vault_id: &str) -> bool {
    vault_id != PERSONAL_VAULT_ID
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

const IDENTITY_COLUMNS: &str = "id, vault_id, name, username, key_id, has_password";

fn row(row: &sqlx::sqlite::SqliteRow) -> Identity {
    Identity {
        id: row.get("id"),
        vault_id: row.get("vault_id"),
        name: row.get("name"),
        username: row.get("username"),
        key_id: row.get("key_id"),
        has_password: row.get::<i64, _>("has_password") != 0,
    }
}

/// `vault_id` of `None` spans every vault; pass `Some` to scope to one vault.
pub async fn list(pool: &SqlitePool, vault_id: Option<&str>) -> Result<Vec<Identity>> {
    let query = format!(
        "SELECT {IDENTITY_COLUMNS} FROM identities \
         WHERE (?1 IS NULL OR vault_id = ?1) ORDER BY name COLLATE NOCASE"
    );
    let rows = sqlx::query(&query).bind(vault_id).fetch_all(pool).await?;
    Ok(rows.iter().map(row).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Identity>> {
    let query = format!("SELECT {IDENTITY_COLUMNS} FROM identities WHERE id=?1");
    let value = sqlx::query(&query).bind(id).fetch_optional(pool).await?;
    Ok(value.as_ref().map(row))
}

async fn vault_of(pool: &SqlitePool, id: &str) -> Result<String> {
    sqlx::query_scalar("SELECT vault_id FROM identities WHERE id=?1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))
}

pub async fn password(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
) -> Result<Option<Zeroizing<String>>> {
    if uses_keystore(&vault_of(pool, id).await?) {
        return keystore::load(pool, keystore_state, "identity", id, PASSWORD_SECRET_TYPE)
            .await
            .map(|value| value.map(Zeroizing::new));
    }
    OsCredentialStore.get(id)
}

pub async fn set_synced_password(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
    password: &str,
) -> Result<()> {
    if uses_keystore(&vault_of(pool, id).await?) {
        keystore::store(
            pool,
            keystore_state,
            "identity",
            id,
            PASSWORD_SECRET_TYPE,
            password,
        )
        .await?;
    } else {
        OsCredentialStore.set(id, password)?;
    }
    sqlx::query("UPDATE identities SET has_password=1 WHERE id=?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Called after the identity row is already gone, so the vault is no longer
/// knowable; the keystore copy is removed inside the deleting transaction and
/// only the keyring entry is left to clear here.
pub fn purge_synced_password(id: &str) {
    let _ = OsCredentialStore.delete(id);
}

async fn store_keystore_password(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    keystore_state: &KeystoreState,
    id: &str,
    password: Option<&str>,
) -> Result<()> {
    let Some(password) = password else {
        return Ok(());
    };
    if password.is_empty() {
        sqlx::query(
            "DELETE FROM keystore_secrets WHERE owner_type='identity' AND owner_id=?1 AND secret_type=?2",
        )
        .bind(id)
        .bind(PASSWORD_SECRET_TYPE)
        .execute(&mut **transaction)
        .await?;
    } else {
        keystore::store(
            &mut **transaction,
            keystore_state,
            "identity",
            id,
            PASSWORD_SECRET_TYPE,
            password,
        )
        .await?;
    }
    Ok(())
}

async fn write_tombstone(
    transaction: &mut sqlx::Transaction<'_, Sqlite>,
    vault_id: &str,
    id: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO tombstones (vault_id, object_type, object_id, deleted_at) \
         VALUES (?2, 'identity', ?1, unixepoch()) \
         ON CONFLICT(vault_id, object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
    )
    .bind(id)
    .bind(vault_id)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

/// Scoping the lookup to the identity's own vault is what stops an identity from
/// referencing a key another member of that vault cannot see.
async fn check_key<'e, E>(executor: E, vault_id: &str, key_id: &Option<String>) -> Result<()>
where
    E: Executor<'e, Database = Sqlite>,
{
    if let Some(id) = key_id.as_ref().filter(|id| !id.trim().is_empty()) {
        let exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM key_references WHERE id=?1 AND vault_id=?2")
                .bind(id)
                .bind(vault_id)
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
    keystore_state: &KeystoreState,
    input: IdentityInput,
    store: &impl CredentialStore,
    failure: IdentityWriteFailure,
) -> Result<Identity> {
    validate(&input)?;
    super::vaults::require(pool, &input.vault_id).await?;
    let keystore_backed = uses_keystore(&input.vault_id);
    let id = uuid::Uuid::new_v4().to_string();
    let has_password = input
        .password
        .as_ref()
        .is_some_and(|password| !password.is_empty());
    let mut transaction = pool.begin().await?;
    check_key(&mut *transaction, &input.vault_id, &input.key_id).await?;
    sqlx::query(
        "INSERT INTO identities (id,vault_id,name,username,key_id,has_password) VALUES (?1,?6,?2,?3,?4,?5)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(input.username.trim())
    .bind(input.key_id.as_ref().filter(|value| !value.is_empty()))
    .bind(has_password)
    .bind(&input.vault_id)
    .execute(&mut *transaction)
    .await?;

    let previous = if keystore_backed {
        store_keystore_password(
            &mut transaction,
            keystore_state,
            &id,
            input.password.as_deref(),
        )
        .await?;
        None
    } else {
        apply_password_change(store, &id, input.password.as_deref())?
    };
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

pub async fn create(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    input: IdentityInput,
) -> Result<Identity> {
    create_with_store(
        pool,
        keystore_state,
        input,
        &OsCredentialStore,
        IdentityWriteFailure::None,
    )
    .await
}

async fn update_with_store(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
    mut input: IdentityInput,
    store: &impl CredentialStore,
    failure: IdentityWriteFailure,
) -> Result<Identity> {
    validate(&input)?;
    let mut transaction = pool.begin().await?;
    let query = format!("SELECT {IDENTITY_COLUMNS} FROM identities WHERE id=?1");
    let current = sqlx::query(&query)
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?
        .as_ref()
        .map(row)
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))?;
    // An identity stays in the vault it was created in; moving between vaults
    // means re-encrypting under another key and is a separate operation.
    input.vault_id = current.vault_id;
    let keystore_backed = uses_keystore(&input.vault_id);
    check_key(&mut *transaction, &input.vault_id, &input.key_id).await?;
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

    let previous = if keystore_backed {
        store_keystore_password(
            &mut transaction,
            keystore_state,
            id,
            input.password.as_deref(),
        )
        .await?;
        None
    } else {
        apply_password_change(store, id, input.password.as_deref())?
    };
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

pub async fn update(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
    input: IdentityInput,
) -> Result<Identity> {
    update_with_store(
        pool,
        keystore_state,
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
    let vault_id: String = sqlx::query_scalar("SELECT vault_id FROM identities WHERE id=?1")
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))?;
    sqlx::query("DELETE FROM identities WHERE id=?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    keystore::delete(&mut *transaction, "identity", id).await?;
    write_tombstone(&mut transaction, &vault_id, id).await?;
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
            vault_id: crate::storage::vaults::default_id(),
            name: name.into(),
            username: "alice".into(),
            key_id: None,
            password: password.map(str::to_owned),
        }
    }

    async fn shared_vault(pool: &SqlitePool) -> String {
        crate::storage::vaults::create(
            pool,
            crate::storage::vaults::VaultInput {
                name: "Infra".into(),
                share_secrets: true,
                sort_order: 0,
            },
        )
        .await
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn create_failure_removes_new_os_credential_and_metadata() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let store = MemoryCredentialStore::default();
        let error = create_with_store(
            &pool,
            &KeystoreState::default(),
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
            &KeystoreState::default(),
            input("Original", Some("old secret")),
            &store,
            IdentityWriteFailure::None,
        )
        .await
        .unwrap();
        let error = update_with_store(
            &pool,
            &KeystoreState::default(),
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
            &KeystoreState::default(),
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

    #[tokio::test]
    async fn an_identity_cannot_reference_a_key_in_another_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = KeystoreState::default();
        keystore::setup(&pool, &keystore_state, "master password", false)
            .await
            .unwrap();
        let personal_key = crate::storage::key_references::create_metadata(
            &pool,
            crate::storage::key_references::KeyReferenceInput {
                vault_id: crate::storage::vaults::default_id(),
                name: "Personal key".into(),
                public_key: None,
                storage_mode: "local-path".into(),
                local_path: Some("/home/alice/.ssh/id_ed25519".into()),
                fingerprint: None,
                certificate: None,
                private_key: None,
                passphrase: None,
            },
        )
        .await
        .unwrap();

        let vault = shared_vault(&pool).await;
        let mut shared = input("Shared", None);
        shared.vault_id = vault.clone();
        shared.key_id = Some(personal_key.id);
        let error = create(&pool, &keystore_state, shared).await.unwrap_err();
        assert_eq!(error.category(), "invalid-input");

        assert!(list(&pool, Some(&vault)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_shared_identity_password_lives_in_the_keystore_not_the_keyring() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = KeystoreState::default();
        keystore::setup(&pool, &keystore_state, "master password", false)
            .await
            .unwrap();
        let vault = shared_vault(&pool).await;
        let store = MemoryCredentialStore::default();
        let mut shared = input("Shared", Some("team secret"));
        shared.vault_id = vault.clone();
        let created = create_with_store(
            &pool,
            &keystore_state,
            shared,
            &store,
            IdentityWriteFailure::None,
        )
        .await
        .unwrap();

        assert_eq!(created.vault_id, vault);
        assert!(created.has_password);
        assert!(store.0.lock().unwrap().is_empty());
        assert_eq!(
            password(&pool, &keystore_state, &created.id)
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("team secret")
        );

        let mut cleared = input("Shared", Some(""));
        cleared.vault_id = crate::storage::vaults::default_id();
        let updated = update_with_store(
            &pool,
            &keystore_state,
            &created.id,
            cleared,
            &store,
            IdentityWriteFailure::None,
        )
        .await
        .unwrap();
        // The update payload named the personal vault; the stored vault wins.
        assert_eq!(updated.vault_id, vault);
        assert!(!updated.has_password);
        assert!(password(&pool, &keystore_state, &created.id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn deleting_an_identity_writes_a_tombstone_in_its_own_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = KeystoreState::default();
        keystore::setup(&pool, &keystore_state, "master password", false)
            .await
            .unwrap();
        let vault = shared_vault(&pool).await;
        let store = MemoryCredentialStore::default();
        let mut shared = input("Shared", Some("team secret"));
        shared.vault_id = vault.clone();
        let created = create_with_store(
            &pool,
            &keystore_state,
            shared,
            &store,
            IdentityWriteFailure::None,
        )
        .await
        .unwrap();

        delete_with_store(&pool, &created.id, &store, IdentityWriteFailure::None)
            .await
            .unwrap();

        let tombstone_vault: Option<String> = sqlx::query_scalar(
            "SELECT vault_id FROM tombstones WHERE object_type='identity' AND object_id=?1",
        )
        .bind(&created.id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone_vault.as_deref(), Some(vault.as_str()));

        let secrets: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM keystore_secrets WHERE owner_type='identity' AND owner_id=?1",
        )
        .bind(&created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(secrets, 0);
    }
}
