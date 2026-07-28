use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};
use zeroize::Zeroizing;

use crate::errors::{LumaError, Result};
use crate::keystore::{self, KeystoreState};

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

/// Scoping the lookup to the identity's own vault is what stops an identity from
/// referencing a key another member of that vault cannot see.
async fn check_key(pool: &SqlitePool, vault_id: &str, key_id: &Option<String>) -> Result<()> {
    if let Some(id) = key_id.as_ref().filter(|id| !id.trim().is_empty()) {
        let exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM key_references WHERE id=?1 AND vault_id=?2")
                .bind(id)
                .bind(vault_id)
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
    keystore_state: &KeystoreState,
    id: &str,
) -> Result<Option<Zeroizing<String>>> {
    keystore::load(pool, keystore_state, "identity", id, PASSWORD_SECRET_TYPE)
        .await
        .map(|value| value.map(Zeroizing::new))
}

/// Called from the mobile sync path, which the desktop test build of this
/// module does not compile.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub async fn set_synced_password(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    id: &str,
    password: &str,
) -> Result<()> {
    keystore::store(
        pool,
        keystore_state,
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

/// The mobile store keeps passwords only in the keystore, which `delete`
/// already clears, so there is no separate credential to purge.
#[cfg_attr(not(any(target_os = "android", target_os = "ios")), allow(dead_code))]
pub fn purge_synced_password(_id: &str) {}

pub async fn create(
    pool: &SqlitePool,
    keystore_state: &KeystoreState,
    input: IdentityInput,
) -> Result<Identity> {
    validate(&input)?;
    crate::storage::vaults::require(pool, &input.vault_id).await?;
    check_key(pool, &input.vault_id, &input.key_id).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let password = input.password.map(Zeroizing::new);
    let has_password = password.as_deref().is_some_and(|value| !value.is_empty());
    let mut transaction = pool.begin().await?;
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
    if let Some(password) = password.as_deref().filter(|value| !value.is_empty()) {
        keystore::store(
            &mut *transaction,
            keystore_state,
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
    keystore_state: &KeystoreState,
    id: &str,
    mut input: IdentityInput,
) -> Result<Identity> {
    validate(&input)?;
    let current = get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown identity".into()))?;
    // An identity stays in the vault it was created in; moving between vaults
    // means re-encrypting under another key and is a separate operation.
    input.vault_id = current.vault_id.clone();
    check_key(pool, &input.vault_id, &input.key_id).await?;
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
            sqlx::query("DELETE FROM keystore_secrets WHERE owner_type='identity' AND owner_id=?1 AND secret_type=?2")
                .bind(id)
                .bind(PASSWORD_SECRET_TYPE)
                .execute(&mut *transaction)
                .await?;
        } else {
            keystore::store(
                &mut *transaction,
                keystore_state,
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
    sqlx::query(
        "INSERT INTO tombstones (vault_id, object_type, object_id, deleted_at) \
         VALUES (?2, 'identity', ?1, unixepoch()) \
         ON CONFLICT(vault_id, object_type, object_id) DO UPDATE SET deleted_at = unixepoch()",
    )
    .bind(id)
    .bind(&vault_id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

/* Mobile keeps every identity password in the keystore — the OS keyring the
 * desktop store uses for personal identities is not available here. These tests
 * run on desktop too (see storage::identities_mobile in mod.rs), because CI
 * never builds a mobile target. */
#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::key_references::{self, KeyReferenceInput};
    use crate::storage::vaults::{self, VaultInput};

    fn input(name: &str, password: Option<&str>) -> IdentityInput {
        IdentityInput {
            vault_id: vaults::default_id(),
            name: name.into(),
            username: "alice".into(),
            key_id: None,
            password: password.map(str::to_owned),
        }
    }

    async fn unlocked_keystore(pool: &SqlitePool) -> KeystoreState {
        let state = KeystoreState::default();
        keystore::setup(pool, &state, "master password", false)
            .await
            .unwrap();
        state
    }

    async fn shared_vault(pool: &SqlitePool) -> String {
        vaults::create(
            pool,
            VaultInput {
                name: "Infra".into(),
                share_secrets: true,
                sort_order: 0,
            },
        )
        .await
        .unwrap()
        .id
    }

    async fn key_in_vault(pool: &SqlitePool, vault_id: &str, name: &str) -> String {
        key_references::create_metadata(
            pool,
            KeyReferenceInput {
                vault_id: vault_id.to_string(),
                name: name.into(),
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
        .unwrap()
        .id
    }

    #[tokio::test]
    async fn passwords_round_trip_through_the_keystore_and_clear_on_empty() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = unlocked_keystore(&pool).await;

        let created = create(&pool, &keystore_state, input("Deploy", Some("s3cret")))
            .await
            .unwrap();
        assert!(created.has_password);
        assert_eq!(
            password(&pool, &keystore_state, &created.id)
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("s3cret")
        );

        // None preserves the stored password, so only the name changes here.
        let renamed = update(
            &pool,
            &keystore_state,
            &created.id,
            input("Deploy renamed", None),
        )
        .await
        .unwrap();
        assert!(renamed.has_password);
        assert_eq!(renamed.name, "Deploy renamed");
        assert_eq!(
            password(&pool, &keystore_state, &created.id)
                .await
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("s3cret")
        );

        let cleared = update(
            &pool,
            &keystore_state,
            &created.id,
            input("Deploy renamed", Some("")),
        )
        .await
        .unwrap();
        assert!(!cleared.has_password);
        assert!(password(&pool, &keystore_state, &created.id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn an_identity_cannot_reference_a_key_in_another_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = unlocked_keystore(&pool).await;
        let personal_key = key_in_vault(&pool, &vaults::default_id(), "Personal key").await;
        let vault = shared_vault(&pool).await;

        let mut shared = input("Shared", None);
        shared.vault_id = vault.clone();
        shared.key_id = Some(personal_key.clone());
        let error = create(&pool, &keystore_state, shared).await.unwrap_err();
        assert_eq!(error.category(), "invalid-input");
        assert!(list(&pool, Some(&vault)).await.unwrap().is_empty());

        // The same guard applies on update: an identity already in the shared
        // vault may not be repointed at the personal vault's key.
        let mut ok = input("Shared", None);
        ok.vault_id = vault.clone();
        ok.key_id = Some(key_in_vault(&pool, &vault, "Shared key").await);
        let created = create(&pool, &keystore_state, ok).await.unwrap();

        let mut leaked = input("Shared", None);
        leaked.vault_id = vault.clone();
        leaked.key_id = Some(personal_key);
        let error = update(&pool, &keystore_state, &created.id, leaked)
            .await
            .unwrap_err();
        assert_eq!(error.category(), "invalid-input");
    }

    #[tokio::test]
    async fn an_identity_stays_in_its_vault_and_lists_scope_by_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = unlocked_keystore(&pool).await;
        let vault = shared_vault(&pool).await;

        let mut shared = input("Shared", None);
        shared.vault_id = vault.clone();
        let created = create(&pool, &keystore_state, shared).await.unwrap();
        create(&pool, &keystore_state, input("Personal", None))
            .await
            .unwrap();

        let mut escape = input("Shared", None);
        escape.vault_id = vaults::default_id();
        let updated = update(&pool, &keystore_state, &created.id, escape)
            .await
            .unwrap();
        assert_eq!(updated.vault_id, vault);

        assert_eq!(list(&pool, Some(&vault)).await.unwrap().len(), 1);
        assert_eq!(
            list(&pool, Some(&vaults::default_id()))
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(list(&pool, None).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn delete_removes_the_password_and_tombstones_in_the_owning_vault() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = unlocked_keystore(&pool).await;
        let vault = shared_vault(&pool).await;

        let mut shared = input("Shared", Some("team secret"));
        shared.vault_id = vault.clone();
        let created = create(&pool, &keystore_state, shared).await.unwrap();

        delete(&pool, &created.id).await.unwrap();

        assert!(get(&pool, &created.id).await.unwrap().is_none());
        assert!(password(&pool, &keystore_state, &created.id)
            .await
            .unwrap()
            .is_none());
        let tombstone_vault: Option<String> = sqlx::query_scalar(
            "SELECT vault_id FROM tombstones WHERE object_type='identity' AND object_id=?1",
        )
        .bind(&created.id)
        .fetch_optional(&pool)
        .await
        .unwrap();
        assert_eq!(tombstone_vault.as_deref(), Some(vault.as_str()));

        assert_eq!(
            delete(&pool, &created.id).await.unwrap_err().category(),
            "invalid-input"
        );
    }

    #[tokio::test]
    async fn rejects_invalid_names_usernames_and_unknown_vaults() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let keystore_state = unlocked_keystore(&pool).await;

        let with_username = |name: &str, username: &str| {
            let mut candidate = input(name, None);
            candidate.username = username.into();
            candidate
        };
        for invalid in [
            input("", None),
            with_username("Blank user", ""),
            with_username("Spaced user", "has space"),
            with_username("Dashed user", "-alice"),
        ] {
            let error = create(&pool, &keystore_state, invalid).await.unwrap_err();
            assert_eq!(error.category(), "invalid-input");
        }

        let mut unknown_vault = input("Orphan", None);
        unknown_vault.vault_id = "no-such-vault".into();
        let error = create(&pool, &keystore_state, unknown_vault)
            .await
            .unwrap_err();
        assert_eq!(error.category(), "invalid-input");

        assert!(list(&pool, None).await.unwrap().is_empty());
    }
}
