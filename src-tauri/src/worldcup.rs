//! World Cup analysis workflow.
//!
//! The module keeps the football feature honest: deterministic local
//! checks gate every LLM step, odds are explicitly source-graded, and
//! missing official data degrades to analysis-only output instead of
//! invented betting plans.

use chrono::{DateTime, Duration};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

use crate::errors::{AppError, AppResult};
use crate::llm::{self, ChatMessage};
use crate::prompts::list_prompts;
use crate::settings::{resolve_llm_config_for, LlmProfileKind};
use crate::time_utils::now_beijing_iso;

const FIFA_SCHEDULE_URL: &str = "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums";
const FIFA_CALENDAR_API_URL: &str = "https://api.fifa.com/api/v3/calendar/matches?language=zh-CN&idCompetition=17&idSeason=285023&count=400";
const SPORTTERY_HOME_URL: &str = "https://www.sporttery.cn/";
const SPORTTERY_NOTICE_URL: &str = "https://www.sporttery.cn/ctzc/czgg/20260519/10053747.html";
const DEFAULT_REFRESH_SECONDS: i64 = 3600;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldCupMatchDto {
    pub id: i64,
    pub fifa_match_id: String,
    pub match_no: i64,
    pub stage: String,
    pub group_name: Option<String>,
    pub home_team: String,
    pub away_team: String,
    pub kickoff_utc: String,
    pub kickoff_beijing: String,
    pub venue: String,
    pub city: String,
    pub country: String,
    pub status: String,
    pub result: Option<String>,
    pub source_url: String,
    pub updated_at: String,
    pub intelligence_count: i64,
    pub latest_prediction_id: Option<i64>,
    pub latest_plan_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldCupScheduleSync {
    pub inserted_or_updated: usize,
    pub total_matches: usize,
    pub source_name: String,
    pub source_url: String,
    pub status: String,
    pub message: String,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceHealthDto {
    pub id: i64,
    pub source_name: String,
    pub source_level: String,
    pub status: String,
    pub message: Option<String>,
    pub source_url: Option<String>,
    pub fetched_at: String,
    pub field_coverage: f64,
    pub failure_rate: f64,
    pub recommended_refresh_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvidenceItemDto {
    pub id: i64,
    pub research_run_id: i64,
    pub match_id: i64,
    pub category: String,
    pub source_level: String,
    pub source_name: String,
    pub url: String,
    pub title: String,
    pub published_at: Option<String>,
    pub fetched_at: String,
    pub extracted_json: serde_json::Value,
    pub raw_hash: String,
    pub credibility: f64,
    pub rule_check_json: serde_json::Value,
    pub accepted_by_rule: bool,
    pub audit_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchRunDto {
    pub id: i64,
    pub match_id: i64,
    pub trigger_type: String,
    pub research_model_profile: serde_json::Value,
    pub search_plan_json: serde_json::Value,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub evidence_bundle_hash: String,
    pub estimated_cost: f64,
    pub actual_cost: f64,
    pub evidence_count: i64,
    pub accepted_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PredictionRunDto {
    pub id: i64,
    pub match_id: i64,
    pub research_run_id: Option<i64>,
    pub model_profile: serde_json::Value,
    pub prompt_revision: i64,
    pub evidence_bundle_hash: String,
    pub local_probability: serde_json::Value,
    pub llm_probability: serde_json::Value,
    pub market_probability: serde_json::Value,
    pub final_probability: serde_json::Value,
    pub scoreline_distribution: serde_json::Value,
    pub confidence: f64,
    pub disagreement_score: f64,
    pub analysis_markdown: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetPlanDto {
    pub id: i64,
    pub match_id: i64,
    pub prediction_run_id: Option<i64>,
    pub odds_snapshot_id: Option<i64>,
    pub planning_mode: String,
    pub budget: f64,
    pub risk_mode: String,
    pub plan_json: serde_json::Value,
    pub expected_value: f64,
    pub max_loss: f64,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorldCupMatchDetailDto {
    pub match_info: WorldCupMatchDto,
    pub evidence: Vec<EvidenceItemDto>,
    pub predictions: Vec<PredictionRunDto>,
    pub budget_plans: Vec<BudgetPlanDto>,
    pub source_health: Vec<SourceHealthDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PreMatchIntelligenceInput {
    pub match_id: i64,
    pub query: Option<String>,
    pub trigger_type: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PredictionInput {
    pub match_id: i64,
    pub research_run_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BudgetPlanInput {
    pub match_id: i64,
    pub prediction_run_id: Option<i64>,
    pub budget: Option<f64>,
    pub risk_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OddsSyncSummary {
    pub source_name: String,
    pub source_level: String,
    pub status: String,
    pub message: String,
    pub events_found: usize,
    pub odds_found: usize,
    pub fetched_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueJobDto {
    pub id: i64,
    pub job_type: String,
    pub status: String,
    pub payload_json: serde_json::Value,
    pub estimated_cost: f64,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
struct SeedMatch {
    match_no: i64,
    stage: String,
    group_name: Option<String>,
    home_team: String,
    away_team: String,
    kickoff_utc: String,
    kickoff_beijing: String,
    venue: String,
    city: String,
    country: String,
    source_url: String,
}

pub async fn sync_worldcup_schedule(
    pool: &SqlitePool,
    client: &Client,
) -> AppResult<WorldCupScheduleSync> {
    let fetched_at = now_beijing_iso();
    let matches = match fetch_fifa_calendar_schedule(client).await {
        Ok(matches) if matches.len() == 104 => {
            insert_source_health(
                pool,
                SourceHealthInsert {
                    source_name: "FIFA 官方赛程 API",
                    source_level: "official",
                    status: "ok",
                    message: "已从 FIFA 官方赛程 API 获取 104 场完整赛程。",
                    source_url: Some(FIFA_CALENDAR_API_URL),
                    field_coverage: 1.0,
                    failure_rate: 0.0,
                    recommended_refresh_seconds: DEFAULT_REFRESH_SECONDS,
                },
            )
            .await?;
            matches
        }
        Ok(matches) => {
            let message = format!(
                "FIFA 官方赛程 API 返回 {} 场，不是预期的 104 场；已拒绝写入，避免保存不完整赛程。",
                matches.len()
            );
            insert_source_health(
                pool,
                SourceHealthInsert {
                    source_name: "FIFA 官方赛程 API",
                    source_level: "official",
                    status: "degraded",
                    message: &message,
                    source_url: Some(FIFA_CALENDAR_API_URL),
                    field_coverage: matches.len() as f64 / 104.0,
                    failure_rate: 1.0,
                    recommended_refresh_seconds: DEFAULT_REFRESH_SECONDS,
                },
            )
            .await?;
            return Err(AppError::BadResponse(message));
        }
        Err(err) => {
            let message = format!(
                "FIFA 官方赛程 API 获取失败：{err}。本次未写入占位赛程，请稍后重试。"
            );
            insert_source_health(
                pool,
                SourceHealthInsert {
                    source_name: "FIFA 官方赛程 API",
                    source_level: "official",
                    status: "degraded",
                    message: &message,
                    source_url: Some(FIFA_CALENDAR_API_URL),
                    field_coverage: 0.0,
                    failure_rate: 1.0,
                    recommended_refresh_seconds: DEFAULT_REFRESH_SECONDS,
                },
            )
            .await?;
            return Err(AppError::Http(message));
        }
    };

    let mut tx = pool.begin().await?;
    for item in &matches {
        let fifa_match_id = format!("FWC2026-{:03}", item.match_no);
        sqlx::query(
            r#"
            INSERT INTO worldcup_matches (
                fifa_match_id, match_no, stage, group_name, home_team, away_team,
                kickoff_utc, kickoff_beijing, venue, city, country, status,
                result, source_url, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, ?, ?)
            ON CONFLICT(fifa_match_id) DO UPDATE SET
                match_no = excluded.match_no,
                stage = excluded.stage,
                group_name = excluded.group_name,
                home_team = excluded.home_team,
                away_team = excluded.away_team,
                kickoff_utc = excluded.kickoff_utc,
                kickoff_beijing = excluded.kickoff_beijing,
                venue = excluded.venue,
                city = excluded.city,
                country = excluded.country,
                source_url = excluded.source_url,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(fifa_match_id)
        .bind(item.match_no)
        .bind(&item.stage)
        .bind(&item.group_name)
        .bind(&item.home_team)
        .bind(&item.away_team)
        .bind(&item.kickoff_utc)
        .bind(&item.kickoff_beijing)
        .bind(&item.venue)
        .bind(&item.city)
        .bind(&item.country)
        .bind(&item.source_url)
        .bind(&fetched_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(WorldCupScheduleSync {
        inserted_or_updated: matches.len(),
        total_matches: matches.len(),
        source_name: "FIFA 官方赛程 API".to_string(),
        source_url: FIFA_CALENDAR_API_URL.to_string(),
        status: "ok".to_string(),
        message: "已从 FIFA 官方赛程 API 同步 104 场完整赛程。".to_string(),
        fetched_at,
    })
}

pub async fn list_worldcup_matches(pool: &SqlitePool) -> AppResult<Vec<WorldCupMatchDto>> {
    let rows = sqlx::query(
        r#"
        SELECT m.*,
               COALESCE(e.cnt, 0) AS intelligence_count,
               p.id AS latest_prediction_id,
               b.id AS latest_plan_id
        FROM worldcup_matches m
        LEFT JOIN (
            SELECT match_id, COUNT(*) AS cnt
            FROM worldcup_evidence_items
            WHERE audit_status = 'accepted'
            GROUP BY match_id
        ) e ON e.match_id = m.id
        LEFT JOIN (
            SELECT match_id, MAX(id) AS id
            FROM worldcup_prediction_runs
            GROUP BY match_id
        ) p ON p.match_id = m.id
        LEFT JOIN (
            SELECT match_id, MAX(id) AS id
            FROM worldcup_betting_plans
            GROUP BY match_id
        ) b ON b.match_id = m.id
        ORDER BY m.match_no ASC
        "#,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(match_from_row).collect()
}

pub async fn get_worldcup_match_detail(
    pool: &SqlitePool,
    match_id: i64,
) -> AppResult<WorldCupMatchDetailDto> {
    let row = sqlx::query(
        r#"
        SELECT m.*,
               COALESCE(e.cnt, 0) AS intelligence_count,
               p.id AS latest_prediction_id,
               b.id AS latest_plan_id
        FROM worldcup_matches m
        LEFT JOIN (
            SELECT match_id, COUNT(*) AS cnt
            FROM worldcup_evidence_items
            WHERE audit_status = 'accepted'
            GROUP BY match_id
        ) e ON e.match_id = m.id
        LEFT JOIN (
            SELECT match_id, MAX(id) AS id
            FROM worldcup_prediction_runs
            GROUP BY match_id
        ) p ON p.match_id = m.id
        LEFT JOIN (
            SELECT match_id, MAX(id) AS id
            FROM worldcup_betting_plans
            GROUP BY match_id
        ) b ON b.match_id = m.id
        WHERE m.id = ?
        "#,
    )
    .bind(match_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::BadResponse("未找到世界杯比赛。".to_string()))?;
    Ok(WorldCupMatchDetailDto {
        match_info: match_from_row(row)?,
        evidence: list_match_evidence(pool, match_id).await?,
        predictions: list_predictions(pool, match_id, 5).await?,
        budget_plans: list_budget_plans(pool, match_id, 5).await?,
        source_health: list_worldcup_source_health(pool, 12).await?,
    })
}

pub async fn fetch_pre_match_intelligence(
    pool: &SqlitePool,
    client: &Client,
    input: PreMatchIntelligenceInput,
) -> AppResult<ResearchRunDto> {
    let match_info = get_basic_match(pool, input.match_id).await?;
    let started_at = now_beijing_iso();
    let trigger_type = input
        .trigger_type
        .unwrap_or_else(|| "manual_pre_match".to_string());
    let model_profile = resolve_model_profile(pool, LlmProfileKind::WorldCupResearch).await;
    let search_plan = build_search_plan(client, pool, &match_info, input.query.as_deref()).await;
    let search_plan_json = serde_json::to_string(&search_plan)?;

    let run_id = sqlx::query(
        r#"
        INSERT INTO worldcup_research_runs (
            match_id, trigger_type, research_model_profile, search_plan_json,
            status, started_at, evidence_bundle_hash, estimated_cost, actual_cost
        )
        VALUES (?, ?, ?, ?, 'running', ?, '', 0, 0)
        "#,
    )
    .bind(input.match_id)
    .bind(&trigger_type)
    .bind(serde_json::to_string(&model_profile)?)
    .bind(&search_plan_json)
    .bind(&started_at)
    .execute(pool)
    .await?
    .last_insert_rowid();

    let mut evidence = collect_evidence(client, &match_info, &search_plan).await;
    if evidence.is_empty() {
        evidence.push(build_local_schedule_evidence(&match_info));
    }

    let mut accepted_ids = Vec::new();
    let mut rejected_ids = Vec::new();
    let mut accepted_titles = Vec::new();
    let mut rejected_titles = Vec::new();
    for item in evidence {
        let rule_check = local_rule_check(&item);
        let item_title = item.title.clone();
        let audit_status = if rule_check.accepted {
            "accepted"
        } else {
            "pending"
        };
        let id = sqlx::query(
            r#"
            INSERT INTO worldcup_evidence_items (
                research_run_id, match_id, category, source_level, source_name, url,
                title, published_at, fetched_at, extracted_json, raw_hash,
                credibility, rule_check_json, accepted_by_rule, audit_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(run_id)
        .bind(input.match_id)
        .bind(&item.category)
        .bind(&item.source_level)
        .bind(&item.source_name)
        .bind(&item.url)
        .bind(&item.title)
        .bind(&item.published_at)
        .bind(&item.fetched_at)
        .bind(serde_json::to_string(&item.extracted_json)?)
        .bind(hash_text(&format!("{}{}{}", item.url, item.title, item.extracted_json)))
        .bind(rule_check.credibility)
        .bind(serde_json::to_string(&rule_check.as_json())?)
        .bind(if rule_check.accepted { 1 } else { 0 })
        .bind(audit_status)
        .execute(pool)
        .await?
        .last_insert_rowid();
        if rule_check.accepted {
            accepted_ids.push(id);
            accepted_titles.push(item_title);
        } else {
            rejected_ids.push(id);
            rejected_titles.push(item_title);
        }
    }

    let accepted_json = serde_json::to_string(&accepted_ids)?;
    let rejected_json = serde_json::to_string(&rejected_ids)?;
    let local_audit_markdown = format!(
        "### 来源审查\n已通过本地硬规则审查 {} 条，待核验 {} 条。高影响字段仍需以官方或高可信来源为准。",
        accepted_ids.len(),
        rejected_ids.len()
    );
    let audit_markdown = try_llm_audit(
        client,
        pool,
        &match_info,
        &accepted_titles,
        &rejected_titles,
    )
    .await
    .unwrap_or(local_audit_markdown);
    sqlx::query(
        r#"
        INSERT INTO worldcup_audit_reports (
            research_run_id, auditor_model_profile, conflicts_json,
            rejected_items_json, accepted_items_json, audit_markdown, created_at
        )
        VALUES (?, ?, '[]', ?, ?, ?, ?)
        "#,
    )
    .bind(run_id)
    .bind(serde_json::to_string(&model_profile)?)
    .bind(rejected_json)
    .bind(accepted_json)
    .bind(&audit_markdown)
    .bind(now_beijing_iso())
    .execute(pool)
    .await?;

    let evidence_bundle_hash = hash_text(&format!("{run_id}:{accepted_ids:?}:{rejected_ids:?}"));
    let completed_at = now_beijing_iso();
    sqlx::query(
        r#"
        UPDATE worldcup_research_runs
        SET status = 'completed', completed_at = ?, evidence_bundle_hash = ?
        WHERE id = ?
        "#,
    )
    .bind(&completed_at)
    .bind(&evidence_bundle_hash)
    .bind(run_id)
    .execute(pool)
    .await?;

    get_research_run(pool, run_id).await
}

pub async fn list_match_evidence(
    pool: &SqlitePool,
    match_id: i64,
) -> AppResult<Vec<EvidenceItemDto>> {
    let rows = sqlx::query(
        r#"
        SELECT *
        FROM worldcup_evidence_items
        WHERE match_id = ?
        ORDER BY id DESC
        LIMIT 80
        "#,
    )
    .bind(match_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(evidence_from_row).collect()
}

pub async fn run_match_prediction(
    pool: &SqlitePool,
    client: &Client,
    input: PredictionInput,
) -> AppResult<PredictionRunDto> {
    let match_info = get_basic_match(pool, input.match_id).await?;
    let research_run_id = match input.research_run_id {
        Some(id) => Some(id),
        None => latest_research_run_id(pool, input.match_id).await?,
    };
    let accepted = accepted_evidence(pool, input.match_id).await?;
    if accepted.is_empty() {
        return Err(AppError::BadResponse(
            "没有审查通过的赛事情报，无法生成正式预测。请先获取赛前情报。".to_string(),
        ));
    }

    let local_probability = local_probability(&match_info, accepted.len() as f64);
    let llm_result = try_llm_prediction(client, pool, &match_info, &accepted, &local_probability).await;
    let (llm_probability, model_profile, prompt_revision, llm_markdown) = match llm_result {
        Ok(value) => value,
        Err(err) => (
            json!({}),
            json!({ "mode": "local_fallback", "reason": err.to_string() }),
            0,
            format!("智能模型不可用，已使用本地基线模拟。原因：{err}"),
        ),
    };
    let final_probability = merge_probabilities(&local_probability, &llm_probability);
    let scoreline_distribution = scoreline_distribution_from_probability(&final_probability);
    let confidence = 0.45 + (accepted.len().min(8) as f64 * 0.04);
    let confidence = confidence.min(0.78);
    let disagreement_score = probability_disagreement(&local_probability, &llm_probability);
    let evidence_bundle_hash = research_run_id
        .map(|id| format!("research:{id}"))
        .unwrap_or_else(|| hash_text(&format!("{:?}", accepted.iter().map(|e| e.id).collect::<Vec<_>>())));
    let analysis_markdown = format!(
        "### 比赛模拟\n{} 对阵 {}\n\n{}\n\n### 概率结论\n胜：{}% · 平：{}% · 负：{}%\n\n### 风险提示\n足球比赛受阵容、临场状态和赔率变化影响，本结果仅为本地分析模拟，不构成购彩建议。",
        match_info.home_team,
        match_info.away_team,
        llm_markdown,
        percent(&final_probability, "home_win"),
        percent(&final_probability, "draw"),
        percent(&final_probability, "away_win")
    );
    let created_at = now_beijing_iso();
    let id = sqlx::query(
        r#"
        INSERT INTO worldcup_prediction_runs (
            match_id, research_run_id, model_profile, prompt_revision, evidence_bundle_hash,
            local_probability, llm_probability, market_probability, final_probability,
            scoreline_distribution, confidence, disagreement_score, analysis_markdown, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(input.match_id)
    .bind(research_run_id)
    .bind(serde_json::to_string(&model_profile)?)
    .bind(prompt_revision)
    .bind(&evidence_bundle_hash)
    .bind(serde_json::to_string(&local_probability)?)
    .bind(serde_json::to_string(&llm_probability)?)
    .bind(serde_json::to_string(&final_probability)?)
    .bind(serde_json::to_string(&scoreline_distribution)?)
    .bind(confidence)
    .bind(disagreement_score)
    .bind(&analysis_markdown)
    .bind(&created_at)
    .execute(pool)
    .await?
    .last_insert_rowid();

    get_prediction(pool, id).await
}

pub async fn create_worldcup_budget_plan(
    pool: &SqlitePool,
    client: &Client,
    input: BudgetPlanInput,
) -> AppResult<BudgetPlanDto> {
    let prediction_id = match input.prediction_run_id {
        Some(id) => Some(id),
        None => latest_prediction_id(pool, input.match_id).await?,
    };
    let match_info = get_basic_match(pool, input.match_id).await?;
    let prediction = match prediction_id {
        Some(id) => Some(get_prediction(pool, id).await?),
        None => None,
    };
    let budget = input.budget.unwrap_or(100.0).clamp(0.0, 100_000.0);
    let risk_mode = input.risk_mode.unwrap_or_else(|| "balanced".to_string());
    let odds = latest_valid_odds(pool, input.match_id).await?;
    let (planning_mode, odds_snapshot_id, mut plan_json, expected_value, max_loss, status) =
        match odds {
            Some(ref snapshot) if snapshot.source_level == "official" => {
                let allocation = safe_allocation(budget, &risk_mode);
                (
                    "official".to_string(),
                    Some(snapshot.id),
                    json!({
                        "title": "官方体彩赔率预算模拟",
                        "source_level": snapshot.source_level,
                        "source_url": snapshot.source_url,
                        "odds_value": snapshot.odds_value,
                        "selection_code": snapshot.selection_code,
                        "allocation": allocation,
                        "note": "基于官方体彩赔率快照的本地预算模拟，不提供购彩入口。"
                    }),
                    allocation * (snapshot.odds_value - 1.0),
                    allocation,
                    "ready".to_string(),
                )
            }
            Some(ref snapshot) if snapshot.source_level == "verified_mirror" => {
                let allocation = safe_allocation(budget, &risk_mode);
                (
                    "reference_only".to_string(),
                    Some(snapshot.id),
                    json!({
                        "title": "备用参考预算草案",
                        "source_level": snapshot.source_level,
                        "source_url": snapshot.source_url,
                        "odds_value": snapshot.odds_value,
                        "selection_code": snapshot.selection_code,
                        "allocation": allocation,
                        "warning": "非官方源，请以官方实体渠道或官方页面核验为准。"
                    }),
                    0.0,
                    allocation,
                    "reference_only".to_string(),
                )
            }
            _ => (
                "analysis_only".to_string(),
                None,
                json!({
                    "title": "仅赛事分析",
                    "reason": "当前没有可校验的体彩赔率快照，不能输出金额分配。",
                    "budget": budget,
                    "risk_mode": risk_mode
                }),
                0.0,
                0.0,
                "analysis_only".to_string(),
            ),
        };
    let budget_context = BudgetNarrativeContext {
        match_info: &match_info,
        prediction: prediction.as_ref(),
        odds: odds.as_ref(),
        planning_mode: &planning_mode,
        budget,
        risk_mode: &risk_mode,
        expected_value,
        max_loss,
    };
    let (budget_model_profile, narrative_markdown) =
        match try_llm_budget_narrative(client, pool, &budget_context).await {
        Ok(value) => value,
        Err(err) => (
            json!({ "mode": "local_fallback", "reason": err.to_string() }),
            local_budget_narrative(&budget_context),
        ),
    };
    if let Some(object) = plan_json.as_object_mut() {
        object.insert(
            "narrative_markdown".to_string(),
            serde_json::Value::String(narrative_markdown),
        );
        object.insert("model_profile".to_string(), budget_model_profile);
    }
    let created_at = now_beijing_iso();
    let id = sqlx::query(
        r#"
        INSERT INTO worldcup_betting_plans (
            match_id, prediction_run_id, odds_snapshot_id, planning_mode, budget,
            risk_mode, plan_json, expected_value, max_loss, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(input.match_id)
    .bind(prediction_id)
    .bind(odds_snapshot_id)
    .bind(&planning_mode)
    .bind(budget)
    .bind(&risk_mode)
    .bind(serde_json::to_string(&plan_json)?)
    .bind(expected_value)
    .bind(max_loss)
    .bind(&status)
    .bind(&created_at)
    .execute(pool)
    .await?
    .last_insert_rowid();
    get_budget_plan(pool, id).await
}

pub async fn sync_sporttery_worldcup_odds(
    pool: &SqlitePool,
    client: &Client,
) -> AppResult<OddsSyncSummary> {
    let fetched_at = now_beijing_iso();
    match client.get(SPORTTERY_HOME_URL).send().await {
        Ok(response) if response.status().is_success() => {
            let text = response.text().await.unwrap_or_default();
            let has_worldcup = text.contains("世界杯") || text.contains("世俱杯");
            let status = if has_worldcup { "available" } else { "no_worldcup_events" };
            let message = if has_worldcup {
                "竞彩网可访问，页面包含世界杯相关关键词；需进一步映射具体竞彩场次。"
            } else {
                "竞彩网可访问，但当前未识别到世界杯竞彩场次；预算模拟将保持 analysis_only。"
            };
            insert_source_health(
                pool,
                SourceHealthInsert {
                    source_name: "中国竞彩网",
                    source_level: "official",
                    status,
                    message,
                    source_url: Some(SPORTTERY_HOME_URL),
                    field_coverage: if has_worldcup { 0.6 } else { 0.3 },
                    failure_rate: 0.0,
                    recommended_refresh_seconds: 300,
                },
            )
            .await?;
            Ok(OddsSyncSummary {
                source_name: "中国竞彩网".to_string(),
                source_level: "official".to_string(),
                status: status.to_string(),
                message: message.to_string(),
                events_found: 0,
                odds_found: 0,
                fetched_at,
            })
        }
        Ok(response) => {
            let status_code = response.status();
            let message = format!("竞彩网访问失败：HTTP {status_code}");
            insert_source_health(
                pool,
                SourceHealthInsert {
                    source_name: "中国竞彩网",
                    source_level: "official",
                    status: "failed",
                    message: &message,
                    source_url: Some(SPORTTERY_HOME_URL),
                    field_coverage: 0.0,
                    failure_rate: 1.0,
                    recommended_refresh_seconds: 900,
                },
            )
            .await?;
            Ok(OddsSyncSummary {
                source_name: "中国竞彩网".to_string(),
                source_level: "official".to_string(),
                status: "failed".to_string(),
                message,
                events_found: 0,
                odds_found: 0,
                fetched_at,
            })
        }
        Err(err) => {
            let message = format!("竞彩网访问失败：{err}");
            insert_source_health(
                pool,
                SourceHealthInsert {
                    source_name: "中国竞彩网",
                    source_level: "official",
                    status: "failed",
                    message: &message,
                    source_url: Some(SPORTTERY_HOME_URL),
                    field_coverage: 0.0,
                    failure_rate: 1.0,
                    recommended_refresh_seconds: 900,
                },
            )
            .await?;
            Ok(OddsSyncSummary {
                source_name: "中国竞彩网".to_string(),
                source_level: "official".to_string(),
                status: "failed".to_string(),
                message,
                events_found: 0,
                odds_found: 0,
                fetched_at,
            })
        }
    }
}

pub async fn sync_reference_odds_sources(pool: &SqlitePool) -> AppResult<OddsSyncSummary> {
    let fetched_at = now_beijing_iso();
    let message = "尚未配置第三方体彩镜像源；备用参考赔率不可用。";
    insert_source_health(
        pool,
        SourceHealthInsert {
            source_name: "第三方体彩镜像源",
            source_level: "verified_mirror",
            status: "not_configured",
            message,
            source_url: None,
            field_coverage: 0.0,
            failure_rate: 0.0,
            recommended_refresh_seconds: 900,
        },
    )
    .await?;
    Ok(OddsSyncSummary {
        source_name: "第三方体彩镜像源".to_string(),
        source_level: "verified_mirror".to_string(),
        status: "not_configured".to_string(),
        message: message.to_string(),
        events_found: 0,
        odds_found: 0,
        fetched_at,
    })
}

pub async fn list_worldcup_source_health(
    pool: &SqlitePool,
    limit: i64,
) -> AppResult<Vec<SourceHealthDto>> {
    let rows = sqlx::query(
        r#"
        SELECT *
        FROM worldcup_source_health
        ORDER BY id DESC
        LIMIT ?
        "#,
    )
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(source_health_from_row).collect()
}

pub async fn list_worldcup_queue_jobs(
    pool: &SqlitePool,
    limit: i64,
) -> AppResult<Vec<QueueJobDto>> {
    let rows = sqlx::query(
        r#"
        SELECT *
        FROM worldcup_queue_jobs
        ORDER BY id DESC
        LIMIT ?
        "#,
    )
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(queue_job_from_row).collect()
}

pub async fn cancel_worldcup_queue_job(pool: &SqlitePool, job_id: i64) -> AppResult<bool> {
    let now = now_beijing_iso();
    let result = sqlx::query(
        r#"
        UPDATE worldcup_queue_jobs
        SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND status IN ('pending', 'running')
        "#,
    )
    .bind(now)
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

struct SourceHealthInsert<'a> {
    source_name: &'a str,
    source_level: &'a str,
    status: &'a str,
    message: &'a str,
    source_url: Option<&'a str>,
    field_coverage: f64,
    failure_rate: f64,
    recommended_refresh_seconds: i64,
}

async fn insert_source_health(
    pool: &SqlitePool,
    input: SourceHealthInsert<'_>,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO worldcup_source_health (
            source_name, source_level, status, message, source_url, fetched_at,
            field_coverage, failure_rate, recommended_refresh_seconds
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(input.source_name)
    .bind(input.source_level)
    .bind(input.status)
    .bind(input.message)
    .bind(input.source_url)
    .bind(now_beijing_iso())
    .bind(input.field_coverage)
    .bind(input.failure_rate)
    .bind(input.recommended_refresh_seconds)
    .execute(pool)
    .await?;
    Ok(())
}

async fn fetch_fifa_calendar_schedule(client: &Client) -> AppResult<Vec<SeedMatch>> {
    let payload: serde_json::Value = client
        .get(FIFA_CALENDAR_API_URL)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let results = payload
        .get("Results")
        .and_then(|value| value.as_array())
        .ok_or_else(|| AppError::BadResponse("FIFA 赛程 API 缺少 Results 字段。".to_string()))?;
    let mut out = Vec::with_capacity(results.len());
    for item in results {
        out.push(parse_fifa_calendar_match(item)?);
    }
    out.sort_by_key(|item| item.match_no);
    out.dedup_by_key(|item| item.match_no);
    Ok(out)
}

fn parse_fifa_calendar_match(item: &serde_json::Value) -> AppResult<SeedMatch> {
    let match_no = value_i64(item, "MatchNumber").ok_or_else(|| {
        AppError::BadResponse("FIFA 赛程条目缺少 MatchNumber。".to_string())
    })?;
    let id_match = value_str(item, "IdMatch").ok_or_else(|| {
        AppError::BadResponse(format!("FIFA 第 {match_no} 场缺少 IdMatch。"))
    })?;
    let kickoff_utc = value_str(item, "Date").ok_or_else(|| {
        AppError::BadResponse(format!("FIFA 第 {match_no} 场缺少 Date。"))
    })?;
    let kickoff = DateTime::parse_from_rfc3339(kickoff_utc).map_err(|err| {
        AppError::BadResponse(format!("FIFA 第 {match_no} 场 Date 无法解析：{err}"))
    })?;
    let raw_stage =
        localized_description(item.get("StageName")).unwrap_or_else(|| "未公布阶段".to_string());
    let stage = translate_stage(&raw_stage);
    let group_name = localized_description(item.get("GroupName")).map(|group| translate_group(&group));
    let stadium = item.get("Stadium").unwrap_or(&serde_json::Value::Null);
    let venue = localized_description(stadium.get("Name")).unwrap_or_else(|| "未公布场馆".to_string());
    let city = localized_description(stadium.get("CityName")).unwrap_or_else(|| "未公布城市".to_string());
    let country = value_str(stadium, "IdCountry")
        .map(country_name)
        .unwrap_or_else(|| "未公布国家".to_string());
    let home_team = team_name_or_placeholder(item.get("Home"), item.get("PlaceHolderA"));
    let away_team = team_name_or_placeholder(item.get("Away"), item.get("PlaceHolderB"));
    let id_competition = value_str(item, "IdCompetition").unwrap_or("17");
    let id_season = value_str(item, "IdSeason").unwrap_or("285023");
    let id_stage = value_str(item, "IdStage").unwrap_or("289273");

    Ok(SeedMatch {
        match_no,
        stage,
        group_name,
        home_team,
        away_team,
        kickoff_utc: kickoff.to_rfc3339(),
        kickoff_beijing: format!(
            "{}+08:00",
            (kickoff + Duration::hours(8)).format("%Y-%m-%dT%H:%M:%S")
        ),
        venue,
        city,
        country,
        source_url: format!(
            "https://www.fifa.com/en/match-centre/match/{id_competition}/{id_season}/{id_stage}/{id_match}"
        ),
    })
}

fn value_str<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|item| item.as_str())
}

fn value_i64(value: &serde_json::Value, key: &str) -> Option<i64> {
    value
        .get(key)
        .and_then(|item| item.as_i64().or_else(|| item.as_str()?.parse::<i64>().ok()))
}

fn localized_description(value: Option<&serde_json::Value>) -> Option<String> {
    value?
        .as_array()?
        .iter()
        .find_map(|item| value_str(item, "Description"))
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn team_name_or_placeholder(
    team: Option<&serde_json::Value>,
    placeholder: Option<&serde_json::Value>,
) -> String {
    team
        .and_then(|value| localized_description(value.get("TeamName")))
        .map(|value| translate_team_name(&value))
        .or_else(|| {
            team.and_then(|value| value_str(value, "ShortClubName"))
                .filter(|value| !value.trim().is_empty())
                .map(translate_team_name)
        })
        .or_else(|| placeholder.and_then(|value| value.as_str()).map(format_placeholder))
        .unwrap_or_else(|| "待官方确认".to_string())
}

fn format_placeholder(raw: &str) -> String {
    let value = raw.trim();
    if let Some(rest) = value.strip_prefix('W') {
        if rest.chars().all(|ch| ch.is_ascii_digit()) {
            return format!("第 {rest} 场胜者");
        }
    }
    if let Some(rest) = value.strip_prefix('L') {
        if rest.chars().all(|ch| ch.is_ascii_digit()) {
            return format!("第 {rest} 场负者");
        }
    }
    let mut chars = value.chars();
    if let Some(rank) = chars.next().filter(|ch| matches!(ch, '1' | '2' | '3')) {
        let groups: String = chars.collect();
        if !groups.is_empty() && groups.chars().all(|ch| ch.is_ascii_uppercase()) {
            let rank_text = match rank {
                '1' => "第 1 名",
                '2' => "第 2 名",
                _ => "第 3 名",
            };
            let group_text = groups
                .chars()
                .map(|ch| format!("{ch} 组"))
                .collect::<Vec<_>>()
                .join("/");
            return format!("{group_text}{rank_text}");
        }
    }
    value.to_string()
}

fn translate_stage(stage: &str) -> String {
    match stage {
        "First Stage" => "小组赛",
        "第一阶段" => "小组赛",
        "Round of 32" => "32 强",
        "32强赛" => "32 强",
        "Round of 16" => "16 强",
        "Quarter-final" => "8 强",
        "四分之一决赛" => "8 强",
        "Semi-final" => "半决赛",
        "Play-off for third place" => "季军赛",
        "第三名淘汰赛" => "季军赛",
        "Final" => "决赛",
        other => other,
    }
    .to_string()
}

fn translate_group(group: &str) -> String {
    group
        .strip_prefix("Group ")
        .map(|name| format!("{name} 组"))
        .unwrap_or_else(|| group.to_string())
}

fn country_name(code: &str) -> String {
    match code {
        "CAN" => "加拿大",
        "MEX" => "墨西哥",
        "USA" => "美国",
        other => other,
    }
    .to_string()
}

fn translate_team_name(name: &str) -> String {
    match name.trim() {
        "Algeria" => "阿尔及利亚",
        "Argentina" => "阿根廷",
        "Australia" => "澳大利亚",
        "Austria" => "奥地利",
        "Belgium" => "比利时",
        "Bosnia and Herzegovina" => "波斯尼亚和黑塞哥维那",
        "Brazil" => "巴西",
        "Cabo Verde" => "佛得角",
        "Canada" => "加拿大",
        "Colombia" => "哥伦比亚",
        "Congo DR" => "刚果民主共和国",
        "Côte d'Ivoire" => "科特迪瓦",
        "Croatia" => "克罗地亚",
        "Curaçao" => "库拉索",
        "Czechia" => "捷克",
        "Ecuador" => "厄瓜多尔",
        "Egypt" => "埃及",
        "England" => "英格兰",
        "France" => "法国",
        "Germany" => "德国",
        "Ghana" => "加纳",
        "Haiti" => "海地",
        "IR Iran" => "伊朗",
        "Iraq" => "伊拉克",
        "Japan" => "日本",
        "Jordan" => "约旦",
        "Korea Republic" => "韩国",
        "Mexico" => "墨西哥",
        "Morocco" => "摩洛哥",
        "Netherlands" => "荷兰",
        "New Zealand" => "新西兰",
        "Norway" => "挪威",
        "Panama" => "巴拿马",
        "Paraguay" => "巴拉圭",
        "Portugal" => "葡萄牙",
        "Qatar" => "卡塔尔",
        "Saudi Arabia" => "沙特阿拉伯",
        "Scotland" => "苏格兰",
        "Senegal" => "塞内加尔",
        "South Africa" => "南非",
        "Spain" => "西班牙",
        "Sweden" => "瑞典",
        "Switzerland" => "瑞士",
        "Tunisia" => "突尼斯",
        "Türkiye" | "Turkey" => "土耳其",
        "Uruguay" => "乌拉圭",
        "USA" | "United States" => "美国",
        "Uzbekistan" => "乌兹别克斯坦",
        other => other,
    }
    .to_string()
}

#[derive(Debug, Clone)]
struct BasicMatch {
    match_no: i64,
    stage: String,
    group_name: Option<String>,
    home_team: String,
    away_team: String,
    kickoff_beijing: String,
    venue: String,
    city: String,
    source_url: String,
}

#[derive(Debug, Clone)]
struct EvidenceDraft {
    category: String,
    source_level: String,
    source_name: String,
    url: String,
    title: String,
    published_at: Option<String>,
    fetched_at: String,
    extracted_json: serde_json::Value,
}

#[derive(Debug, Clone)]
struct RuleCheck {
    accepted: bool,
    credibility: f64,
    reasons: Vec<String>,
}

impl RuleCheck {
    fn as_json(&self) -> serde_json::Value {
        json!({
            "accepted": self.accepted,
            "credibility": self.credibility,
            "reasons": self.reasons,
        })
    }
}

#[derive(Debug, Clone)]
struct OddsSnapshot {
    id: i64,
    source_level: String,
    source_url: String,
    selection_code: String,
    odds_value: f64,
}

struct BudgetNarrativeContext<'a> {
    match_info: &'a BasicMatch,
    prediction: Option<&'a PredictionRunDto>,
    odds: Option<&'a OddsSnapshot>,
    planning_mode: &'a str,
    budget: f64,
    risk_mode: &'a str,
    expected_value: f64,
    max_loss: f64,
}

async fn get_basic_match(pool: &SqlitePool, match_id: i64) -> AppResult<BasicMatch> {
    let row = sqlx::query(
        r#"
        SELECT id, match_no, stage, group_name, home_team, away_team,
               kickoff_beijing, venue, city, source_url
        FROM worldcup_matches
        WHERE id = ?
        "#,
    )
    .bind(match_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::BadResponse("未找到世界杯比赛。".to_string()))?;
    Ok(BasicMatch {
        match_no: row.try_get("match_no")?,
        stage: row.try_get("stage")?,
        group_name: row.try_get("group_name")?,
        home_team: translate_team_name(&row.try_get::<String, _>("home_team")?),
        away_team: translate_team_name(&row.try_get::<String, _>("away_team")?),
        kickoff_beijing: row.try_get("kickoff_beijing")?,
        venue: row.try_get("venue")?,
        city: row.try_get("city")?,
        source_url: row.try_get("source_url")?,
    })
}

async fn resolve_model_profile(pool: &SqlitePool, kind: LlmProfileKind) -> serde_json::Value {
    match resolve_llm_config_for(pool, kind).await {
        Ok(config) => json!({
            "provider": config.provider,
            "base_url": config.base_url,
            "model": config.model,
            "has_api_key": !config.api_key.trim().is_empty(),
        }),
        Err(err) => json!({
            "mode": "unconfigured",
            "error": err.to_string(),
        }),
    }
}

async fn build_search_plan(
    client: &Client,
    pool: &SqlitePool,
    match_info: &BasicMatch,
    user_query: Option<&str>,
) -> serde_json::Value {
    let fallback = json!({
        "mode": "local",
        "queries": [
            format!("{} {} World Cup 2026 lineup injury coach", match_info.home_team, match_info.away_team),
            format!("{} {} FIFA World Cup 2026 match preview", match_info.home_team, match_info.away_team),
            format!("{} {} 中国体育彩票 竞彩足球 赔率", match_info.home_team, match_info.away_team)
        ],
        "user_query": user_query.unwrap_or("")
    });
    let Ok(config) = resolve_llm_config_for(pool, LlmProfileKind::WorldCupResearch).await else {
        return fallback;
    };
    if llm::requires_api_key(&config) && config.api_key.trim().is_empty() {
        return fallback;
    }
    let prompt = format!(
        "请为世界杯比赛生成联网搜索计划，只输出 JSON。比赛：{} 对阵 {}，时间：{}，地点：{}。用户补充：{}。字段包含 queries、priority_sources、risk_fields。",
        match_info.home_team,
        match_info.away_team,
        match_info.kickoff_beijing,
        match_info.city,
        user_query.unwrap_or("无")
    );
    match llm::chat_once(
        client,
        &config,
        &[ChatMessage {
            role: "user".to_string(),
            content: prompt,
        }],
    )
    .await
    {
        Ok(reply) => json!({
            "mode": "llm",
            "model": config.model,
            "raw": reply,
            "fallback_queries": fallback["queries"].clone(),
        }),
        Err(err) => json!({
            "mode": "local_after_llm_error",
            "error": err.to_string(),
            "queries": fallback["queries"].clone(),
        }),
    }
}

async fn collect_evidence(
    client: &Client,
    match_info: &BasicMatch,
    search_plan: &serde_json::Value,
) -> Vec<EvidenceDraft> {
    let mut out = Vec::new();
    if let Some(item) = fetch_evidence(
        client,
        "schedule",
        "official",
        "FIFA 官方赛程",
        FIFA_SCHEDULE_URL,
        json!({
            "match_no": match_info.match_no,
            "home_team": match_info.home_team,
            "away_team": match_info.away_team,
            "kickoff_beijing": match_info.kickoff_beijing,
            "venue": match_info.venue,
            "city": match_info.city
        }),
    )
    .await
    {
        out.push(item);
    } else {
        out.push(build_local_schedule_evidence(match_info));
    }
    if let Some(item) = fetch_evidence(
        client,
        "odds_source",
        "official",
        "中国竞彩网",
        SPORTTERY_HOME_URL,
        json!({
            "purpose": "official_sporttery_source_probe",
            "planning_mode_if_missing": "analysis_only"
        }),
    )
    .await
    {
        out.push(item);
    }
    if let Some(item) = fetch_evidence(
        client,
        "sporttery_notice",
        "official",
        "中国竞彩网传统足彩公告样例",
        SPORTTERY_NOTICE_URL,
        json!({
            "purpose": "field_mapping_reference",
            "fields": ["issue_no", "sale_start_at", "sale_stop_at", "draw_date"]
        }),
    )
    .await
    {
        out.push(item);
    }
    for query in search_queries_from_plan(search_plan).into_iter().take(2) {
        if let Some(item) = fetch_search_result_page(client, &query).await {
            out.push(item);
        } else {
            out.push(EvidenceDraft {
                category: "search_plan".to_string(),
                source_level: "market_reference".to_string(),
                source_name: "本地搜索计划".to_string(),
                url: format!("local://search-plan/{}", hash_text(&query)),
                title: query.clone(),
                published_at: None,
                fetched_at: now_beijing_iso(),
                extracted_json: json!({
                    "query": query,
                    "note": "搜索页面本次不可访问，保留为待执行搜索计划。"
                }),
            });
        }
    }
    out
}

fn search_queries_from_plan(search_plan: &serde_json::Value) -> Vec<String> {
    for key in ["queries", "fallback_queries"] {
        if let Some(values) = search_plan.get(key).and_then(|v| v.as_array()) {
            let queries: Vec<String> = values
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(ToString::to_string)
                .collect();
            if !queries.is_empty() {
                return queries;
            }
        }
    }
    Vec::new()
}

async fn fetch_search_result_page(client: &Client, query: &str) -> Option<EvidenceDraft> {
    let encoded = encode_query(query);
    let url = format!("https://duckduckgo.com/html/?q={encoded}");
    let response = client.get(&url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().await.ok()?;
    Some(EvidenceDraft {
        category: "web_search".to_string(),
        source_level: "market_reference".to_string(),
        source_name: "DuckDuckGo 搜索页".to_string(),
        url,
        title: format!("搜索：{query}"),
        published_at: None,
        fetched_at: now_beijing_iso(),
        extracted_json: json!({
            "query": query,
            "summary": compact_text(&strip_tags(&text), 1200),
            "note": "搜索页结果为待核验证据，不能直接作为预测硬证据。"
        }),
    })
}

async fn fetch_evidence(
    client: &Client,
    category: &str,
    source_level: &str,
    source_name: &str,
    url: &str,
    extracted_json: serde_json::Value,
) -> Option<EvidenceDraft> {
    let Ok(response) = client.get(url).send().await else {
        return None;
    };
    if !response.status().is_success() {
        return None;
    }
    let Ok(text) = response.text().await else {
        return None;
    };
    Some(EvidenceDraft {
        category: category.to_string(),
        source_level: source_level.to_string(),
        source_name: source_name.to_string(),
        url: url.to_string(),
        title: html_title(&text).unwrap_or_else(|| source_name.to_string()),
        published_at: None,
        fetched_at: now_beijing_iso(),
        extracted_json: json!({
            "summary": compact_text(&strip_tags(&text), 800),
            "metadata": extracted_json
        }),
    })
}

fn build_local_schedule_evidence(match_info: &BasicMatch) -> EvidenceDraft {
    EvidenceDraft {
        category: "schedule".to_string(),
        source_level: "official".to_string(),
        source_name: "FIFA 官方赛程 API".to_string(),
        url: match_info.source_url.clone(),
        title: format!(
            "第 {} 场 {} 对阵 {}",
            match_info.match_no, match_info.home_team, match_info.away_team
        ),
        published_at: None,
        fetched_at: now_beijing_iso(),
        extracted_json: json!({
            "match_no": match_info.match_no,
            "stage": match_info.stage,
            "group_name": match_info.group_name,
            "home_team": match_info.home_team,
            "away_team": match_info.away_team,
            "kickoff_beijing": match_info.kickoff_beijing,
            "venue": match_info.venue,
            "city": match_info.city
        }),
    }
}

fn local_rule_check(item: &EvidenceDraft) -> RuleCheck {
    let mut reasons = Vec::new();
    let mut accepted = true;
    if item.url.trim().is_empty() {
        accepted = false;
        reasons.push("URL 为空".to_string());
    }
    if item.source_level == "market_reference" {
        accepted = false;
        reasons.push("市场参考源不能直接进入预测硬证据".to_string());
    }
    if item.category == "odds_source" && item.source_level != "official" {
        accepted = false;
        reasons.push("赔率源不是官方源".to_string());
    }
    if !["official", "verified_mirror", "market_reference"].contains(&item.source_level.as_str()) {
        accepted = false;
        reasons.push("来源等级无效".to_string());
    }
    if accepted {
        reasons.push("本地硬规则通过".to_string());
    }
    let credibility = match item.source_level.as_str() {
        "official" if accepted => 0.95,
        "verified_mirror" if accepted => 0.72,
        "market_reference" => 0.35,
        _ => 0.2,
    };
    RuleCheck {
        accepted,
        credibility,
        reasons,
    }
}

async fn get_research_run(pool: &SqlitePool, id: i64) -> AppResult<ResearchRunDto> {
    let row = sqlx::query(
        r#"
        SELECT r.*,
               COALESCE(COUNT(e.id), 0) AS evidence_count,
               COALESCE(SUM(CASE WHEN e.audit_status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count
        FROM worldcup_research_runs r
        LEFT JOIN worldcup_evidence_items e ON e.research_run_id = r.id
        WHERE r.id = ?
        GROUP BY r.id
        "#,
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    research_run_from_row(row)
}

async fn latest_research_run_id(pool: &SqlitePool, match_id: i64) -> AppResult<Option<i64>> {
    let row = sqlx::query(
        "SELECT id FROM worldcup_research_runs WHERE match_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
    )
    .bind(match_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.try_get("id")).transpose()?)
}

async fn accepted_evidence(pool: &SqlitePool, match_id: i64) -> AppResult<Vec<EvidenceItemDto>> {
    let rows = sqlx::query(
        "SELECT * FROM worldcup_evidence_items WHERE match_id = ? AND audit_status = 'accepted' ORDER BY id DESC LIMIT 40",
    )
    .bind(match_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(evidence_from_row).collect()
}

fn local_probability(match_info: &BasicMatch, evidence_count: f64) -> serde_json::Value {
    let stage_bias = if match_info.stage == "小组赛" { 0.02 } else { 0.0 };
    let evidence_bias = (evidence_count.min(10.0) - 2.0).max(0.0) * 0.003;
    let home = 0.36 + stage_bias + evidence_bias;
    let draw = if match_info.stage == "小组赛" { 0.30 } else { 0.27 };
    let away = (1.0_f64 - home - draw).max(0.15);
    normalize_probability(home, draw, away)
}

async fn try_llm_prediction(
    client: &Client,
    pool: &SqlitePool,
    match_info: &BasicMatch,
    evidence: &[EvidenceItemDto],
    local_probability: &serde_json::Value,
) -> AppResult<(serde_json::Value, serde_json::Value, i64, String)> {
    let config = resolve_llm_config_for(pool, LlmProfileKind::WorldCupPrediction).await?;
    if llm::requires_api_key(&config) && config.api_key.trim().is_empty() {
        return Err(AppError::Config("LLM API Key 未配置".to_string()));
    }
    let prompts = list_prompts(pool).await?;
    let prompt = prompts
        .iter()
        .find(|p| p.role_name == "simulation_modeler")
        .or_else(|| prompts.iter().find(|p| p.role_name == "football_analyst"));
    let system = prompt
        .map(|p| p.content.clone())
        .unwrap_or_else(|| "你是足球比赛模拟分析师。只能基于给定情报输出保守概率分析。".to_string());
    let prompt_revision = prompt.map(|p| p.prompt_revision).unwrap_or(0);
    let evidence_summary = evidence
        .iter()
        .take(8)
        .map(|item| format!("- [{}] {} {}", item.source_level, item.source_name, item.title))
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "比赛：{} 对阵 {}\n阶段：{}\n时间：{}\n地点：{} {}\n本地基线概率：{}\n已审查情报：\n{}\n\n请输出中文 Markdown 分析，按「综合判断、关键依据、比分倾向、风险边界」组织。不要输出代码块。最后单独一行写机器可读概率数据：{{\"home_win\":0.38,\"draw\":0.29,\"away_win\":0.33}}。不要承诺命中。",
        match_info.home_team,
        match_info.away_team,
        match_info.stage,
        match_info.kickoff_beijing,
        match_info.city,
        match_info.venue,
        local_probability,
        evidence_summary
    );
    let reply = llm::chat_once(
        client,
        &config,
        &[
            ChatMessage {
                role: "system".to_string(),
                content: system,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user,
            },
        ],
    )
    .await?;
    let probability = extract_probability_json(&reply).unwrap_or_else(|| json!({}));
    Ok((
        probability,
        json!({
            "provider": config.provider,
            "base_url": config.base_url,
            "model": config.model,
        }),
        prompt_revision,
        strip_machine_probability(&reply),
    ))
}

async fn try_llm_audit(
    client: &Client,
    pool: &SqlitePool,
    match_info: &BasicMatch,
    accepted_titles: &[String],
    rejected_titles: &[String],
) -> AppResult<String> {
    let config = resolve_llm_config_for(pool, LlmProfileKind::WorldCupResearch).await?;
    if llm::requires_api_key(&config) && config.api_key.trim().is_empty() {
        return Err(AppError::Config("LLM API Key 未配置".to_string()));
    }
    let prompts = list_prompts(pool).await?;
    let system = prompts
        .iter()
        .find(|p| p.role_name == "source_auditor")
        .map(|p| p.content.clone())
        .unwrap_or_else(|| {
            "你是赛事情报来源审查员。你只能审查语义可信度，不能覆盖本地硬规则。".to_string()
        });
    let user = format!(
        "比赛：{} 对阵 {}\n本地硬规则已通过：\n{}\n\n待核验或拒绝：\n{}\n\n请用中文 Markdown 输出来源审查结论，指出仍需人工核验的高影响字段。",
        match_info.home_team,
        match_info.away_team,
        accepted_titles
            .iter()
            .map(|title| format!("- {title}"))
            .collect::<Vec<_>>()
            .join("\n"),
        rejected_titles
            .iter()
            .map(|title| format!("- {title}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    llm::chat_once(
        client,
        &config,
        &[
            ChatMessage {
                role: "system".to_string(),
                content: system,
            },
            ChatMessage {
                role: "user".to_string(),
                content: user,
            },
        ],
    )
    .await
}

async fn try_llm_budget_narrative(
    client: &Client,
    pool: &SqlitePool,
    context: &BudgetNarrativeContext<'_>,
) -> AppResult<(serde_json::Value, String)> {
    let config = resolve_llm_config_for(pool, LlmProfileKind::WorldCupBudget).await?;
    if llm::requires_api_key(&config) && config.api_key.trim().is_empty() {
        return Err(AppError::Config("预算模拟 LLM API Key 未配置".to_string()));
    }
    let prompts = list_prompts(pool).await?;
    let odds_planner = prompts
        .iter()
        .find(|p| p.role_name == "odds_planner")
        .map(|p| p.content.clone())
        .unwrap_or_else(|| {
            "你是体彩赔率预算模拟师。必须遵守 planning_mode，不提供购彩、代购、出票或支付指引。"
                .to_string()
        });
    let risk_controller = prompts
        .iter()
        .find(|p| p.role_name == "risk_controller")
        .map(|p| p.content.clone())
        .unwrap_or_else(|| "你是风险控制审查员。禁止输出稳赚必中或购彩指引。".to_string());
    let probability = context
        .prediction
        .map(|item| item.final_probability.to_string())
        .unwrap_or_else(|| "未生成比赛模拟".to_string());
    let odds_summary = context
        .odds
        .map(|item| {
            format!(
                "来源等级：{}；选择：{}；赔率：{}；来源：{}",
                item.source_level, item.selection_code, item.odds_value, item.source_url
            )
        })
        .unwrap_or_else(|| "暂无可校验赔率快照".to_string());
    let user = format!(
        "比赛：{} 对阵 {}\n阶段：{}\n时间：{}\nplanning_mode：{}\n预算：{}\n风险偏好：{}\n当前期望收益估算：{}\n最大亏损估算：{}\n预测概率：{}\n赔率状态：{}\n\n请输出面向用户的中文说明，分为「状态判断」「预算边界」「风险提示」三段。不要输出 JSON、代码块、投注链接、购彩指引或必中承诺。",
        context.match_info.home_team,
        context.match_info.away_team,
        context.match_info.stage,
        context.match_info.kickoff_beijing,
        context.planning_mode,
        round2(context.budget),
        risk_mode_label(context.risk_mode),
        round2(context.expected_value),
        round2(context.max_loss),
        probability,
        odds_summary
    );
    let reply = llm::chat_once(
        client,
        &config,
        &[
            ChatMessage {
                role: "system".to_string(),
                content: format!("{odds_planner}\n\n{risk_controller}"),
            },
            ChatMessage {
                role: "user".to_string(),
                content: user,
            },
        ],
    )
    .await?;
    Ok((
        json!({
            "provider": config.provider,
            "base_url": config.base_url,
            "model": config.model,
        }),
        strip_machine_probability(&reply),
    ))
}

fn local_budget_narrative(context: &BudgetNarrativeContext<'_>) -> String {
    let probability = context
        .prediction
        .map(|item| {
            format!(
                "当前模拟概率为主胜 {}%、平局 {}%、客胜 {}%。",
                percent(&item.final_probability, "home_win"),
                percent(&item.final_probability, "draw"),
                percent(&item.final_probability, "away_win")
            )
        })
        .unwrap_or_else(|| "当前还没有可引用的比赛模拟。".to_string());
    let source = context
        .odds
        .map(|item| {
            format!(
                "已读取到 {} 来源的赔率快照，选择项为 {}，赔率为 {}。",
                source_level_text(&item.source_level),
                item.selection_code,
                item.odds_value
            )
        })
        .unwrap_or_else(|| "当前没有可校验的体彩赔率快照。".to_string());
    let boundary = match context.planning_mode {
        "official" => format!(
            "在 {} 风险偏好下，本地预算模拟金额为 {}，估算最大亏损 {}，期望收益估算 {}。",
            risk_mode_label(context.risk_mode),
            round2(context.budget),
            round2(context.max_loss),
            round2(context.expected_value)
        ),
        "reference_only" => format!(
            "当前只能生成备用参考草案，预算 {} 不应直接作为执行依据，必须回到官方渠道核验。",
            round2(context.budget)
        ),
        _ => "由于缺少可校验官方赔率，本场仅保留赛事分析，不输出金额分配。".to_string(),
    };
    format!(
        "### 状态判断\n{} 对阵 {}。{} {}\n\n### 预算边界\n{}\n\n### 风险提示\n足球赛果受阵容、伤停、临场状态和赔率变化影响，本模拟不构成购彩建议。",
        context.match_info.home_team,
        context.match_info.away_team,
        source,
        probability,
        boundary
    )
}

fn risk_mode_label(value: &str) -> &'static str {
    match value {
        "conservative" => "保守",
        "aggressive" => "激进",
        _ => "平衡",
    }
}

fn source_level_text(value: &str) -> &'static str {
    match value {
        "official" => "官方",
        "verified_mirror" => "备用参考",
        "market_reference" => "市场参考",
        _ => "未知",
    }
}

fn merge_probabilities(local: &serde_json::Value, llm: &serde_json::Value) -> serde_json::Value {
    let lh = number_at(local, "home_win").unwrap_or(0.36);
    let ld = number_at(local, "draw").unwrap_or(0.30);
    let la = number_at(local, "away_win").unwrap_or(0.34);
    let Some(mh) = number_at(llm, "home_win") else {
        return normalize_probability(lh, ld, la);
    };
    let md = number_at(llm, "draw").unwrap_or(ld);
    let ma = number_at(llm, "away_win").unwrap_or(la);
    normalize_probability(lh * 0.55 + mh * 0.45, ld * 0.55 + md * 0.45, la * 0.55 + ma * 0.45)
}

fn normalize_probability(home: f64, draw: f64, away: f64) -> serde_json::Value {
    let total = (home + draw + away).max(0.0001);
    json!({
        "home_win": round4(home / total),
        "draw": round4(draw / total),
        "away_win": round4(away / total),
    })
}

fn scoreline_distribution_from_probability(prob: &serde_json::Value) -> serde_json::Value {
    let home = number_at(prob, "home_win").unwrap_or(0.36);
    let draw = number_at(prob, "draw").unwrap_or(0.30);
    let away = number_at(prob, "away_win").unwrap_or(0.34);
    json!([
        { "score": "1-0", "probability": round4(home * 0.28) },
        { "score": "1-1", "probability": round4(draw * 0.42) },
        { "score": "0-1", "probability": round4(away * 0.28) },
        { "score": "2-1", "probability": round4(home * 0.22) },
        { "score": "0-0", "probability": round4(draw * 0.24) }
    ])
}

fn probability_disagreement(local: &serde_json::Value, llm: &serde_json::Value) -> f64 {
    if llm.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return 0.0;
    }
    let keys = ["home_win", "draw", "away_win"];
    let sum = keys
        .iter()
        .map(|key| {
            (number_at(local, key).unwrap_or(0.0) - number_at(llm, key).unwrap_or(0.0)).abs()
        })
        .sum::<f64>();
    round4(sum / keys.len() as f64)
}

fn extract_probability_json(text: &str) -> Option<serde_json::Value> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let parsed: serde_json::Value = serde_json::from_str(&text[start..=end]).ok()?;
    if number_at(&parsed, "home_win").is_some() {
        Some(parsed)
    } else {
        None
    }
}

fn strip_machine_probability(text: &str) -> String {
    let mut out = String::new();
    let mut in_json_fence = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") && trimmed.to_ascii_lowercase().contains("json") {
            in_json_fence = true;
            continue;
        }
        if in_json_fence {
            if trimmed.starts_with("```") {
                in_json_fence = false;
            }
            continue;
        }
        if trimmed.starts_with("概率数据：") || looks_like_probability_json(trimmed) {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim().to_string()
}

fn looks_like_probability_json(line: &str) -> bool {
    line.starts_with('{')
        && line.ends_with('}')
        && line.contains("home_win")
        && line.contains("draw")
        && line.contains("away_win")
}

async fn get_prediction(pool: &SqlitePool, id: i64) -> AppResult<PredictionRunDto> {
    let row = sqlx::query("SELECT * FROM worldcup_prediction_runs WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    prediction_from_row(row)
}

async fn list_predictions(
    pool: &SqlitePool,
    match_id: i64,
    limit: i64,
) -> AppResult<Vec<PredictionRunDto>> {
    let rows = sqlx::query(
        "SELECT * FROM worldcup_prediction_runs WHERE match_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(match_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(prediction_from_row).collect()
}

async fn latest_prediction_id(pool: &SqlitePool, match_id: i64) -> AppResult<Option<i64>> {
    let row = sqlx::query(
        "SELECT id FROM worldcup_prediction_runs WHERE match_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(match_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| r.try_get("id")).transpose()?)
}

async fn latest_valid_odds(pool: &SqlitePool, match_id: i64) -> AppResult<Option<OddsSnapshot>> {
    let row = sqlx::query(
        r#"
        SELECT o.id, o.source_level, o.source_url, o.selection_code, o.odds_value
        FROM sporttery_odds_snapshots o
        JOIN sporttery_events e ON e.id = o.sporttery_event_id
        WHERE e.match_id = ? AND o.is_stale = 0 AND o.sale_status = 'open'
        ORDER BY o.id DESC
        LIMIT 1
        "#,
    )
    .bind(match_id)
    .fetch_optional(pool)
    .await?;
    row.map(|row| {
        Ok(OddsSnapshot {
            id: row.try_get("id")?,
            source_level: row.try_get("source_level")?,
            source_url: row.try_get("source_url")?,
            selection_code: row.try_get("selection_code")?,
            odds_value: row.try_get("odds_value")?,
        })
    })
    .transpose()
}

fn safe_allocation(budget: f64, risk_mode: &str) -> f64 {
    let ratio = match risk_mode {
        "conservative" => 0.05,
        "aggressive" => 0.15,
        _ => 0.10,
    };
    round2((budget * ratio).min(500.0))
}

async fn get_budget_plan(pool: &SqlitePool, id: i64) -> AppResult<BudgetPlanDto> {
    let row = sqlx::query("SELECT * FROM worldcup_betting_plans WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    budget_plan_from_row(row)
}

async fn list_budget_plans(
    pool: &SqlitePool,
    match_id: i64,
    limit: i64,
) -> AppResult<Vec<BudgetPlanDto>> {
    let rows = sqlx::query(
        "SELECT * FROM worldcup_betting_plans WHERE match_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(match_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(budget_plan_from_row).collect()
}

fn match_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<WorldCupMatchDto> {
    Ok(WorldCupMatchDto {
        id: row.try_get("id")?,
        fifa_match_id: row.try_get("fifa_match_id")?,
        match_no: row.try_get("match_no")?,
        stage: row.try_get("stage")?,
        group_name: row.try_get("group_name")?,
        home_team: translate_team_name(&row.try_get::<String, _>("home_team")?),
        away_team: translate_team_name(&row.try_get::<String, _>("away_team")?),
        kickoff_utc: row.try_get("kickoff_utc")?,
        kickoff_beijing: row.try_get("kickoff_beijing")?,
        venue: row.try_get("venue")?,
        city: row.try_get("city")?,
        country: row.try_get("country")?,
        status: row.try_get("status")?,
        result: row.try_get("result")?,
        source_url: row.try_get("source_url")?,
        updated_at: row.try_get("updated_at")?,
        intelligence_count: row.try_get("intelligence_count").unwrap_or(0),
        latest_prediction_id: row
            .try_get::<Option<i64>, _>("latest_prediction_id")
            .unwrap_or(None),
        latest_plan_id: row
            .try_get::<Option<i64>, _>("latest_plan_id")
            .unwrap_or(None),
    })
}

fn evidence_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<EvidenceItemDto> {
    let extracted: String = row.try_get("extracted_json")?;
    let rule_check: String = row.try_get("rule_check_json")?;
    let accepted: i64 = row.try_get("accepted_by_rule")?;
    Ok(EvidenceItemDto {
        id: row.try_get("id")?,
        research_run_id: row.try_get("research_run_id")?,
        match_id: row.try_get("match_id")?,
        category: row.try_get("category")?,
        source_level: row.try_get("source_level")?,
        source_name: row.try_get("source_name")?,
        url: row.try_get("url")?,
        title: row.try_get("title")?,
        published_at: row.try_get("published_at")?,
        fetched_at: row.try_get("fetched_at")?,
        extracted_json: serde_json::from_str(&extracted)?,
        raw_hash: row.try_get("raw_hash")?,
        credibility: row.try_get("credibility")?,
        rule_check_json: serde_json::from_str(&rule_check)?,
        accepted_by_rule: accepted != 0,
        audit_status: row.try_get("audit_status")?,
    })
}

fn research_run_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<ResearchRunDto> {
    let model: String = row.try_get("research_model_profile")?;
    let plan: String = row.try_get("search_plan_json")?;
    Ok(ResearchRunDto {
        id: row.try_get("id")?,
        match_id: row.try_get("match_id")?,
        trigger_type: row.try_get("trigger_type")?,
        research_model_profile: serde_json::from_str(&model)?,
        search_plan_json: serde_json::from_str(&plan)?,
        status: row.try_get("status")?,
        started_at: row.try_get("started_at")?,
        completed_at: row.try_get("completed_at")?,
        evidence_bundle_hash: row.try_get("evidence_bundle_hash")?,
        estimated_cost: row.try_get("estimated_cost")?,
        actual_cost: row.try_get("actual_cost")?,
        evidence_count: row.try_get("evidence_count").unwrap_or(0),
        accepted_count: row.try_get("accepted_count").unwrap_or(0),
    })
}

fn prediction_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<PredictionRunDto> {
    Ok(PredictionRunDto {
        id: row.try_get("id")?,
        match_id: row.try_get("match_id")?,
        research_run_id: row.try_get("research_run_id")?,
        model_profile: serde_json::from_str(&row.try_get::<String, _>("model_profile")?)?,
        prompt_revision: row.try_get("prompt_revision")?,
        evidence_bundle_hash: row.try_get("evidence_bundle_hash")?,
        local_probability: serde_json::from_str(&row.try_get::<String, _>("local_probability")?)?,
        llm_probability: serde_json::from_str(&row.try_get::<String, _>("llm_probability")?)?,
        market_probability: serde_json::from_str(&row.try_get::<String, _>("market_probability")?)?,
        final_probability: serde_json::from_str(&row.try_get::<String, _>("final_probability")?)?,
        scoreline_distribution: serde_json::from_str(&row.try_get::<String, _>("scoreline_distribution")?)?,
        confidence: row.try_get("confidence")?,
        disagreement_score: row.try_get("disagreement_score")?,
        analysis_markdown: row.try_get("analysis_markdown")?,
        created_at: row.try_get("created_at")?,
    })
}

fn budget_plan_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<BudgetPlanDto> {
    Ok(BudgetPlanDto {
        id: row.try_get("id")?,
        match_id: row.try_get("match_id")?,
        prediction_run_id: row.try_get("prediction_run_id")?,
        odds_snapshot_id: row.try_get("odds_snapshot_id")?,
        planning_mode: row.try_get("planning_mode")?,
        budget: row.try_get("budget")?,
        risk_mode: row.try_get("risk_mode")?,
        plan_json: serde_json::from_str(&row.try_get::<String, _>("plan_json")?)?,
        expected_value: row.try_get("expected_value")?,
        max_loss: row.try_get("max_loss")?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
    })
}

fn source_health_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<SourceHealthDto> {
    Ok(SourceHealthDto {
        id: row.try_get("id")?,
        source_name: row.try_get("source_name")?,
        source_level: row.try_get("source_level")?,
        status: row.try_get("status")?,
        message: row.try_get("message")?,
        source_url: row.try_get("source_url")?,
        fetched_at: row.try_get("fetched_at")?,
        field_coverage: row.try_get("field_coverage")?,
        failure_rate: row.try_get("failure_rate")?,
        recommended_refresh_seconds: row.try_get("recommended_refresh_seconds")?,
    })
}

fn queue_job_from_row(row: sqlx::sqlite::SqliteRow) -> AppResult<QueueJobDto> {
    Ok(QueueJobDto {
        id: row.try_get("id")?,
        job_type: row.try_get("job_type")?,
        status: row.try_get("status")?,
        payload_json: serde_json::from_str(&row.try_get::<String, _>("payload_json")?)?,
        estimated_cost: row.try_get("estimated_cost")?,
        error_message: row.try_get("error_message")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")? + "<title>".len();
    let end = lower[start..].find("</title>")? + start;
    Some(compact_text(&html[start..end], 180))
}

fn strip_tags(input: &str) -> String {
    let mut out = String::with_capacity(input.len().min(4096));
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn compact_text(text: &str, max_chars: usize) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

fn encode_query(query: &str) -> String {
    let mut out = String::new();
    for byte in query.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn hash_text(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

fn number_at(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64()
}

fn percent(value: &serde_json::Value, key: &str) -> String {
    format!("{:.1}", number_at(value, key).unwrap_or(0.0) * 100.0)
}

fn round4(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_fifa_calendar_match_without_placeholders() {
        let raw = json!({
            "IdCompetition": "17",
            "IdSeason": "285023",
            "IdStage": "289273",
            "IdMatch": "400021443",
            "MatchNumber": 1,
            "Date": "2026-06-11T19:00:00Z",
            "StageName": [{"Locale": "en-GB", "Description": "First Stage"}],
            "GroupName": [{"Locale": "en-GB", "Description": "Group A"}],
            "Home": {
                "ShortClubName": "Mexico",
                "TeamName": [{"Locale": "en-GB", "Description": "Mexico"}]
            },
            "Away": {
                "ShortClubName": "South Africa",
                "TeamName": [{"Locale": "en-GB", "Description": "South Africa"}]
            },
            "Stadium": {
                "Name": [{"Locale": "en-GB", "Description": "Mexico City Stadium"}],
                "CityName": [{"Locale": "en-GB", "Description": "Mexico City"}],
                "IdCountry": "MEX"
            }
        });
        let parsed = parse_fifa_calendar_match(&raw).unwrap();
        assert_eq!(parsed.match_no, 1);
        assert_eq!(parsed.stage, "小组赛");
        assert_eq!(parsed.group_name.as_deref(), Some("A 组"));
        assert_eq!(parsed.home_team, "墨西哥");
        assert_eq!(parsed.away_team, "南非");
        assert_eq!(parsed.kickoff_beijing, "2026-06-12T03:00:00+08:00");
        assert!(parsed.source_url.ends_with("/400021443"));
    }

    #[test]
    fn parses_fifa_calendar_match_with_chinese_team_names() {
        let raw = json!({
            "IdCompetition": "17",
            "IdSeason": "285023",
            "IdStage": "289273",
            "IdMatch": "400021443",
            "MatchNumber": 1,
            "Date": "2026-06-11T19:00:00Z",
            "StageName": [{"Locale": "zh-CN", "Description": "第一阶段"}],
            "GroupName": [{"Locale": "zh-CN", "Description": "A 组"}],
            "Home": {
                "ShortClubName": "Mexico",
                "TeamName": [{"Locale": "zh-CN", "Description": "墨西哥"}]
            },
            "Away": {
                "ShortClubName": "South Africa",
                "TeamName": [{"Locale": "zh-CN", "Description": "南非"}]
            },
            "Stadium": {
                "Name": [{"Locale": "zh-CN", "Description": "墨西哥城体育场"}],
                "CityName": [{"Locale": "zh-CN", "Description": "墨西哥城"}],
                "IdCountry": "MEX"
            }
        });
        let parsed = parse_fifa_calendar_match(&raw).unwrap();
        assert_eq!(parsed.stage, "小组赛");
        assert_eq!(parsed.group_name.as_deref(), Some("A 组"));
        assert_eq!(parsed.home_team, "墨西哥");
        assert_eq!(parsed.away_team, "南非");
        assert_eq!(parsed.country, "墨西哥");
    }

    #[test]
    fn translates_cached_english_team_names() {
        assert_eq!(translate_team_name("USA"), "美国");
        assert_eq!(translate_team_name("Korea Republic"), "韩国");
        assert_eq!(translate_team_name("Bosnia and Herzegovina"), "波斯尼亚和黑塞哥维那");
        assert_eq!(translate_team_name("D 组第 3 名"), "D 组第 3 名");
    }

    #[test]
    fn formats_official_knockout_placeholders() {
        assert_eq!(format_placeholder("W73"), "第 73 场胜者");
        assert_eq!(format_placeholder("L101"), "第 101 场负者");
        assert_eq!(format_placeholder("2A"), "A 组第 2 名");
        assert_eq!(format_placeholder("3DEIJL"), "D 组/E 组/I 组/J 组/L 组第 3 名");
    }

    #[test]
    fn local_rule_rejects_market_reference_as_hard_evidence() {
        let item = EvidenceDraft {
            category: "news".to_string(),
            source_level: "market_reference".to_string(),
            source_name: "market".to_string(),
            url: "https://example.test".to_string(),
            title: "odds".to_string(),
            published_at: None,
            fetched_at: "now".to_string(),
            extracted_json: json!({}),
        };
        let check = local_rule_check(&item);
        assert!(!check.accepted);
    }

    #[test]
    fn merge_probability_normalizes_values() {
        let merged = merge_probabilities(
            &json!({"home_win": 0.4, "draw": 0.3, "away_win": 0.3}),
            &json!({"home_win": 0.5, "draw": 0.25, "away_win": 0.25}),
        );
        let total = number_at(&merged, "home_win").unwrap()
            + number_at(&merged, "draw").unwrap()
            + number_at(&merged, "away_win").unwrap();
        assert!((total - 1.0).abs() < 0.001);
    }

    #[test]
    fn search_plan_falls_back_to_fallback_queries() {
        let queries = search_queries_from_plan(&json!({
            "mode": "llm",
            "fallback_queries": ["Mexico South Africa World Cup"]
        }));
        assert_eq!(queries, vec!["Mexico South Africa World Cup".to_string()]);
        assert_eq!(encode_query("Mexico South Africa"), "Mexico+South+Africa");
    }
}
