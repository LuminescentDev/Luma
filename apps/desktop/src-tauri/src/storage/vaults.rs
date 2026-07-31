//! Vaults: named scopes that own hosts, groups, key references, identities and
//! snippets. Each vault syncs to its own remote under its own key, so a vault
//! is the unit that is shared with other people.
//!
//! Vault ids are device-local. Two devices syncing the same remote each keep
//! their own id for it; the remote location is what makes them the same vault.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{LumaError, Result};

/// The vault every pre-existing row was migrated into, and the only one that
/// syncs settings and terminal profiles.
pub const PERSONAL_VAULT_ID: &str = "personal";

const MAX_NAME_LENGTH: usize = 128;

/// Serde default for every `*Input.vault_id`, so a payload from an older client
/// (or a test fixture) still lands in the personal vault.
pub(crate) fn default_id() -> String {
    PERSONAL_VAULT_ID.to_string()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub kind: String,
    /// Whether private keys and passwords are included in this vault's bundle.
    /// Turning this on hands those secrets to every member, permanently.
    pub share_secrets: bool,
    pub sort_order: i32,
    /// Server-side identity, set only for `managed` vaults. The local `id` is
    /// per-device; this is what every member's device agrees on.
    pub remote_vault_id: Option<String>,
    /// Which generation of the content key the local cache holds. Bumped by the
    /// server when a member is removed.
    pub key_epoch: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInput {
    pub name: String,
    #[serde(default)]
    pub share_secrets: bool,
    #[serde(default)]
    pub sort_order: i32,
}

fn row_to_vault(row: &sqlx::sqlite::SqliteRow) -> Vault {
    let remote_vault_id: Option<String> = row.get("remote_vault_id");
    let stored_kind: String = row.get("kind");
    Vault {
        id: row.get("id"),
        // A managed vault is stored as 'shared' — the two differ only in how the
        // key is obtained, and holding a server-side vault is what distinguishes
        // them. Callers get the narrower kind so they do not have to know that.
        kind: match remote_vault_id {
            Some(_) => MANAGED_KIND.to_string(),
            None => stored_kind,
        },
        name: row.get("name"),
        share_secrets: row.get::<i64, _>("share_secrets") != 0,
        sort_order: row.get("sort_order"),
        remote_vault_id: row.get("remote_vault_id"),
        key_epoch: row.get::<i64, _>("key_epoch") as u32,
    }
}

/// Managed vaults get their content key from Luma Cloud rather than a
/// passphrase, so they are the one kind that cannot live on another provider.
/// Reported by [`row_to_vault`]; never stored in the `kind` column.
pub const MANAGED_KIND: &str = "managed";

fn validate_name(name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH || name.contains('\0') {
        return Err(LumaError::InvalidInput(format!(
            "vault name must be 1-{MAX_NAME_LENGTH} characters"
        )));
    }
    Ok(())
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Vault>> {
    let rows = sqlx::query(
        "SELECT id, name, kind, share_secrets, sort_order, remote_vault_id, key_epoch
         FROM vaults ORDER BY kind = 'personal' DESC, sort_order, name COLLATE NOCASE",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_vault).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Vault>> {
    let row = sqlx::query(
        "SELECT id, name, kind, share_secrets, sort_order, remote_vault_id, key_epoch
             FROM vaults WHERE id = ?1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(row_to_vault))
}

/// Reject an entity write whose target vault does not exist. Callers pass the
/// vault straight through from the frontend, so this is a boundary check.
pub(crate) async fn require<'e, E>(executor: E, id: &str) -> Result<()>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    if sqlx::query_scalar::<_, i64>("SELECT 1 FROM vaults WHERE id = ?1")
        .bind(id)
        .fetch_optional(executor)
        .await?
        .is_none()
    {
        return Err(LumaError::InvalidInput("unknown vault".into()));
    }
    Ok(())
}

pub async fn create(pool: &SqlitePool, input: VaultInput) -> Result<Vault> {
    validate_name(&input.name)?;
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO vaults (id, name, kind, share_secrets, sort_order)
         VALUES (?1, ?2, 'shared', ?3, ?4)",
    )
    .bind(&id)
    .bind(input.name.trim())
    .bind(input.share_secrets)
    .bind(input.sort_order)
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("vault creation failed".into()))
}

/// Record a vault whose content key Luma Cloud distributes. `remote_vault_id`
/// is the server's id for it, so joining the same vault on a second device
/// creates a second local row pointing at the same remote.
pub async fn create_managed(
    pool: &SqlitePool,
    name: &str,
    remote_vault_id: &str,
    key_epoch: u32,
    share_secrets: bool,
) -> Result<Vault> {
    validate_name(name)?;
    if remote_vault_id.is_empty() || remote_vault_id.len() > 128 {
        return Err(LumaError::InvalidInput(
            "managed vault identifier is invalid".into(),
        ));
    }
    if let Some(existing) = by_remote_id(pool, remote_vault_id).await? {
        return Err(LumaError::InvalidInput(format!(
            "this vault is already set up locally as \"{}\"",
            existing.name
        )));
    }

    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO vaults (id, name, kind, share_secrets, remote_vault_id, key_epoch)
         VALUES (?1, ?2, 'shared', ?3, ?4, ?5)",
    )
    .bind(&id)
    .bind(name.trim())
    .bind(share_secrets)
    .bind(remote_vault_id)
    .bind(i64::from(key_epoch))
    .execute(pool)
    .await?;

    get(pool, &id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("vault creation failed".into()))
}

