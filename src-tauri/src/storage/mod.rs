pub mod host_groups;
pub mod hosts;
pub mod identities;
pub mod key_references;
pub mod port_forwards;
pub mod profiles;
pub mod settings;
pub mod snippets;

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
    let options = SqliteConnectOptions::from_str("sqlite::memory:")?;
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

    fn temporary_database_path(label: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let test_dir = std::env::temp_dir().join(format!(
            "luma-migration-{label}-{}",
            uuid::Uuid::new_v4()
        ));
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

        let error = run_migrations_with_recovery(&pool, &db_path)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            sqlx::migrate::MigrateError::VersionMismatch(1)
        ));
        let recorded: Vec<u8> =
            sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(recorded, vec![0]);
        assert!(backup_paths(&test_dir).is_empty());
        pool.close().await;
        let _ = std::fs::remove_dir_all(test_dir);
    }
}
