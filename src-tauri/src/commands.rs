//! Tauri IPC commands exposed to the front-end.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use tauri::State;

use crate::backtest::{self, BacktestRunDto, BacktestRunInput, BacktestSampleDto};
use crate::errors::{AppError, AppResult};
use crate::llm;
use crate::prompts::{self, PromptRecord};
use crate::recommendation::{self, RecommendationInput, RecommendationOutput};
use crate::reviews::{self, ReviewDto};
use crate::settings::{self, AiSettings, AiSettingsInput};
use crate::state::AppState;
use crate::sync::{SyncService, SyncSummary, DEFAULT_LOOKBACK};

fn build_http_client() -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .user_agent("LotteryLab/0.1 (+macOS; desktop; local)")
        .build()
        .expect("reqwest client builds")
}

// --- Sync ------------------------------------------------------------------

#[tauri::command]
pub async fn sync_draws(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> AppResult<SyncSummary> {
    let service = SyncService::new(state.pool.clone());
    let limit = limit.unwrap_or(DEFAULT_LOOKBACK).clamp(1, 1000);
    Ok(service.sync_all(limit).await)
}

// --- Draws -----------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct DrawDto {
    pub id: i64,
    pub lottery_type: String,
    pub issue: String,
    pub draw_date: String,
    pub numbers: serde_json::Value,
    pub source_name: Option<String>,
    pub source_url: Option<String>,
    pub fetched_at: String,
}

#[tauri::command]
pub async fn list_draws(
    state: State<'_, AppState>,
    lottery_type: String,
    limit: Option<i64>,
) -> AppResult<Vec<DrawDto>> {
    let limit = limit.unwrap_or(150).clamp(1, 1000);
    let rows = sqlx::query(
        r#"
        SELECT id, lottery_type, issue, draw_date, numbers, source_name, source_url, fetched_at
        FROM draws
        WHERE lottery_type = ?
        ORDER BY CAST(issue AS INTEGER) DESC, id DESC
        LIMIT ?
        "#,
    )
    .bind(&lottery_type)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let numbers_str: String = row.try_get("numbers")?;
            let numbers: serde_json::Value =
                serde_json::from_str(&numbers_str).map_err(AppError::from)?;
            Ok(DrawDto {
                id: row.try_get("id")?,
                lottery_type: row.try_get("lottery_type")?,
                issue: row.try_get("issue")?,
                draw_date: row.try_get("draw_date")?,
                numbers,
                source_name: row.try_get("source_name")?,
                source_url: row.try_get("source_url")?,
                fetched_at: row.try_get("fetched_at")?,
            })
        })
        .collect()
}

