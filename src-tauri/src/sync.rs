//! Draw sync service.
//!
//! Iterates over the registered sources per lottery type, keeps the
//! first non-empty success (best case = official, fallback = backup),
//! normalizes draws, dedups against what's already in SQLite, and
//! appends a `sync_runs` row so the UI can show status and attempts.

use std::time::Duration;

use log::{debug, info, warn};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::errors::AppResult;
use crate::reviews;
use crate::sources::{dlt_official::DltOfficialSource, ssq_official::SsqOfficialSource};
use crate::sources::text_backup::{DltTextBackupSource, SsqTextBackupSource};
use crate::sources::{DrawRecord, DrawSource, SourceAttempt};
use crate::time_utils::now_beijing_iso;

pub const DEFAULT_LOOKBACK: usize = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSummary {
    pub ssq: LotterySyncSummary,
    pub dlt: LotterySyncSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LotterySyncSummary {
    pub lottery_type: String,
    pub status: String,
    pub degraded: bool,
    pub source_name: Option<String>,
    pub source_url: Option<String>,
    pub inserted_count: usize,
    pub total_fetched: usize,
    pub attempts: Vec<SourceAttempt>,
    pub error_summary: Option<String>,
}

pub struct SyncService {
    pool: SqlitePool,
    client: Client,
}

impl SyncService {
    pub fn new(pool: SqlitePool) -> Self {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(
                "LotteryLab/0.1 (+macOS; desktop; local experimental tool)",
            )
            .build()
            .expect("reqwest client builds");
        Self { pool, client }
    }

    pub async fn sync_all(&self, limit: usize) -> SyncSummary {
        info!(target: "sync", "start sync_all limit={limit}");
        let ssq = self.sync_lottery("ssq", limit).await;
        let dlt = self.sync_lottery("dlt", limit).await;
        let summary = SyncSummary { ssq, dlt };
        // Fire-and-log review: failure here shouldn't affect the sync
        // summary we return to the UI.
        match reviews::review_pending(&self.pool).await {
            Ok(n) if n > 0 => info!(target: "sync", "auto-reviewed {n} recommendations"),
            Ok(_) => {}
            Err(err) => warn!(target: "sync", "auto review failed: {err}"),
        }
        summary
    }

    async fn sync_lottery(
        &self,
        lottery_type: &str,
        limit: usize,
    ) -> LotterySyncSummary {
        let sources: Vec<Box<dyn DrawSource>> = match lottery_type {
            "ssq" => vec![
                Box::new(SsqOfficialSource::new(self.client.clone())),
                Box::new(SsqTextBackupSource::new(self.client.clone())),
            ],
            "dlt" => vec![
                Box::new(DltOfficialSource::new(self.client.clone())),
                Box::new(DltTextBackupSource::new(self.client.clone())),
            ],
            _ => vec![],
        };

        let mut attempts: Vec<SourceAttempt> = Vec::new();
        let mut chosen: Option<(String, Option<String>, Vec<DrawRecord>)> = None;
        let mut best_partial: Option<(String, Option<String>, Vec<DrawRecord>)> = None;
        let mut error_summary: Option<String> = None;

        for source in sources.iter() {
            let name = source.name().to_string();
            let url = source.url_hint().map(|s| s.to_string());
            match source.fetch(limit).await {
                Ok(draws) => {
                    let fetched = draws.len();
                    let (valid, invalid) = validate_split(&draws, lottery_type);
                    debug!(
                        target: "sync",
                        "{name}: fetched={fetched} valid={valid_len} invalid={invalid_len}",
                        valid_len = valid.len(),
                        invalid_len = invalid,
                    );
                    attempts.push(SourceAttempt {
                        source_name: name.clone(),
                        source_url: url.clone(),
                        status: if valid.is_empty() {
                            "no-valid-data".to_string()
                        } else if valid.len() < limit {
                            "partial".to_string()
                        } else {
                            "ok".to_string()
                        },
                        fetched_count: fetched,
                        valid_count: valid.len(),
                        invalid_count: invalid,
                        error: None,
                    });
                    if valid.len() >= limit {
                        chosen = Some((name, url, valid));
                        break;
                    }
                    let is_better_partial = match best_partial.as_ref() {
                        Some((_, _, draws)) => valid.len() > draws.len(),
                        None => true,
                    };
                    if !valid.is_empty() && is_better_partial {
                        best_partial = Some((name, url, valid));
                    }
                }
                Err(err) => {
                    warn!(target: "sync", "{name} failed: {err}");
                    error_summary = Some(err.to_string());
                    attempts.push(SourceAttempt {
                        source_name: name.clone(),
                        source_url: url.clone(),
                        status: "error".to_string(),
                        fetched_count: 0,
                        valid_count: 0,
                        invalid_count: 0,
                        error: Some(err.to_string()),
                    });
                }
            }
        }

        let chosen = chosen.or(best_partial);

        let (status, degraded, source_name, source_url, inserted) = match chosen {
            Some((name, url, draws)) => {
                let inserted = match self.persist_draws(&draws).await {
                    Ok(n) => {
                        error_summary = None;
                        n
                    }
                    Err(err) => {
                        warn!(target: "sync", "persist failed: {err}");
                        error_summary = Some(err.to_string());
                        0
                    }
                };
                let degraded = !name.contains("official");
                (
                    if inserted > 0 { "synced" } else { "unchanged" }.to_string(),
                    degraded,
                    Some(name),
                    url,
                    inserted,
                )
            }
            None => (
                "failed".to_string(),
                true,
                None,
                None,
                0,
            ),
        };
        if status != "failed" {
            error_summary = None;
        }

        let total_fetched = attempts
            .iter()
            .map(|attempt| attempt.fetched_count)
            .sum();

        let summary = LotterySyncSummary {
            lottery_type: lottery_type.to_string(),
            status: status.clone(),
            degraded,
            source_name: source_name.clone(),
            source_url: source_url.clone(),
            inserted_count: inserted,
            total_fetched,
            attempts: attempts.clone(),
            error_summary: error_summary.clone(),
        };

        if let Err(err) = self.record_sync_run(&summary).await {
            warn!(target: "sync", "record sync_run failed: {err}");
        }

        summary
    }

    async fn persist_draws(&self, draws: &[DrawRecord]) -> AppResult<usize> {
        let fetched_at = now_beijing_iso();
        let mut inserted = 0usize;
        let mut tx = self.pool.begin().await?;
        for draw in draws {
            let numbers = serde_json::to_string(&draw.numbers)?;
            let result = sqlx::query(
                r#"
                INSERT INTO draws (lottery_type, issue, draw_date, numbers, source_name, source_url, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(lottery_type, issue) DO NOTHING
                "#,
            )
            .bind(&draw.lottery_type)
            .bind(&draw.issue)
            .bind(&draw.draw_date)
            .bind(numbers)
            .bind(&draw.source_name)
            .bind(&draw.source_url)
            .bind(&fetched_at)
            .execute(&mut *tx)
            .await?;
            inserted += result.rows_affected() as usize;
        }
        tx.commit().await?;
        Ok(inserted)
    }

    async fn record_sync_run(
        &self,
        summary: &LotterySyncSummary,
    ) -> AppResult<()> {
        let attempts_json = serde_json::to_string(&summary.attempts)?;
        let created_at = now_beijing_iso();
        sqlx::query(
            r#"
            INSERT INTO sync_runs
                (lottery_type, status, source_name, source_url, inserted_count,
                 degraded, attempts, error_summary, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&summary.lottery_type)
        .bind(&summary.status)
        .bind(&summary.source_name)
        .bind(&summary.source_url)
        .bind(summary.inserted_count as i64)
        .bind(if summary.degraded { 1_i64 } else { 0_i64 })
        .bind(attempts_json)
        .bind(&summary.error_summary)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

fn validate_split(draws: &[DrawRecord], lottery_type: &str) -> (Vec<DrawRecord>, usize) {
    let mut valid = Vec::with_capacity(draws.len());
    let mut invalid = 0usize;
    for draw in draws {
        if draw.lottery_type != lottery_type {
            invalid += 1;
            continue;
        }
        if draw.issue.is_empty() || draw.draw_date.is_empty() {
            invalid += 1;
            continue;
        }
        let (primary_key, primary_pick, primary_range, secondary_key, secondary_pick, secondary_range) =
            match lottery_type {
                "ssq" => ("red", 6, (1u8, 33u8), "blue", 1, (1u8, 16u8)),
                "dlt" => ("front", 5, (1u8, 35u8), "back", 2, (1u8, 12u8)),
                _ => {
                    invalid += 1;
                    continue;
                }
            };

        let primary_ok = check_area(&draw.numbers, primary_key, primary_pick, primary_range);
        let secondary_ok = check_area(&draw.numbers, secondary_key, secondary_pick, secondary_range);
        if primary_ok && secondary_ok {
            valid.push(draw.clone());
        } else {
            invalid += 1;
        }
    }
    (valid, invalid)
}

fn check_area(
    numbers: &serde_json::Value,
    key: &str,
    expected_count: usize,
    range: (u8, u8),
) -> bool {
    let Some(array) = numbers.get(key).and_then(|v| v.as_array()) else {
        return false;
    };
    if array.len() != expected_count {
        return false;
    }
    let mut seen = std::collections::HashSet::with_capacity(array.len());
    for value in array {
        let Some(n) = value.as_u64() else {
            return false;
        };
        if n < range.0 as u64 || n > range.1 as u64 {
            return false;
        }
        if !seen.insert(n) {
            return false;
        }
    }
    true
}
