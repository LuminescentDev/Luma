pub mod command_history;
pub mod host_groups;
pub mod host_inheritance;
pub mod hosts;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod identities;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "identities_mobile.rs"]
pub mod identities;
/// The mobile identity store is cfg'd out of desktop builds, and CI only builds
/// desktop targets — so its tests would never run. Compile it a second time
/// under its own name in desktop test builds to keep that coverage honest.
#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
#[path = "identities_mobile.rs"]
pub mod identities_mobile;
pub mod key_references;
pub mod port_forwards;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub mod profiles;
pub mod settings;
pub mod snippets;
pub mod vaults;
pub mod voice_history;

use std::fmt::Write as _;
use std::path::Path;

use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::errors::Result;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// SHA-384 checksums produced by SQLx for the exact shipped migration SQL
/// after converting LF line endings to CRLF. These immutable values are the
/// only historical checksum drift we repair; adding a migration requires
/// computing its CRLF checksum deliberately rather than trusting arbitrary
/// database contents or deriving an allowlist from mutable runtime state.
const LEGACY_CRLF_CHECKSUMS: &[(i64, &str)] = &[
    (1, "6ba5d88c3457040cd32ec15e45dfc4fe6fe83f76e57c125a968007b4f95d7d045dba3604811837d2f6c4267b571391e5"),
    (2, "870f9769c16fef0d0c538cb253e71f9942b87f9b1dcbf516c44a0febbf1ec6a531e9dec83a82d356c54d0385ff294c4a"),
    (3, "66fe6cbc69359cab41ff09f78d878a78314c7a97b501d766d8bf87fd20b61dcccad791c86c3c1615f72a46a3ad3ea09a"),
    (4, "07c73bf34fc33acbab8d07eec04e6a30e8b1481545e43433bb19921152fba8ce1d845589721df22b7f0d38947ed46ee5"),
    (5, "65b6914b2c1b32329a9890b8ced9c2046ee44ccca591cbd5e89dc8d6afd6b53d1791f3a65a07aa9c7a7b87979db6aefc"),
    (6, "5b50fa27cebd514a643a450b84a5f6f1cdf74bec127f4bf9e69baa7f3668295d6658c44d37a45de0d951bdb21c0e574f"),
    (7, "2144eb77cca3d25192d5b0d733320858908b51fdb041f69147c8ee3b95fd584c5e06a946b0e90eb3e2d01adb42fc16c9"),
    (8, "1b2f8ea83bcc53f5de983bcd0e5d76a5fe3ffab48c9a2622df9c161af9c1f94d731bc92056ac7f99af7f9967a24e4c7a"),
    (9, "eb25da2bc4b4cd74450ce4a0c14b23b72ffaf90f2ed06dfaa17ff86c04f4a49a08c13470d7a3bfce11981052ffdbc507"),
    (10, "048870f9eac80f8100896b0ef3fb263b0b11ff5cf263d4ebd2c64e1683275d23d56e70991ddab198b2bf6591bf08cb57"),
    (11, "8cf0be92da2994058716c209c4955f84cce0d2efa7d4a7919aa5c1d0cc1747c6cfb1c95dd05409339706847f6e2af870"),
    (12, "c3e520af5217bd569e56dddf46145d0f9c88182d2cc7f21dcba98b94bb09438cd5f64df08cb363eaedf1c86315cb19aa"),
    (13, "9c8b937fcc6ebf80e336a818127d65208defdd6ae41ff23996196183000516b67886ee7a4076eb06b500df564e9bfbb9"),
    (14, "40281f5190bdde6249d0e4a10210326a2ed6f5e3d80de06f18428791ac5bc36fb501370eaf5ce06b0f8c9d4561a7d5d8"),
    (15, "823105168192ac5374f1acd10901a878a19b65b37b06af20b6be7bcc26bcc3422ce9114407666adffc5dd9e303198e86"),
    (16, "3dbb170efdee4d8ef6b0f082afa2b91e37871ca1d4abc2c1414ac4ff823be66c67aadc4428f96107b37a92f24ae18c6b"),
    (17, "4cd77c6b15dc828c48b3fe025e428c0e5fffe6a918748f9ad74267b69439591a05fdb0eb312c349379381592a96cf789"),
    (18, "d820264a06f025a1c64ae6d5e68218540d50ae0324d007183d310bcb79cd21df4e6fa8cc18270dfedd923fd97ad33e02"),
    (19, "7818f963c2f18cbc28fd821a466b0cb9cb7de8a96ee874951cd3820d8c6c78cbe1f48eae49b674733bc20f245f116439"),
];

