pub mod host_groups;
pub mod hosts;
pub mod identities;
pub mod key_references;
pub mod port_forwards;
pub mod profiles;
pub mod settings;
pub mod snippets;

use std::path::Path;

use chrono::Utc;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use sqlx::SqlitePool;

use crate::errors::Result;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

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

    let backup_path = migration_backup_path(db_path);
    // SQLite accepts forward slashes on every supported platform. Using them
    // avoids treating Windows backslashes as part of the output filename.
    let escaped_backup = backup_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "''");
    sqlx::query(&format!("VACUUM INTO '{escaped_backup}'"))
        .execute(pool)
        .await
        .map_err(sqlx::migrate::MigrateError::Execute)?;

    let result =
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ? AND success = 1")
            .bind(migration.checksum.as_ref())
            .bind(version)
            .execute(pool)
            .await
            .map_err(sqlx::migrate::MigrateError::Execute)?;

    if result.rows_affected() != 1 {
        return Err(sqlx::migrate::MigrateError::VersionMissing(version));
    }

    tracing::warn!(
        migration_version = version,
        backup = %backup_path.display(),
        "recovered migration checksum drift"
    );

    MIGRATOR.run(pool).await
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

    #[tokio::test]
    async fn repairs_checksum_drift_without_losing_data() {
        let test_dir =
            std::env::temp_dir().join(format!("luma-migration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&test_dir).unwrap();
        let db_path = test_dir.join("luma.db");
        let pool = init(&db_path).await.unwrap();

        sqlx::query("INSERT INTO settings (key, value) VALUES ('test.value', '42')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE _sqlx_migrations SET checksum = X'00' WHERE version = 1")
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

        let backups: Vec<_> = std::fs::read_dir(&test_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.to_string_lossy().contains(".migration-backup-"))
            .collect();
        assert_eq!(backups.len(), 1, "backup paths: {backups:?}");
        pool.close().await;
        // SQLite may briefly retain a WAL handle on Windows after pool close.
        let _ = std::fs::remove_dir_all(test_dir);
    }
}