// --- Sync runs -------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncRunDto {
    pub id: i64,
    pub lottery_type: String,
    pub status: String,
    pub source_name: Option<String>,
    pub source_url: Option<String>,
    pub inserted_count: i64,
    pub degraded: bool,
    pub attempts: serde_json::Value,
    pub error_summary: Option<String>,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_sync_runs(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<SyncRunDto>> {
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let rows = sqlx::query(
        r#"
        SELECT id, lottery_type, status, source_name, source_url, inserted_count,
               degraded, attempts, error_summary, created_at
        FROM sync_runs
        ORDER BY created_at DESC
        LIMIT ?
        "#,
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let attempts_str: String = row.try_get("attempts")?;
            let attempts: serde_json::Value =
                serde_json::from_str(&attempts_str).map_err(AppError::from)?;
            let degraded: i64 = row.try_get("degraded")?;
            Ok(SyncRunDto {
                id: row.try_get("id")?,
                lottery_type: row.try_get("lottery_type")?,
                status: row.try_get("status")?,
                source_name: row.try_get("source_name")?,
                source_url: row.try_get("source_url")?,
                inserted_count: row.try_get("inserted_count")?,
                degraded: degraded != 0,
                attempts,
                error_summary: row.try_get("error_summary")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

// --- Recommendation --------------------------------------------------------

#[tauri::command]
pub async fn create_recommendation(
    state: State<'_, AppState>,
    input: RecommendationInput,
) -> AppResult<RecommendationOutput> {
    let client = build_http_client();
    recommendation::create_recommendation(&state.pool, &client, input).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecommendationDto {
    pub id: i64,
    pub lottery_type: String,
    pub target_issue: String,
    pub user_request: String,
    pub parsed_request: serde_json::Value,
    pub recommended_numbers: serde_json::Value,
    pub stake_amount: i64,
    pub heuristic_score: f64,
    pub rules_version: String,
    pub ticket_text: String,
    pub analysis: serde_json::Value,
    pub candidate_snapshot: serde_json::Value,
    pub created_at: String,
}

#[tauri::command]
pub async fn list_recommendations(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<RecommendationDto>> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query(
        r#"
        SELECT id, lottery_type, target_issue, user_request, parsed_request,
               recommended_numbers, stake_amount, heuristic_score, rules_version,
               ticket_text, analysis, candidate_snapshot, created_at
        FROM recommendations
        ORDER BY id DESC
        LIMIT ?
        "#,
    )
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;

    rows.into_iter()
        .map(|row| {
            let parsed_str: String = row.try_get("parsed_request")?;
            let numbers_str: String = row.try_get("recommended_numbers")?;
            let analysis_str: String = row.try_get("analysis")?;
            let candidate_str: String = row.try_get("candidate_snapshot")?;
            Ok(RecommendationDto {
                id: row.try_get("id")?,
                lottery_type: row.try_get("lottery_type")?,
                target_issue: row.try_get("target_issue")?,
                user_request: row.try_get("user_request")?,
                parsed_request: serde_json::from_str(&parsed_str)?,
                recommended_numbers: serde_json::from_str(&numbers_str)?,
                stake_amount: row.try_get("stake_amount")?,
                heuristic_score: row.try_get("heuristic_score")?,
                rules_version: row.try_get("rules_version")?,
                ticket_text: row.try_get("ticket_text")?,
                analysis: serde_json::from_str(&analysis_str)?,
                candidate_snapshot: serde_json::from_str(&candidate_str)?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn delete_recommendations(
    state: State<'_, AppState>,
    ids: Vec<i64>,
) -> AppResult<usize> {
    let mut ids: Vec<i64> = ids.into_iter().filter(|id| *id > 0).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(0);
    }

    let mut tx = state.pool.begin().await?;
    let mut deleted = 0usize;
    for id in ids {
        sqlx::query("DELETE FROM reviews WHERE recommendation_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let result = sqlx::query("DELETE FROM recommendations WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        deleted += result.rows_affected() as usize;
    }
    tx.commit().await?;
    Ok(deleted)
}

// --- Reviews ---------------------------------------------------------------

#[tauri::command]
pub async fn review_pending(state: State<'_, AppState>) -> AppResult<usize> {
    reviews::review_pending(&state.pool).await
}

#[tauri::command]
pub async fn list_reviews(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<ReviewDto>> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    reviews::list_reviews(&state.pool, limit).await
}

// --- Backtest --------------------------------------------------------------

#[tauri::command]
pub async fn save_backtest(
    state: State<'_, AppState>,
    input: BacktestRunInput,
) -> AppResult<i64> {
    backtest::save_run(&state.pool, input).await
}

#[tauri::command]
pub async fn list_backtests(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<BacktestRunDto>> {
    let limit = limit.unwrap_or(20).clamp(1, 100);
    backtest::list_runs(&state.pool, limit).await
}

#[tauri::command]
pub async fn get_backtest_samples(
    state: State<'_, AppState>,
    run_id: i64,
) -> AppResult<Vec<BacktestSampleDto>> {
    backtest::list_samples(&state.pool, run_id).await
}

#[derive(Debug, Serialize)]
pub struct ExportPayload {
    pub filename: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[tauri::command]
pub async fn export_backtest(
    state: State<'_, AppState>,
    run_id: i64,
    format: Option<String>,
) -> AppResult<ExportPayload> {
    let format = format.unwrap_or_else(|| "json".to_string());
    let bytes = backtest::export_run(&state.pool, run_id, &format).await?;
    let (mime, extension) = match format.as_str() {
        "csv" => ("text/csv; charset=utf-8", "csv"),
        _ => ("application/json", "json"),
    };
    Ok(ExportPayload {
        filename: format!("backtest-{run_id}.{extension}"),
        mime: mime.to_string(),
        bytes,
    })
}

// --- Prompts ---------------------------------------------------------------

#[tauri::command]
pub async fn get_prompts(state: State<'_, AppState>) -> AppResult<Vec<PromptRecord>> {
    prompts::list_prompts(&state.pool).await
}

#[derive(Debug, Deserialize)]
pub struct PromptUpdate {
    pub role_name: String,
    pub content: String,
}

#[tauri::command]
pub async fn save_prompts(
    state: State<'_, AppState>,
    updates: Vec<PromptUpdate>,
) -> AppResult<Vec<PromptRecord>> {
    let pairs: Vec<(String, String)> = updates
        .into_iter()
        .map(|u| (u.role_name, u.content))
        .collect();
    prompts::save_prompts(&state.pool, &pairs).await?;
    prompts::list_prompts(&state.pool).await
}

#[tauri::command]
pub async fn reset_prompts(state: State<'_, AppState>) -> AppResult<Vec<PromptRecord>> {
    prompts::reset_defaults(&state.pool).await?;
    prompts::list_prompts(&state.pool).await
}

// --- Settings --------------------------------------------------------------

#[tauri::command]
pub async fn get_ai_settings(state: State<'_, AppState>) -> AppResult<AiSettings> {
    settings::load_settings(&state.pool).await
}

#[tauri::command]
pub async fn save_ai_settings(
    state: State<'_, AppState>,
    input: AiSettingsInput,
) -> AppResult<AiSettings> {
    settings::save_settings(&state.pool, input).await
}

#[derive(Debug, Serialize)]
pub struct LlmModelList {
    pub provider: String,
    pub base_url: String,
    pub models: Vec<String>,
}

#[tauri::command]
pub async fn list_llm_models(state: State<'_, AppState>) -> AppResult<LlmModelList> {
    let config = settings::resolve_llm_config(&state.pool).await?;
    let client = build_http_client();
    let models = llm::list_models(&client, &config).await?;
    Ok(LlmModelList {
        provider: config.provider,
        base_url: config.base_url,
        models,
    })
}

#[derive(Debug, Serialize)]
pub struct LlmConnectionTest {
    pub ok: bool,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub message: String,
}

#[tauri::command]
pub async fn test_llm_connection(
    state: State<'_, AppState>,
) -> AppResult<LlmConnectionTest> {
    let config = settings::resolve_llm_config(&state.pool).await?;
    let client = build_http_client();
    let result = llm::test_connection(&client, &config).await;
    let (ok, message) = match result {
        Ok(reply) => {
            let detail = if reply.is_empty() { "无正文".to_string() } else { reply };
            (true, format!("连接成功，模型已响应：{detail}"))
        }
        Err(err) => (false, err.to_string()),
    };
    Ok(LlmConnectionTest {
        ok,
        provider: config.provider,
        base_url: config.base_url,
        model: config.model,
        message,
    })
}