pub async fn by_remote_id(pool: &SqlitePool, remote_vault_id: &str) -> Result<Option<Vault>> {
    let row = sqlx::query(
        "SELECT id, name, kind, share_secrets, sort_order, remote_vault_id, key_epoch
         FROM vaults WHERE remote_vault_id = ?1",
    )
    .bind(remote_vault_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.as_ref().map(row_to_vault))
}

pub async fn set_key_epoch(pool: &SqlitePool, id: &str, key_epoch: u32) -> Result<()> {
    sqlx::query("UPDATE vaults SET key_epoch = ?2, updated_at = unixepoch() WHERE id = ?1")
        .bind(id)
        .bind(i64::from(key_epoch))
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn update(pool: &SqlitePool, id: &str, input: VaultInput) -> Result<Vault> {
    validate_name(&input.name)?;
    let result = sqlx::query(
        "UPDATE vaults SET name = ?2, share_secrets = ?3, sort_order = ?4,
             updated_at = unixepoch()
         WHERE id = ?1",
    )
    .bind(id)
    .bind(input.name.trim())
    .bind(input.share_secrets)
    .bind(input.sort_order)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(LumaError::InvalidInput("unknown vault".into()));
    }

    get(pool, id)
        .await?
        .ok_or_else(|| LumaError::InvalidInput("unknown vault".into()))
}

/// Remove a vault and everything scoped to it, including the secrets its keys
/// and identities own. The personal vault cannot be removed: it is where
/// settings, terminal profiles and every un-scoped entity live.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<()> {
    if id == PERSONAL_VAULT_ID {
        return Err(LumaError::InvalidInput(
            "the personal vault cannot be deleted".into(),
        ));
    }
    if get(pool, id).await?.is_none() {
        return Err(LumaError::InvalidInput("unknown vault".into()));
    }

    let key_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM key_references WHERE vault_id=?1")
            .bind(id)
            .fetch_all(pool)
            .await?;
    let identity_ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM identities WHERE vault_id=?1")
            .bind(id)
            .fetch_all(pool)
            .await?;

    let mut transaction = pool.begin().await?;
    for table in [
        "snippets",
        "hosts",
        "identities",
        "key_references",
        "host_groups",
        "tombstones",
        "sync_state",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE vault_id = ?1"))
            .bind(id)
            .execute(&mut *transaction)
            .await?;
    }
    for key_id in &key_ids {
        crate::keystore::delete(&mut *transaction, "key", key_id).await?;
    }
    for identity_id in &identity_ids {
        crate::keystore::delete(&mut *transaction, "identity", identity_id).await?;
    }
    sqlx::query("DELETE FROM vaults WHERE id = ?1")
        .bind(id)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;

    for key_id in &key_ids {
        crate::storage::key_references::purge_secrets(key_id);
    }
    for identity_id in &identity_ids {
        crate::storage::identities::purge_synced_password(identity_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::hosts::{self, HostInput};

    fn host_input(name: &str, vault_id: &str) -> HostInput {
        HostInput {
            vault_id: vault_id.into(),
            name: name.into(),
            hostname: "server.example.com".into(),
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
        }
    }

    #[tokio::test]
    async fn personal_vault_exists_and_cannot_be_deleted() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let vaults = list(&pool).await.unwrap();
        assert_eq!(vaults.len(), 1);
        assert_eq!(vaults[0].id, PERSONAL_VAULT_ID);
        assert_eq!(vaults[0].kind, "personal");
        assert!(!vaults[0].share_secrets);

        let error = delete(&pool, PERSONAL_VAULT_ID).await.unwrap_err();
        assert_eq!(error.category(), "invalid-input");
    }

    #[tokio::test]
    async fn deleting_a_vault_removes_only_its_own_entities_and_tombstones() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        let shared = create(
            &pool,
            VaultInput {
                name: "Infra".into(),
                share_secrets: true,
                sort_order: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(shared.kind, "shared");
        assert!(shared.share_secrets);

        let personal_host = hosts::create(&pool, host_input("Personal", PERSONAL_VAULT_ID))
            .await
            .unwrap();
        let shared_host = hosts::create(&pool, host_input("Shared", &shared.id))
            .await
            .unwrap();
        let doomed = hosts::create(&pool, host_input("Doomed", &shared.id))
            .await
            .unwrap();
        hosts::delete(&pool, &doomed.id).await.unwrap();
        hosts::delete(&pool, &personal_host.id).await.unwrap();

        delete(&pool, &shared.id).await.unwrap();

        assert!(hosts::get(&pool, &shared_host.id).await.unwrap().is_none());
        assert!(get(&pool, &shared.id).await.unwrap().is_none());
        let remaining: Vec<String> =
            sqlx::query_scalar("SELECT vault_id FROM tombstones ORDER BY object_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining, vec![PERSONAL_VAULT_ID.to_string()]);
    }

    #[tokio::test]
    async fn rejects_unknown_vaults_and_blank_names() {
        let pool = crate::storage::init_in_memory().await.unwrap();
        assert!(create(
            &pool,
            VaultInput {
                name: "  ".into(),
                share_secrets: false,
                sort_order: 0,
            }
        )
        .await
        .is_err());
        assert!(delete(&pool, "missing").await.is_err());
        assert!(hosts::create(&pool, host_input("Orphan", "missing"))
            .await
            .is_err());
    }
}