fn is_allowlisted_legacy_checksum(version: i64, recorded: &[u8]) -> bool {
    let Some((_, expected)) = LEGACY_CRLF_CHECKSUMS
        .iter()
        .find(|(legacy_version, _)| *legacy_version == version)
    else {
        return false;
    };
    let mut actual = String::with_capacity(recorded.len() * 2);
    for byte in recorded {
        write!(&mut actual, "{byte:02x}").expect("writing to a String cannot fail");
    }
    actual == *expected
}

/// Open (creating if necessary) the application database and run pending
/// migrations.
pub async fn init(db_path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await?;

    run_migrations_with_recovery(&pool, db_path).await?;
    tracing::info!("database ready at {}", db_path.display());

    Ok(pool)
}

/// Recover migration checksum drift without discarding the user's database.
///
/// SQLx hashes the raw migration bytes, so an old Windows build that embedded
/// CRLF migrations can disagree with a release build that embedded the same
/// SQL with LF line endings. The schema is already applied in that case; only
/// the bookkeeping checksum differs. Preserve a consistent database snapshot,
/// reconcile that one checksum with the trusted migrations embedded in this
/// binary, then let SQLx validate everything and apply pending migrations.
async fn run_migrations_with_recovery(
    pool: &SqlitePool,
    db_path: &Path,
) -> std::result::Result<(), sqlx::migrate::MigrateError> {
    let mut backup_path = None;

    loop {
        let version = match MIGRATOR.run(pool).await {
            Ok(()) => return Ok(()),
            Err(sqlx::migrate::MigrateError::VersionMismatch(version)) => version,
            Err(error) => return Err(error),
        };

        let Some(migration) = MIGRATOR
            .iter()
            .find(|migration| migration.version == version)
        else {
            return Err(sqlx::migrate::MigrateError::VersionMissing(version));
        };

        let recorded: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT checksum FROM _sqlx_migrations WHERE version = ? AND success = 1",
        )
        .bind(version)
        .fetch_optional(pool)
        .await
        .map_err(sqlx::migrate::MigrateError::Execute)?;
        let Some(recorded) = recorded else {
            return Err(sqlx::migrate::MigrateError::VersionMissing(version));
        };
        if !is_allowlisted_legacy_checksum(version, &recorded) {
            return Err(sqlx::migrate::MigrateError::VersionMismatch(version));
        }

        let backup = match &backup_path {
            Some(path) => path,
            None => {
                let path = migration_backup_path(db_path);
                // SQLite accepts forward slashes on every supported platform.
                // This also avoids treating Windows backslashes as filename
                // characters in the SQL string.
                let escaped_path = path
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace('\'', "''");
                sqlx::query(&format!("VACUUM INTO '{escaped_path}'"))
                    .execute(pool)
                    .await
                    .map_err(sqlx::migrate::MigrateError::Execute)?;
                backup_path.insert(path)
            }
        };

        let result = sqlx::query(
            "UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND success = 1 AND checksum = ?",
        )
        .bind(migration.checksum.as_ref())
        .bind(version)
        .bind(&recorded)
        .execute(pool)
        .await
        .map_err(sqlx::migrate::MigrateError::Execute)?;

        if result.rows_affected() != 1 {
            return Err(sqlx::migrate::MigrateError::VersionMissing(version));
        }

        tracing::warn!(
            migration_version = version,
            backup = %backup.display(),
            "recovered migration checksum drift"
        );
    }
}

fn migration_backup_path(db_path: &Path) -> std::path::PathBuf {
    let timestamp = Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let file_name = db_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("luma.db");
    db_path.with_file_name(format!("{file_name}.migration-backup-{timestamp}"))
}

