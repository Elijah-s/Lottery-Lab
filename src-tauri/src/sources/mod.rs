//! Lottery data sources (official + backups).
//!
//! Each data source implements the `DrawSource` trait and returns
//! normalized `DrawRecord`s. Sources are attempted in order; the first
//! one that succeeds wins, and degraded markers get bubbled up via the
//! sync summary so the UI can surface them.

use async_trait::async_trait;

use crate::errors::AppResult;

pub mod dlt_official;
pub mod ssq_official;
pub mod text_backup;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DrawRecord {
    pub lottery_type: String,
    pub issue: String,
    pub draw_date: String,
    /// JSON-serialized number layout. SSQ: `{"red":[…],"blue":[…]}`.
    /// DLT: `{"front":[…],"back":[…]}`.
    pub numbers: serde_json::Value,
    pub source_name: String,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SourceAttempt {
    pub source_name: String,
    pub source_url: Option<String>,
    pub status: String,
    pub fetched_count: usize,
    pub valid_count: usize,
    pub invalid_count: usize,
    pub error: Option<String>,
}

#[async_trait]
pub trait DrawSource: Send + Sync {
    fn name(&self) -> &'static str;
    fn url_hint(&self) -> Option<&'static str> {
        None
    }
    async fn fetch(&self, limit: usize) -> AppResult<Vec<DrawRecord>>;
}
