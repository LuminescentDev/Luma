pub mod settings;

use std::path::Path;

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

    MIGRATOR.run(&pool).await?;
    tracing::info!("database ready at {}", db_path.display());

    Ok(pool)
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