/// In-memory database for tests.
#[cfg(test)]
pub async fn init_in_memory() -> Result<SqlitePool> {
    use std::str::FromStr;
    // Foreign keys are on in the real database, so they are on here too: a
    // migration that trips enforcement (rebuilding a table other tables
    // reference, say) has to fail in tests rather than only on a user's disk.
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await?;
    MIGRATOR.run(&pool).await?;
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha384};

    fn temporary_database_path(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let test_dir =
            std::env::temp_dir().join(format!("luma-migration-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let db_path = test_dir.join("luma.db");
        (test_dir, db_path)
    }

    fn backup_paths(test_dir: &Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(test_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.to_string_lossy().contains(".migration-backup-"))
            .collect()
    }

    #[test]
    fn legacy_allowlist_matches_sqlx_sha384_of_shipped_crlf_migrations() {
        for migration in MIGRATOR.iter() {
            let lf = migration.sql.replace("\r\n", "\n").replace('\r', "\n");
            let crlf = lf.replace('\n', "\r\n");
            let checksum = Sha384::digest(crlf.as_bytes());
            assert!(
                is_allowlisted_legacy_checksum(migration.version, &checksum),
                "missing or incorrect CRLF checksum for migration {}",
                migration.version
            );
        }
    }

    #[tokio::test]
    async fn migration_0011_coerces_agent_auth_to_interactive() {
        // 0011 is idempotent, so seeding legacy rows (still permitted by the
        // 0001 CHECK constraints) and re-running the shipped SQL exercises the
        // exact statements an upgraded database runs.
        let pool = init_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO key_references (id, name, storage_mode) VALUES
             ('agent-key', 'Agent key', 'ssh-agent'),
             ('disk-key', 'Disk key', 'local-path')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO hosts (id, name, hostname, auth_type, key_id) VALUES
             ('h-agent', 'Agent host', 'a.example.com', 'agent', NULL),
             ('h-agent-key', 'Keyed host', 'b.example.com', 'key', 'agent-key'),
             ('h-disk-key', 'Disk host', 'c.example.com', 'key', 'disk-key')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == 11)
            .unwrap();
        let mut connection = pool.acquire().await.unwrap();
        sqlx::raw_sql(&migration.sql)
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);

        let rows: Vec<(String, String, Option<String>)> =
            sqlx::query_as("SELECT id, auth_type, key_id FROM hosts ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            rows,
            vec![
                ("h-agent".into(), "interactive".into(), None),
                ("h-agent-key".into(), "interactive".into(), None),
                ("h-disk-key".into(), "key".into(), Some("disk-key".into())),
            ]
        );

        let remaining_keys: Vec<String> =
            sqlx::query_scalar("SELECT id FROM key_references ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(remaining_keys, vec!["disk-key".to_string()]);

        let tombstoned: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM tombstones
             WHERE object_type = 'key_reference' AND object_id = 'agent-key'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(tombstoned, 1);
    }

    /// Apply every shipped migration strictly below `version` to a fresh
    /// in-memory database, reproducing the schema an upgrading install has just
    /// before that migration runs.
    async fn pool_at_migration(version: i64) -> SqlitePool {
        use std::str::FromStr;
        // Matches the real database: a migration that trips foreign key
        // enforcement has to fail here rather than on a user's disk.
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        for migration in MIGRATOR.iter().filter(|m| m.version < version) {
            apply_migration(&pool, migration.version).await;
        }
        pool
    }

    /// SQLx wraps every migration in a transaction, and SQLite only accepts
    /// `ALTER TABLE ... ADD COLUMN ... REFERENCES` with a non-NULL default
    /// inside one. Applying migration SQL any other way would test something
    /// the app never does.
    async fn apply_migration(pool: &SqlitePool, version: i64) {
        let migration = MIGRATOR
            .iter()
            .find(|migration| migration.version == version)
            .unwrap();
        let mut transaction = pool.begin().await.unwrap();
        sqlx::raw_sql(&migration.sql)
            .execute(&mut *transaction)
            .await
            .unwrap();
        transaction.commit().await.unwrap();
    }

    #[tokio::test]
    async fn migration_0012_renames_vault_tables_and_preserves_secrets() {
        let pool = pool_at_migration(12).await;
        sqlx::query(
            "INSERT INTO vault_config (id, salt, verifier_nonce, verifier_ciphertext, remember_on_device)
             VALUES (1, X'00', X'01', X'02', 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO vault_secrets (owner_type, owner_id, secret_type, nonce, ciphertext)
             VALUES ('key', 'k1', 'private-key', X'03', X'04')",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migration(&pool, 12).await;

        let remembered: i64 =
            sqlx::query_scalar("SELECT remember_on_device FROM keystore_config WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(remembered, 1);

        let secret: (Vec<u8>, Vec<u8>) = sqlx::query_as(
            "SELECT nonce, ciphertext FROM keystore_secrets
             WHERE owner_type = 'key' AND owner_id = 'k1' AND secret_type = 'private-key'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(secret, (vec![0x03], vec![0x04]));

        let leftovers: Vec<String> = sqlx::query_scalar(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name IN ('vault_config', 'vault_secrets', 'vault_metadata')",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert!(
            leftovers.is_empty(),
            "stale vault tables remain: {leftovers:?}"
        );
    }

    #[tokio::test]
    async fn migration_0013_backfills_the_personal_vault_and_rebuilds_tombstones() {
        let pool = pool_at_migration(13).await;
        sqlx::query(
            "INSERT INTO host_groups (id, name) VALUES ('g1', 'Group');
             INSERT INTO key_references (id, name) VALUES ('k1', 'Key');
             INSERT INTO identities (id, name, username) VALUES ('i1', 'Identity', 'root');
             INSERT INTO hosts (id, name, hostname, group_id, auth_type, key_id, identity_id)
             VALUES ('h1', 'Host', 'a.example.com', 'g1', 'key', 'k1', 'i1');
             INSERT INTO snippets (id, name, command, host_id) VALUES ('s1', 'Snip', 'ls', 'h1');
             INSERT INTO tombstones (object_type, object_id, deleted_at)
             VALUES ('host', 'gone', 1700000000)",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migration(&pool, 13).await;

        for table in [
            "hosts",
            "host_groups",
            "key_references",
            "identities",
            "snippets",
        ] {
            let vaults: Vec<String> = sqlx::query_scalar(&format!("SELECT vault_id FROM {table}"))
                .fetch_all(&pool)
                .await
                .unwrap();
            assert_eq!(
                vaults,
                vec!["personal".to_string()],
                "{table} was not backfilled"
            );
        }

        let tombstone: (String, String, String, i64) =
            sqlx::query_as("SELECT vault_id, object_type, object_id, deleted_at FROM tombstones")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            tombstone,
            (
                "personal".into(),
                "host".into(),
                "gone".into(),
                1_700_000_000
            )
        );

        let vault: (String, String, i64) =
            sqlx::query_as("SELECT id, kind, share_secrets FROM vaults")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(vault, ("personal".into(), "personal".into(), 0));
    }

    #[tokio::test]
    async fn migration_0014_moves_existing_sync_configuration_to_the_personal_vault() {
        let pool = pool_at_migration(14).await;
        sqlx::query(
            "INSERT INTO sync_state (id, device_id, provider, last_synced_at, state)
             VALUES (1, 'device-1', 'local-folder', 1700000000, '{\"folderPath\":\"/tmp/luma\"}');
             INSERT INTO settings (key, value) VALUES ('sync.includePrivateKeys', 'true')",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migration(&pool, 14).await;

        let migrated: (String, String, i64, String) =
            sqlx::query_as("SELECT vault_id, provider, last_synced_at, state FROM sync_state")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            migrated,
            (
                "personal".into(),
                "local-folder".into(),
                1_700_000_000,
                "{\"folderPath\":\"/tmp/luma\"}".into()
            )
        );

        let carried: String = sqlx::query_scalar("SELECT device_id FROM device_state WHERE id = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(carried, "device-1");

        let share_secrets: i64 =
            sqlx::query_scalar("SELECT share_secrets FROM vaults WHERE id = 'personal'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            share_secrets, 1,
            "the global key opt-in was not carried over"
        );
    }

    /// A fresh database has no `sync_state` row, so this is the shape that
    /// matters: an install with a configured remote, where `sync_state.vault_id`
    /// references `vaults(id)`. Rebuilding `vaults` here trips foreign key
    /// enforcement, which is why 0015 only adds columns.
    #[tokio::test]
    async fn migration_0015_preserves_a_configured_remote_and_its_vaults() {
        let pool = pool_at_migration(15).await;
        sqlx::query(
            "INSERT INTO vaults (id, name, kind, share_secrets) VALUES ('v-shared', 'Infra', 'shared', 1);
             INSERT INTO sync_state (vault_id, provider, last_synced_at, state)
             VALUES ('personal', 'local-folder', 1700000000, '{\"folderPath\":\"/tmp/luma\"}'),
                    ('v-shared', 'webdav', 1700000001, '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        apply_migration(&pool, 15).await;

        let vaults: Vec<(String, String, Option<String>, i64)> =
            sqlx::query_as("SELECT id, kind, remote_vault_id, key_epoch FROM vaults ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            vaults,
            vec![
                ("personal".into(), "personal".into(), None, 1),
                ("v-shared".into(), "shared".into(), None, 1),
            ]
        );

        // The configured remotes still point at their vaults.
        let remotes: Vec<(String, String)> =
            sqlx::query_as("SELECT vault_id, provider FROM sync_state ORDER BY vault_id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            remotes,
            vec![
                ("personal".into(), "local-folder".into()),
                ("v-shared".into(), "webdav".into()),
            ]
        );

        let violations: Vec<(String,)> = sqlx::query_as("PRAGMA foreign_key_check")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(violations.is_empty(), "{violations:?}");
    }

    /// Two local rows may not claim the same server-side vault: that would give
    /// one remote two divergent local copies.
    #[tokio::test]
    async fn migration_0015_rejects_a_duplicate_remote_vault_id() {
        let pool = init_in_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO vaults (id, name, kind, remote_vault_id) VALUES ('a', 'A', 'shared', 'r1')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let error = sqlx::query(
            "INSERT INTO vaults (id, name, kind, remote_vault_id) VALUES ('b', 'B', 'shared', 'r1')",
        )
        .execute(&pool)
        .await
        .unwrap_err();
        assert!(error.to_string().contains("UNIQUE"), "{error}");
    }

    #[tokio::test]
    async fn migration_0014_leaves_share_secrets_off_without_the_global_opt_in() {
        let pool = pool_at_migration(14).await;

        apply_migration(&pool, 14).await;

        let share_secrets: i64 =
            sqlx::query_scalar("SELECT share_secrets FROM vaults WHERE id = 'personal'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(share_secrets, 0);
    }

    #[tokio::test]
    async fn repairs_allowlisted_crlf_checksum_without_losing_data() {
        let (test_dir, db_path) = temporary_database_path("crlf");
        let pool = init(&db_path).await.unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('test.value', '42')")
            .execute(&pool)
            .await
            .unwrap();
        let legacy = LEGACY_CRLF_CHECKSUMS
            .iter()
            .find(|(version, _)| *version == 1)
            .unwrap()
            .1;
        let legacy = (0..legacy.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&legacy[index..index + 2], 16).unwrap())
            .collect::<Vec<_>>();
        let current = MIGRATOR
            .iter()
            .find(|migration| migration.version == 1)
            .unwrap();
        assert_ne!(
            current.checksum.as_ref(),
            legacy.as_slice(),
            "migrations were checked out with CRLF endings, so this build embeds the legacy \
             checksums and cannot open databases written by a release build; re-normalize \
             apps/desktop/src-tauri/migrations/*.sql to LF as .gitattributes requires"
        );
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = 1")
            .bind(&legacy)
            .execute(&pool)
            .await
            .unwrap();

        assert!(matches!(
            MIGRATOR.run(&pool).await,
            Err(sqlx::migrate::MigrateError::VersionMismatch(1))
        ));
        run_migrations_with_recovery(&pool, &db_path).await.unwrap();

        let value: String =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'test.value'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(value, "42");
        assert_eq!(backup_paths(&test_dir).len(), 1);
        pool.close().await;
        let _ = std::fs::remove_dir_all(test_dir);
    }

    #[tokio::test]
    async fn rejects_unknown_migration_checksum_without_repair_or_backup() {
        let (test_dir, db_path) = temporary_database_path("tampered");
        let pool = init(&db_path).await.unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 1")
            .execute(&pool)
            .await
            .unwrap();

        pool.close().await;
        let error = init(&db_path).await.unwrap_err();
        assert!(matches!(
            error,
            crate::errors::LumaError::Migration(sqlx::migrate::MigrateError::VersionMismatch(1))
        ));
        assert!(backup_paths(&test_dir).is_empty());
        let _ = std::fs::remove_dir_all(test_dir);
    }
}
