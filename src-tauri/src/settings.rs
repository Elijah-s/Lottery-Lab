//! AI / LLM settings persistence.
//!
//! Non-secret LLM settings live in SQLite. Desktop API keys are stored in
//! the OS keyring; mobile keys use app-private storage and are only exposed
//! to the UI as boolean flags.

#[cfg(not(mobile))]
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::{AppError, AppResult};
use crate::llm::LlmConfig;
use crate::time_utils::now_beijing_iso;

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_MODEL: &str = "gpt-4o-mini";
#[cfg(not(mobile))]
const KEYCHAIN_SERVICE: &str = "com.elijah.lottery-lab";
const KEYCHAIN_ACCOUNT: &str = "llm_api_key";
const WORLDCUP_RESEARCH_ACCOUNT: &str = "llm_api_key_worldcup_research";
const WORLDCUP_PREDICTION_ACCOUNT: &str = "llm_api_key_worldcup_prediction";
const WORLDCUP_BUDGET_ACCOUNT: &str = "llm_api_key_worldcup_budget";
const LEGACY_API_KEY_SETTING: &str = "llm_api_key";
#[cfg(any(mobile, test))]
const SECRET_API_KEY_SETTING: &str = "secret_llm_api_key";
#[cfg(any(mobile, test))]
const SECRET_WORLDCUP_RESEARCH_API_KEY_SETTING: &str = "secret_llm_api_key_worldcup_research";
#[cfg(any(mobile, test))]
const SECRET_WORLDCUP_PREDICTION_API_KEY_SETTING: &str =
    "secret_llm_api_key_worldcup_prediction";
#[cfg(any(mobile, test))]
const SECRET_WORLDCUP_BUDGET_API_KEY_SETTING: &str = "secret_llm_api_key_worldcup_budget";

