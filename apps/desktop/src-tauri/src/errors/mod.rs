use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

pub type Result<T> = std::result::Result<T, LumaError>;

/// Application error with a stable machine-readable category the frontend
/// can map to user-readable messages.
#[derive(Debug, thiserror::Error)]
pub enum LumaError {
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("terminal error: {0}")]
    Pty(String),

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[error("serial error: {0}")]
    Serial(String),

    #[error("{message}")]
    SshConnection {
        category: &'static str,
        message: String,
    },

    #[error("SFTP operation failed: {0}")]
    SftpFailed(String),

    #[error("private key unavailable: {0}")]
    KeyUnavailable(String),

    #[error("keystore locked: {0}")]
    KeystoreLocked(String),

    #[error("sync authentication failed: {0}")]
    SyncAuthFailed(String),

    #[error("sync conflict: {0}")]
    SyncConflict(String),

    #[error("sync unavailable: {0}")]
    SyncUnavailable(String),

    /// A vault's sync passphrase is not loaded. Distinct from `KeystoreLocked`:
    /// the device keystore may be perfectly unlocked and only this vault's
    /// passphrase missing.
    #[error("sync passphrase required: {0}")]
    SyncPassphraseRequired(String),
}

impl LumaError {
    pub fn category(&self) -> &'static str {
        match self {
            LumaError::Database(_) => "database",
            LumaError::Migration(_) => "migration",
            LumaError::Io(_) => "io",
            LumaError::InvalidInput(_) => "invalid-input",
            LumaError::Pty(_) => "pty",
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            LumaError::Serial(_) => "serial",
            LumaError::SshConnection { category, .. } => category,
            LumaError::SftpFailed(_) => "sftp-failed",
            LumaError::KeyUnavailable(_) => "key-unavailable",
            LumaError::KeystoreLocked(_) => "keystore-locked",
            LumaError::SyncAuthFailed(_) => "sync-auth-failed",
            LumaError::SyncConflict(_) => "sync-conflict",
            LumaError::SyncUnavailable(_) => "sync-unavailable",
            LumaError::SyncPassphraseRequired(_) => "sync-passphrase-required",
        }
    }
}

impl Serialize for LumaError {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("LumaError", 2)?;
        state.serialize_field("category", self.category())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}
