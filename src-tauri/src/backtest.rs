//! Backtest persistence + export.
//!
//! The heavy lifting (iterating historical issues, generating candidate
//! tickets per strategy, computing hits) lives in the TS layer where
//! the scoring / ticketMath / parsing code already lives. Rust only
//! persists the completed run, exposes it to the UI, and serves export
//! bytes.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::AppResult;
use crate::time_utils::now_beijing_iso;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestSampleInput {
    pub strategy_name: String,
    pub issue: String,
    pub generated_numbers: serde_json::Value,
    pub actual_numbers: serde_json::Value,
    pub score_snapshot: serde_json::Value,
    pub hit_summary: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestRunInput {
    pub lottery_type: String,
    pub request_text: String,
    pub start_issue: String,
    pub end_issue: String,
    pub strategies: Vec<String>,
    pub summary: serde_json::Value,
    pub config_snapshot: serde_json::Value,
    pub report_markdown: Option<String>,
    pub samples: Vec<BacktestSampleInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestRunDto {
    pub id: i64,
    pub lottery_type: String,
    pub request_text: String,
    pub start_issue: String,
    pub end_issue: String,
    pub strategies: Vec<String>,
    pub summary: serde_json::Value,
    pub config_snapshot: serde_json::Value,
    pub report_markdown: Option<String>,
    pub created_at: String,
    pub sample_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacktestSampleDto {
    pub id: i64,
    pub backtest_run_id: i64,
    pub strategy_name: String,
    pub issue: String,
    pub generated_numbers: serde_json::Value,
    pub actual_numbers: serde_json::Value,
    pub score_snapshot: serde_json::Value,
    pub hit_summary: serde_json::Value,
}

pub async fn save_run(pool: &SqlitePool, input: BacktestRunInput) -> AppResult<i64> {
    let now = now_beijing_iso();
    let strategies_json = serde_json::to_string(&input.strategies)?;
    let summary_json = serde_json::to_string(&input.summary)?;
    let config_json = serde_json::to_string(&input.config_snapshot)?;

    let mut tx = pool.begin().await?;
    let result = sqlx::query(
        r#"
        INSERT INTO backtests (
            lottery_type, request_text, start_issue, end_issue, strategies,
            summary, config_snapshot, report_markdown, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&input.lottery_type)
    .bind(&input.request_text)
    .bind(&input.start_issue)
    .bind(&input.end_issue)
    .bind(strategies_json)
    .bind(summary_json)
    .bind(config_json)
    .bind(&input.report_markdown)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    let run_id = result.last_insert_rowid();

    for sample in &input.samples {
        sqlx::query(
            r#"
            INSERT INTO backtest_samples (
                backtest_run_id, strategy_name, issue,
                generated_numbers, actual_numbers, score_snapshot, hit_summary
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(run_id)
        .bind(&sample.strategy_name)
        .bind(&sample.issue)
        .bind(serde_json::to_string(&sample.generated_numbers)?)
        .bind(serde_json::to_string(&sample.actual_numbers)?)
        .bind(serde_json::to_string(&sample.score_snapshot)?)
        .bind(serde_json::to_string(&sample.hit_summary)?)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(run_id)
}

pub async fn list_runs(pool: &SqlitePool, limit: i64) -> AppResult<Vec<BacktestRunDto>> {
    let rows = sqlx::query(
        r#"
        SELECT b.id, b.lottery_type, b.request_text, b.start_issue, b.end_issue,
               b.strategies, b.summary, b.config_snapshot, b.report_markdown, b.created_at,
               (SELECT COUNT(*) FROM backtest_samples s WHERE s.backtest_run_id = b.id) AS sample_count
        FROM backtests b
        ORDER BY b.id DESC
        LIMIT ?
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_run).collect()
}

pub async fn list_samples(
    pool: &SqlitePool,
    run_id: i64,
) -> AppResult<Vec<BacktestSampleDto>> {
    let rows = sqlx::query(
        r#"
        SELECT id, backtest_run_id, strategy_name, issue,
               generated_numbers, actual_numbers, score_snapshot, hit_summary
        FROM backtest_samples
        WHERE backtest_run_id = ?
        ORDER BY id ASC
        "#,
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let gen_str: String = row.try_get("generated_numbers")?;
            let actual_str: String = row.try_get("actual_numbers")?;
            let score_str: String = row.try_get("score_snapshot")?;
            let hit_str: String = row.try_get("hit_summary")?;
            Ok(BacktestSampleDto {
                id: row.try_get("id")?,
                backtest_run_id: row.try_get("backtest_run_id")?,
                strategy_name: row.try_get("strategy_name")?,
                issue: row.try_get("issue")?,
                generated_numbers: serde_json::from_str(&gen_str)?,
                actual_numbers: serde_json::from_str(&actual_str)?,
                score_snapshot: serde_json::from_str(&score_str)?,
                hit_summary: serde_json::from_str(&hit_str)?,
            })
        })
        .collect()
}

pub async fn export_run(
    pool: &SqlitePool,
    run_id: i64,
    format: &str,
) -> AppResult<Vec<u8>> {
    let rows = sqlx::query(
        r#"
        SELECT lottery_type, request_text, start_issue, end_issue, strategies,
               summary, config_snapshot, report_markdown, created_at
        FROM backtests WHERE id = ?
        "#,
    )
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let run_row = rows.ok_or_else(|| crate::errors::AppError::Other(
        format!("回测记录 {run_id} 不存在"),
    ))?;
    let samples = list_samples(pool, run_id).await?;

    if format == "csv" {
        let mut out = String::new();
        out.push_str("strategy,issue,primary_hits,secondary_hits,score,generated,actual\n");
        for sample in &samples {
            let hit = &sample.hit_summary;
            let primary = hit.get("primary_hits").and_then(|v| v.as_i64()).unwrap_or(0);
            let secondary = hit.get("secondary_hits").and_then(|v| v.as_i64()).unwrap_or(0);
            let score = sample
                .score_snapshot
                .get("score")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let generated = sample.generated_numbers.to_string().replace(',', ";");
            let actual = sample.actual_numbers.to_string().replace(',', ";");
            out.push_str(&format!(
                "{},{},{},{},{:.2},\"{}\",\"{}\"\n",
                sample.strategy_name,
                sample.issue,
                primary,
                secondary,
                score,
                generated,
                actual,
            ));
        }
        return Ok(out.into_bytes());
    }

    // default json
    let strategies_str: String = run_row.try_get("strategies")?;
    let summary_str: String = run_row.try_get("summary")?;
    let config_str: String = run_row.try_get("config_snapshot")?;
    let payload = serde_json::json!({
        "run": {
            "id": run_id,
            "lottery_type": run_row.try_get::<String, _>("lottery_type")?,
            "request_text": run_row.try_get::<String, _>("request_text")?,
            "start_issue": run_row.try_get::<String, _>("start_issue")?,
            "end_issue": run_row.try_get::<String, _>("end_issue")?,
            "strategies": serde_json::from_str::<serde_json::Value>(&strategies_str)?,
            "summary": serde_json::from_str::<serde_json::Value>(&summary_str)?,
            "config_snapshot": serde_json::from_str::<serde_json::Value>(&config_str)?,
            "report_markdown": run_row.try_get::<Option<String>, _>("report_markdown")?,
            "created_at": run_row.try_get::<String, _>("created_at")?,
        },
        "samples": samples,
    });
    Ok(serde_json::to_vec_pretty(&payload)?)
}

fn row_to_run(row: sqlx::sqlite::SqliteRow) -> AppResult<BacktestRunDto> {
    let strategies_str: String = row.try_get("strategies")?;
    let summary_str: String = row.try_get("summary")?;
    let config_str: String = row.try_get("config_snapshot")?;
    Ok(BacktestRunDto {
        id: row.try_get("id")?,
        lottery_type: row.try_get("lottery_type")?,
        request_text: row.try_get("request_text")?,
        start_issue: row.try_get("start_issue")?,
        end_issue: row.try_get("end_issue")?,
        strategies: serde_json::from_str(&strategies_str)?,
        summary: serde_json::from_str(&summary_str)?,
        config_snapshot: serde_json::from_str(&config_str)?,
        report_markdown: row.try_get("report_markdown")?,
        created_at: row.try_get("created_at")?,
        sample_count: row.try_get("sample_count")?,
    })
}