const WORLDCUP_RESEARCH_PREFIX: &str = "worldcup_research";
const WORLDCUP_PREDICTION_PREFIX: &str = "worldcup_prediction";
const WORLDCUP_BUDGET_PREFIX: &str = "worldcup_budget";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiSettings {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    /// Returned as a boolean flag so we don't leak the key to the UI.
    pub has_api_key: bool,
    pub worldcup_research: LlmProfileSettings,
    pub worldcup_prediction: LlmProfileSettings,
    pub worldcup_budget: LlmProfileSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmProfileSettings {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub has_api_key: bool,
    pub api_key_source: String,
}

impl Default for LlmProfileSettings {
    fn default() -> Self {
        Self {
            provider: None,
            base_url: None,
            model: None,
            has_api_key: false,
            api_key_source: "none".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum LlmProfileKind {
    Default,
    WorldCupResearch,
    WorldCupPrediction,
    WorldCupBudget,
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
            "worldcup_research_provider" => out.worldcup_research.provider = Some(unquoted),
            "worldcup_research_base_url" => out.worldcup_research.base_url = Some(unquoted),
            "worldcup_research_model" => out.worldcup_research.model = Some(unquoted),
            "worldcup_prediction_provider" => out.worldcup_prediction.provider = Some(unquoted),
            "worldcup_prediction_base_url" => out.worldcup_prediction.base_url = Some(unquoted),
            "worldcup_prediction_model" => out.worldcup_prediction.model = Some(unquoted),
            "worldcup_budget_provider" => out.worldcup_budget.provider = Some(unquoted),
            "worldcup_budget_base_url" => out.worldcup_budget.base_url = Some(unquoted),
            "worldcup_budget_model" => out.worldcup_budget.model = Some(unquoted),
            _ => {}
        }
    }
    let default_key_present = read_api_key(pool, KEYCHAIN_ACCOUNT).await?.is_some();
    out.has_api_key = default_key_present;
    apply_profile_key_status(
        pool,
        &mut out.worldcup_research,
        WORLDCUP_RESEARCH_ACCOUNT,
        default_key_present,
    )
    .await?;
    apply_profile_key_status(
        pool,
        &mut out.worldcup_prediction,
        WORLDCUP_PREDICTION_ACCOUNT,
        default_key_present,
    )
    .await?;
    apply_profile_key_status(
        pool,
        &mut out.worldcup_budget,
        WORLDCUP_BUDGET_ACCOUNT,
        default_key_present,
    )
    .await?;
    Ok(out)
}

pub async fn save_settings(
    pool: &SqlitePool,
    update: AiSettingsInput,
) -> AppResult<AiSettings> {
    if let Some(api_key) = update.api_key.as_deref() {
        write_api_key(pool, KEYCHAIN_ACCOUNT, api_key).await?;
    }
    if let Some(profile) = update.worldcup_research.as_ref() {
        if let Some(api_key) = profile.api_key.as_deref() {
            write_api_key(pool, WORLDCUP_RESEARCH_ACCOUNT, api_key).await?;
        }
    }
    if let Some(profile) = update.worldcup_prediction.as_ref() {
        if let Some(api_key) = profile.api_key.as_deref() {
            write_api_key(pool, WORLDCUP_PREDICTION_ACCOUNT, api_key).await?;
        }
    }
    if let Some(profile) = update.worldcup_budget.as_ref() {
        if let Some(api_key) = profile.api_key.as_deref() {
            write_api_key(pool, WORLDCUP_BUDGET_ACCOUNT, api_key).await?;
        }
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
    resolve_llm_config_for(pool, LlmProfileKind::Default).await
}

pub async fn resolve_llm_config_for(
    pool: &SqlitePool,
    kind: LlmProfileKind,
) -> AppResult<LlmConfig> {
    migrate_legacy_api_key(pool).await?;
    let mut cfg = LlmConfig {
        provider: "openai".to_string(),
        base_url: DEFAULT_BASE_URL.to_string(),
        model: DEFAULT_MODEL.to_string(),
        api_key: read_api_key(pool, KEYCHAIN_ACCOUNT)
            .await?
            .unwrap_or_default(),
    };
    let rows = sqlx::query("SELECT key, value FROM app_settings")
        .fetch_all(pool)
        .await?;
    let profile_prefix = profile_prefix(kind);
    let mut profile_provider: Option<String> = None;
    let mut profile_base_url: Option<String> = None;
    let mut profile_model: Option<String> = None;
    for row in rows {
        let key: String = row.try_get("key")?;
        let value: String = row.try_get("value")?;
        let unquoted = unquote_value(&value);
        if unquoted.is_empty() {
            continue;
        }
        if key == "llm_provider" {
            cfg.provider = unquoted;
            continue;
        }
        if key == "llm_base_url" {
            cfg.base_url = unquoted;
            continue;
        }
        if key == "llm_model" {
            cfg.model = unquoted;
            continue;
        }
        if let Some(prefix) = profile_prefix {
            if key == profile_setting_key(prefix, "provider") {
                profile_provider = Some(unquoted);
            } else if key == profile_setting_key(prefix, "base_url") {
                profile_base_url = Some(unquoted);
            } else if key == profile_setting_key(prefix, "model") {
                profile_model = Some(unquoted);
            }
        }
    }
    if let Some(provider) = profile_provider {
        cfg.provider = provider;
    }
    if let Some(base_url) = profile_base_url {
        cfg.base_url = base_url;
    }
    if let Some(model) = profile_model {
        cfg.model = model;
    }
    if let Some(account) = profile_keychain_account(kind) {
        if let Some(profile_key) = read_api_key(pool, account).await? {
            cfg.api_key = profile_key;
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
    if !legacy_key.is_empty()
        && read_api_key(pool, KEYCHAIN_ACCOUNT).await?.is_none()
    {
        write_api_key(pool, KEYCHAIN_ACCOUNT, &legacy_key).await?;
    }

    sqlx::query("DELETE FROM app_settings WHERE key = ?")
        .bind(LEGACY_API_KEY_SETTING)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(not(mobile))]
fn keychain_entry(account: &str) -> AppResult<Entry> {
    Entry::new(KEYCHAIN_SERVICE, account).map_err(AppError::from)
}

#[cfg(not(mobile))]
fn read_api_key_from_keyring(account: &str) -> AppResult<Option<String>> {
    match keychain_entry(account)?.get_password() {
        Ok(key) if key.is_empty() => Ok(None),
        Ok(key) => Ok(Some(key)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(AppError::from(err)),
    }
}

#[cfg(not(mobile))]
fn write_api_key_to_keyring(account: &str, api_key: &str) -> AppResult<()> {
    let entry = keychain_entry(account)?;
    if api_key.trim().is_empty() {
        match entry.delete_password() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(AppError::from(err)),
        }
    } else {
        entry.set_password(api_key).map_err(AppError::from)
    }
}

#[cfg(not(mobile))]
async fn read_api_key(_pool: &SqlitePool, account: &str) -> AppResult<Option<String>> {
    read_api_key_from_keyring(account)
}

#[cfg(not(mobile))]
async fn write_api_key(_pool: &SqlitePool, account: &str, api_key: &str) -> AppResult<()> {
    write_api_key_to_keyring(account, api_key)
}

#[cfg(mobile)]
async fn read_api_key(pool: &SqlitePool, account: &str) -> AppResult<Option<String>> {
    let setting_key = secret_setting_key(account)?;
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
        .bind(setting_key)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let value: String = row.try_get("value")?;
    let key = unquote_value(&value);
    if key.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(key))
    }
}

#[cfg(mobile)]
async fn write_api_key(pool: &SqlitePool, account: &str, api_key: &str) -> AppResult<()> {
    let setting_key = secret_setting_key(account)?;
    if api_key.trim().is_empty() {
        sqlx::query("DELETE FROM app_settings WHERE key = ?")
            .bind(setting_key)
            .execute(pool)
            .await?;
        return Ok(());
    }

    let now = now_beijing_iso();
    sqlx::query(
        r#"
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        "#,
    )
    .bind(setting_key)
    .bind(encode_setting_value(api_key))
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(any(mobile, test))]
fn secret_setting_key(account: &str) -> AppResult<&'static str> {
    match account {
        KEYCHAIN_ACCOUNT => Ok(SECRET_API_KEY_SETTING),
        WORLDCUP_RESEARCH_ACCOUNT => Ok(SECRET_WORLDCUP_RESEARCH_API_KEY_SETTING),
        WORLDCUP_PREDICTION_ACCOUNT => Ok(SECRET_WORLDCUP_PREDICTION_API_KEY_SETTING),
        WORLDCUP_BUDGET_ACCOUNT => Ok(SECRET_WORLDCUP_BUDGET_API_KEY_SETTING),
        _ => Err(AppError::Config(format!("未知密钥账户：{account}"))),
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

fn encode_setting_value(value: &str) -> String {
    serde_json::to_string(&serde_json::Value::String(value.to_string()))
        .unwrap_or_else(|_| format!("\"{value}\""))
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AiSettingsInput {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub worldcup_research: Option<LlmProfileInput>,
    pub worldcup_prediction: Option<LlmProfileInput>,
    pub worldcup_budget: Option<LlmProfileInput>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LlmProfileInput {
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
                rows.push((key, encode_setting_value(v)));
            }
        };
        push("llm_provider", &self.provider);
        push("llm_base_url", &self.base_url);
        push("llm_model", &self.model);
        if let Some(profile) = self.worldcup_research.as_ref() {
            push_profile_rows(&mut rows, WORLDCUP_RESEARCH_PREFIX, profile);
        }
        if let Some(profile) = self.worldcup_prediction.as_ref() {
            push_profile_rows(&mut rows, WORLDCUP_PREDICTION_PREFIX, profile);
        }
        if let Some(profile) = self.worldcup_budget.as_ref() {
            push_profile_rows(&mut rows, WORLDCUP_BUDGET_PREFIX, profile);
        }
        rows
    }
}

fn push_profile_rows(
    rows: &mut Vec<(&'static str, String)>,
    prefix: &'static str,
    profile: &LlmProfileInput,
) {
    let mut push = |suffix: &'static str, value: &Option<String>| {
        if let Some(v) = value {
            rows.push((profile_setting_key(prefix, suffix), encode_setting_value(v)));
        }
    };
    push("provider", &profile.provider);
    push("base_url", &profile.base_url);
    push("model", &profile.model);
}

fn profile_setting_key(prefix: &'static str, suffix: &'static str) -> &'static str {
    match (prefix, suffix) {
        (WORLDCUP_RESEARCH_PREFIX, "provider") => "worldcup_research_provider",
        (WORLDCUP_RESEARCH_PREFIX, "base_url") => "worldcup_research_base_url",
        (WORLDCUP_RESEARCH_PREFIX, "model") => "worldcup_research_model",
        (WORLDCUP_PREDICTION_PREFIX, "provider") => "worldcup_prediction_provider",
        (WORLDCUP_PREDICTION_PREFIX, "base_url") => "worldcup_prediction_base_url",
        (WORLDCUP_PREDICTION_PREFIX, "model") => "worldcup_prediction_model",
        (WORLDCUP_BUDGET_PREFIX, "provider") => "worldcup_budget_provider",
        (WORLDCUP_BUDGET_PREFIX, "base_url") => "worldcup_budget_base_url",
        (WORLDCUP_BUDGET_PREFIX, "model") => "worldcup_budget_model",
        _ => unreachable!("invalid profile setting key"),
    }
}

async fn apply_profile_key_status(
    pool: &SqlitePool,
    profile: &mut LlmProfileSettings,
    account: &str,
    default_key_present: bool,
) -> AppResult<()> {
    if read_api_key(pool, account).await?.is_some() {
        profile.has_api_key = true;
        profile.api_key_source = "profile".to_string();
    } else if default_key_present {
        profile.has_api_key = true;
        profile.api_key_source = "global".to_string();
    } else {
        profile.has_api_key = false;
        profile.api_key_source = "none".to_string();
    }
    Ok(())
}

fn profile_prefix(kind: LlmProfileKind) -> Option<&'static str> {
    match kind {
        LlmProfileKind::Default => None,
        LlmProfileKind::WorldCupResearch => Some(WORLDCUP_RESEARCH_PREFIX),
        LlmProfileKind::WorldCupPrediction => Some(WORLDCUP_PREDICTION_PREFIX),
        LlmProfileKind::WorldCupBudget => Some(WORLDCUP_BUDGET_PREFIX),
    }
}

fn profile_keychain_account(kind: LlmProfileKind) -> Option<&'static str> {
    match kind {
        LlmProfileKind::Default => None,
        LlmProfileKind::WorldCupResearch => Some(WORLDCUP_RESEARCH_ACCOUNT),
        LlmProfileKind::WorldCupPrediction => Some(WORLDCUP_PREDICTION_ACCOUNT),
        LlmProfileKind::WorldCupBudget => Some(WORLDCUP_BUDGET_ACCOUNT),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_setting_key_maps_known_accounts() {
        assert_eq!(
            secret_setting_key(KEYCHAIN_ACCOUNT).unwrap(),
            SECRET_API_KEY_SETTING
        );
        assert_eq!(
            secret_setting_key(WORLDCUP_RESEARCH_ACCOUNT).unwrap(),
            SECRET_WORLDCUP_RESEARCH_API_KEY_SETTING
        );
        assert_eq!(
            secret_setting_key(WORLDCUP_PREDICTION_ACCOUNT).unwrap(),
            SECRET_WORLDCUP_PREDICTION_API_KEY_SETTING
        );
        assert_eq!(
            secret_setting_key(WORLDCUP_BUDGET_ACCOUNT).unwrap(),
            SECRET_WORLDCUP_BUDGET_API_KEY_SETTING
        );
    }

    #[test]
    fn settings_rows_do_not_persist_api_key_fields() {
        let input = AiSettingsInput {
            provider: Some("openai-compatible".to_string()),
            base_url: Some("https://example.test/v1".to_string()),
            model: Some("test-model".to_string()),
            api_key: Some("secret".to_string()),
            worldcup_research: Some(LlmProfileInput {
                provider: None,
                base_url: None,
                model: Some("research-model".to_string()),
                api_key: Some("profile-secret".to_string()),
            }),
            worldcup_prediction: None,
            worldcup_budget: None,
        };

        let rows = input.to_rows();
        let keys = rows.iter().map(|(key, _)| *key).collect::<Vec<_>>();
        assert!(keys.contains(&"llm_provider"));
        assert!(keys.contains(&"llm_base_url"));
        assert!(keys.contains(&"llm_model"));
        assert!(keys.contains(&"worldcup_research_model"));
        assert!(!keys.contains(&LEGACY_API_KEY_SETTING));
        assert!(!keys.contains(&SECRET_API_KEY_SETTING));
    }

    #[test]
    fn setting_value_round_trips_as_json_string() {
        let value = "sk-test-中文";
        assert_eq!(unquote_value(&encode_setting_value(value)), value);
    }
}
