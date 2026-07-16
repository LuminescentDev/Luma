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
}

impl LumaError {
    pub fn category(&self) -> &'static str {
        match self {
            LumaError::Database(_) => "database",
            LumaError::Migration(_) => "migration",
            LumaError::Io(_) => "io",
            LumaError::InvalidInput(_) => "invalid-input",
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
