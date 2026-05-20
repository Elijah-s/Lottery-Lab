//! Shared error types for Lottery Lab business logic.
//!
//! We expose a single `AppError` enum that every command / service can
//! return. The `From<…>` bridges turn third-party errors into a stable
//! surface so callers don't have to match on library-specific errors
//! every time a dependency bumps. The `ToString` impl is what Tauri
//! serializes back to the front-end.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据源请求失败：{0}")]
    Http(String),

    #[error("数据源返回无效内容：{0}")]
    BadResponse(String),

    #[error("数据库错误：{0}")]
    Database(String),

    #[error("序列化失败：{0}")]
    Serde(String),

    #[error("配置无效：{0}")]
    Config(String),

    #[error("{0}")]
    Other(String),
}

impl From<reqwest::Error> for AppError {
    fn from(value: reqwest::Error) -> Self {
        AppError::Http(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Serde(value.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        AppError::Database(value.to_string())
    }
}

impl From<keyring::Error> for AppError {
    fn from(value: keyring::Error) -> Self {
        AppError::Config(format!("密钥存储失败：{value}"))
    }
}

impl From<anyhow::Error> for AppError {
    fn from(value: anyhow::Error) -> Self {
        AppError::Other(value.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

/// Serialize as a plain string for Tauri IPC.
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
