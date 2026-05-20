//! AI / LLM settings persistence.
//!
//! Non-secret LLM settings live in SQLite. The API key is stored in
//! the macOS Keychain and only exposed to the UI as a boolean flag.

use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{AppError, AppResult};
use crate::llm::LlmConfig;
use crate::time_utils::now_beijing_iso;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4o-mini";
const KEYCHAIN_SERVICE: &str = "com.elijah.lottery-lab";
const KEYCHAIN_ACCOUNT: &str = "llm_api_key";
const LEGACY_API_KEY_SETTING: &str = "llm_api_key";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiSettings {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// Returned as a boolean flag so we don't leak the key to the UI.
    pub has_api_key: bool,
}

pub async fn load_settings(pool: &SqlitePool) -> AppResult<AiSettings> {
    migrate_legacy_api_key(pool).await?;
    let rows = sqlx::query("SELECT key, value FROM app_settings")
        .fetch_all(pool)
        .await?;
    let mut out = AiSettings::default();
    for row in rows {
        let key: String = row.try_get("key")?;
        let value: String = row.try_get("value")?;
        let unquoted = unquote_value(&value);
        match key.as_str() {
            "llm_provider" => out.provider = Some(unquoted),
            "llm_base_url" => out.base_url = Some(unquoted),
            "llm_model" => out.model = Some(unquoted),
            _ => {}
        }
    }
    out.has_api_key = read_api_key()?.is_some();
    Ok(out)
}

pub async fn save_settings(
    pool: &SqlitePool,
    update: AiSettingsInput,
) -> AppResult<AiSettings> {
    if let Some(api_key) = update.api_key.as_deref() {
        write_api_key(api_key)?;
    }

    let now = now_beijing_iso();
    let mut tx = pool.begin().await?;
    for (key, value) in update.to_rows() {
        sqlx::query(
            r#"
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            "#,
        )
        .bind(key)
        .bind(value)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    load_settings(pool).await
}

pub async fn resolve_llm_config(pool: &SqlitePool) -> AppResult<LlmConfig> {
    migrate_legacy_api_key(pool).await?;
    let mut cfg = LlmConfig {
        provider: "openai".to_string(),
        base_url: DEFAULT_BASE_URL.to_string(),
        model: DEFAULT_MODEL.to_string(),
        api_key: read_api_key()?.unwrap_or_default(),
    };
    let rows = sqlx::query("SELECT key, value FROM app_settings")
        .fetch_all(pool)
        .await?;
    for row in rows {
        let key: String = row.try_get("key")?;
        let value: String = row.try_get("value")?;
        let unquoted = unquote_value(&value);
        match key.as_str() {
            "llm_provider" if !unquoted.is_empty() => cfg.provider = unquoted,
            "llm_base_url" if !unquoted.is_empty() => cfg.base_url = unquoted,
            "llm_model" if !unquoted.is_empty() => cfg.model = unquoted,
            _ => {}
        }
    }
    // If user selected anthropic but left the base URL at the OpenAI
    // default (e.g. they switched after saving), reset it to a sane
    // anthropic value so the adapter can reach `/v1/messages`.
    if cfg.provider.eq_ignore_ascii_case("anthropic")
        && cfg.base_url.contains("openai.com")
    {
        cfg.base_url = "https://api.anthropic.com".to_string();
    }
    Ok(cfg)
}

async fn migrate_legacy_api_key(pool: &SqlitePool) -> AppResult<()> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
        .bind(LEGACY_API_KEY_SETTING)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(());
    };

    let value: String = row.try_get("value")?;
    let legacy_key = unquote_value(&value);
    if !legacy_key.is_empty() && read_api_key()?.is_none() {
        write_api_key(&legacy_key)?;
    }

    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(LEGACY_API_KEY_SETTING)
        .execute(pool)
        .await?;
    Ok(())
}

fn keychain_entry() -> AppResult<Entry> {
    Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(AppError::from)
}

fn read_api_key() -> AppResult<Option<String>> {
    match keychain_entry()?.get_password() {
        Ok(key) if key.is_empty() => Ok(None),
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(AppError::from(err)),
    }
}

fn write_api_key(api_key: &str) -> AppResult<()> {
    let entry = keychain_entry()?;
    if api_key.trim().is_empty() {
        match entry.delete_password() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(AppError::from(err)),
        }
    } else {
        entry.set_password(api_key).map_err(AppError::from)
    }
}

/// Settings are serialized as JSON strings so we can round-trip them
/// through `app_settings.value TEXT`. The UI never sees raw JSON.
fn unquote_value(value: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => value.to_string(),
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AiSettingsInput {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
}

impl AiSettingsInput {
    fn to_rows(&self) -> Vec<(&'static str, String)> {
        let mut rows = Vec::new();
        let mut push = |key: &'static str, value: &Option<String>| {
            if let Some(v) = value {
                let encoded = serde_json::to_string(&serde_json::Value::String(v.clone()))
                    .unwrap_or_else(|_| format!("\"{v}\""));
                rows.push((key, encoded));
            }
        };
        push("llm_provider", &self.provider);
        push("llm_base_url", &self.base_url);
        push("llm_model", &self.model);
        rows
    }
}
