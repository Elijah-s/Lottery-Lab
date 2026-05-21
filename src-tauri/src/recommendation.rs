//! Rust-side recommendation service: wraps an LLM call around a candidate
//! bundle the front-end produced, and persists the resulting recommendation.

use std::collections::BTreeMap;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::AppResult;
use crate::llm::{chat_once, requires_api_key, ChatMessage};
use crate::prompts::list_prompts;
use crate::settings::resolve_llm_config;
use crate::time_utils::now_beijing_iso;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendationInput {
    pub lottery_type: String,
    pub target_issue: String,
    pub rules_version: String,
    pub user_request: String,
    pub parsed_request: serde_json::Value,
    pub ticket_text: String,
    pub stake_amount: i64,
    pub heuristic_score: f64,
    pub recommended_numbers: serde_json::Value,
    pub candidate_snapshot: serde_json::Value,
    pub history_summary: serde_json::Value,
    pub strategy: String,
    pub history_window_size: i64,
    pub validated_history_count: i64,
    pub latest_issue: String,
    #[serde(default)]
    pub candidate_pool: Vec<LlmCandidateInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmCandidateInput {
    pub id: String,
    pub ticket: serde_json::Value,
    pub amount: i64,
    pub formatted: String,
    pub score: f64,
    pub breakdown: serde_json::Value,
    pub strategy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecommendationOutput {
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
    pub analysis: Analysis,
    pub candidate_snapshot: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Analysis {
    pub source_mode: String,
    pub model: Option<String>,
    pub markdown: String,
    pub sections: serde_json::Value,
    pub prompt_roles: Vec<String>,
    pub error: Option<String>,
}

enum OfflineReason {
    MissingApiKey,
    LlmCallFailed(String),
}

#[derive(Debug, Clone, Deserialize)]
struct LlmSelectionResponse {
    selected_id: Option<String>,
    #[serde(default)]
    backup_ids: Vec<String>,
    analysis_markdown: Option<String>,
    reason: Option<String>,
    review_feedback_used: Option<String>,
    risk_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SelectionTrace {
    mode: String,
    selected_id: String,
    backup_ids: Vec<String>,
    selected_local_rank: usize,
    overrode_local_top: bool,
    reason: Option<String>,
    review_feedback_used: Option<String>,
    risk_note: Option<String>,
    fallback_reason: Option<String>,
    feedback_summary: serde_json::Value,
}

pub async fn create_recommendation(
    pool: &SqlitePool,
    client: &Client,
    input: RecommendationInput,
) -> AppResult<RecommendationOutput> {
    let prompts = list_prompts(pool).await?;
    let llm = resolve_llm_config(pool).await?;
    let prompt_roles: Vec<String> = prompts.iter().map(|p| p.role_name.clone()).collect();
    let candidate_pool = candidate_pool_or_fallback(&input);
    let feedback_summary = build_review_feedback_summary(pool, &input.lottery_type).await?;

    let (selected, analysis, trace) = if llm.api_key.is_empty() && requires_api_key(&llm) {
        fallback_selection(
            &input,
            &candidate_pool,
            &feedback_summary,
            &prompt_roles,
            &llm.provider,
            None,
            OfflineReason::MissingApiKey,
        )
    } else {
        let mut messages: Vec<ChatMessage> = prompts
            .iter()
            .map(|p| ChatMessage {
                role: "system".to_string(),
                content: format!("[{}]\n{}", p.role_name, p.content),
            })
            .collect();
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: build_user_prompt(&input, &candidate_pool, &feedback_summary),
        });
        match chat_once(client, &llm, &messages).await {
            Ok(raw) => match parse_llm_selection(&raw)
                .and_then(|selection| select_candidate(&candidate_pool, selection))
            {
                Ok((selection, selected, rank)) => {
                    let trace = SelectionTrace {
                        mode: "llm_candidate_selection".to_string(),
                        selected_id: selected.id.clone(),
                        backup_ids: validated_backup_ids(&candidate_pool, &selection.backup_ids),
                        selected_local_rank: rank,
                        overrode_local_top: rank != 1,
                        reason: selection.reason.clone(),
                        review_feedback_used: selection.review_feedback_used.clone(),
                        risk_note: selection.risk_note.clone(),
                        fallback_reason: None,
                        feedback_summary: feedback_summary.clone(),
                    };
                    let analysis = Analysis {
                        source_mode: "llm".to_string(),
                        model: Some(llm.model.clone()),
                        markdown: selection_analysis_markdown(&selection, &selected),
                        sections: serde_json::json!({
                            "provider": llm.provider.clone(),
                            "selection_mode": trace.mode.clone(),
                            "selected_id": selected.id.clone(),
                            "overrode_local_top": trace.overrode_local_top,
                        }),
                        prompt_roles: prompt_roles.clone(),
                        error: None,
                    };
                    (selected, analysis, trace)
                }
                Err(reason) => fallback_selection(
                    &input,
                    &candidate_pool,
                    &feedback_summary,
                    &prompt_roles,
                    &llm.provider,
                    Some(llm.model.clone()),
                    OfflineReason::LlmCallFailed(reason),
                ),
            },
            Err(err) => fallback_selection(
                &input,
                &candidate_pool,
                &feedback_summary,
                &prompt_roles,
                &llm.provider,
                Some(llm.model.clone()),
                OfflineReason::LlmCallFailed(err.to_string()),
            ),
        }
    };
    let candidate_snapshot = enrich_candidate_snapshot(&input, &candidate_pool, &trace);

    let created_at = now_beijing_iso();
    let analysis_json = serde_json::to_string(&analysis)?;
    let parsed_str = serde_json::to_string(&input.parsed_request)?;
    let numbers_str = serde_json::to_string(&selected.ticket)?;
    let candidate_str = serde_json::to_string(&candidate_snapshot)?;

    let result = sqlx::query(
        r#"
        INSERT INTO recommendations (
            lottery_type, target_issue, user_request, parsed_request,
            recommended_numbers, stake_amount, heuristic_score, rules_version,
            ticket_text, analysis, candidate_snapshot, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&input.lottery_type)
    .bind(&input.target_issue)
    .bind(&input.user_request)
    .bind(parsed_str)
    .bind(numbers_str)
    .bind(selected.amount)
    .bind(selected.score)
    .bind(&input.rules_version)
    .bind(&selected.formatted)
    .bind(&analysis_json)
    .bind(candidate_str)
    .bind(&created_at)
    .execute(pool)
    .await?;

    Ok(RecommendationOutput {
        id: result.last_insert_rowid(),
        lottery_type: input.lottery_type,
        target_issue: input.target_issue,
        user_request: input.user_request,
        parsed_request: input.parsed_request,
        recommended_numbers: selected.ticket,
        stake_amount: selected.amount,
        heuristic_score: selected.score,
        rules_version: input.rules_version,
        ticket_text: selected.formatted,
        analysis,
        candidate_snapshot,
        created_at,
    })
}

fn build_user_prompt(
    input: &RecommendationInput,
    candidate_pool: &[LlmCandidateInput],
    feedback_summary: &serde_json::Value,
) -> String {
    let history_summary = serde_json::to_string_pretty(&input.history_summary)
        .unwrap_or_else(|_| "{}".to_string());
    let candidate_pool_json = serde_json::to_string_pretty(candidate_pool)
        .unwrap_or_else(|_| "[]".to_string());
    let feedback_json = serde_json::to_string_pretty(feedback_summary)
        .unwrap_or_else(|_| "{}".to_string());
    format!(
        "用户需求：{}\n彩种：{}\n目标期号：{}\n用户偏好策略：{}\n历史窗口：{} 期（已校验 {}）\n最新期号：{}\n\n你必须从候选池中选择最终推荐，不能自行编造号码。selected_id 必须等于候选池内某个 id；最终票面、金额、号码都将由本地系统按该 id 回填并校验。\n\n候选池（包含本地评分和策略拆解）：\n{}\n\n历史开奖统计摘要（请真实参考，不要只复述候选票面）：\n{}\n\n历史推荐复盘反馈摘要（样本不足时只能作为弱信号）：\n{}\n\n请只输出一个 JSON 对象，不要使用 Markdown 代码块，字段如下：\n{{\n  \"selected_id\": \"C001\",\n  \"backup_ids\": [\"C002\", \"C003\"],\n  \"analysis_markdown\": \"### 策略解读\\n...\\n\\n### 历史数据依据\\n...\\n\\n### 复盘反馈校准\\n...\\n\\n### 风险提示\\n...\",\n  \"reason\": \"选择原因\",\n  \"review_feedback_used\": \"复盘反馈如何影响判断\",\n  \"risk_note\": \"风险提示\"\n}}\n",
        input.user_request,
        input.lottery_type,
        input.target_issue,
        strategy_label(&input.strategy),
        input.history_window_size,
        input.validated_history_count,
        input.latest_issue,
        candidate_pool_json,
        history_summary,
        feedback_json,
    )
}

fn candidate_pool_or_fallback(input: &RecommendationInput) -> Vec<LlmCandidateInput> {
    if !input.candidate_pool.is_empty() {
        return input.candidate_pool.clone();
    }
    vec![LlmCandidateInput {
        id: "LOCAL_TOP".to_string(),
        ticket: input.recommended_numbers.clone(),
        amount: input.stake_amount,
        formatted: input.ticket_text.clone(),
        score: input.heuristic_score,
        breakdown: serde_json::json!({}),
        strategy: input.strategy.clone(),
    }]
}

fn fallback_selection(
    input: &RecommendationInput,
    candidate_pool: &[LlmCandidateInput],
    feedback_summary: &serde_json::Value,
    prompt_roles: &[String],
    provider: &str,
    model: Option<String>,
    reason: OfflineReason,
) -> (LlmCandidateInput, Analysis, SelectionTrace) {
    let selected = candidate_pool[0].clone();
    let fallback_reason = offline_reason_text(&reason);
    let error = match &reason {
        OfflineReason::MissingApiKey => None,
        OfflineReason::LlmCallFailed(error) => Some(error.clone()),
    };
    let trace = SelectionTrace {
        mode: "local_fallback".to_string(),
        selected_id: selected.id.clone(),
        backup_ids: Vec::new(),
        selected_local_rank: 1,
        overrode_local_top: false,
        reason: None,
        review_feedback_used: None,
        risk_note: None,
        fallback_reason: Some(fallback_reason.clone()),
        feedback_summary: feedback_summary.clone(),
    };
    let analysis = Analysis {
        source_mode: "offline".to_string(),
        model,
        markdown: offline_analysis_markdown(input, &selected, reason),
        sections: serde_json::json!({
            "fallback": fallback_reason,
            "provider": provider,
            "selection_mode": trace.mode.clone(),
            "selected_id": selected.id.clone(),
        }),
        prompt_roles: prompt_roles.to_vec(),
        error,
    };
    (selected, analysis, trace)
}

fn offline_reason_text(reason: &OfflineReason) -> String {
    match reason {
        OfflineReason::MissingApiKey => {
            "接口密钥未配置，已使用本地最高分候选。".to_string()
        }
        OfflineReason::LlmCallFailed(error) => {
            format!("智能模型选择失败，已使用本地最高分候选：{}", sanitize_error(error))
        }
    }
}

fn offline_analysis_markdown(
    input: &RecommendationInput,
    selected: &LlmCandidateInput,
    reason: OfflineReason,
) -> String {
    let reason_text = match reason {
        OfflineReason::MissingApiKey => {
            "当前未配置接口密钥，最终推荐使用本地最高分候选。去「设置」填写后可让智能模型参与候选选择。".to_string()
        }
        OfflineReason::LlmCallFailed(error) => format!(
            "智能模型选择失败，已回退到本地最高分候选。请在「设置」测试连接或调整模型 / 接口地址。错误：{}",
            sanitize_error(&error)
        ),
    };
    format!(
        "### 启发式分析（离线）\n\n- 彩种：{}\n- 策略：{}\n- 推荐票面：{}\n- 投注金额：{} 元\n- 启发式评分：{}\n\n> {}\n",
        input.lottery_type,
        strategy_label(&selected.strategy),
        selected.formatted,
        selected.amount,
        selected.score,
        reason_text,
    )
}

fn parse_llm_selection(text: &str) -> Result<LlmSelectionResponse, String> {
    let json_text = extract_json_object(text)
        .ok_or_else(|| "模型响应中没有可解析的 JSON 对象".to_string())?;
    serde_json::from_str::<LlmSelectionResponse>(json_text)
        .map_err(|err| format!("模型 JSON 解析失败：{err}"))
}

fn extract_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some(&text[start..end]);
                }
            }
            _ => {}
        }
    }
    None
}

fn select_candidate(
    candidate_pool: &[LlmCandidateInput],
    selection: LlmSelectionResponse,
) -> Result<(LlmSelectionResponse, LlmCandidateInput, usize), String> {
    let selected_id = selection
        .selected_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "模型没有返回 selected_id".to_string())?;
    let Some(index) = candidate_pool
        .iter()
        .position(|candidate| candidate.id == selected_id)
    else {
        return Err(format!("模型选择了不在候选池中的 ID：{selected_id}"));
    };
    Ok((selection, candidate_pool[index].clone(), index + 1))
}

fn validated_backup_ids(candidate_pool: &[LlmCandidateInput], ids: &[String]) -> Vec<String> {
    let mut result = Vec::new();
    for id in ids {
        let trimmed = id.trim();
        if result.iter().any(|existing| existing == trimmed) {
            continue;
        }
        if candidate_pool.iter().any(|candidate| candidate.id == trimmed) {
            result.push(trimmed.to_string());
        }
    }
    result
}

fn selection_analysis_markdown(
    selection: &LlmSelectionResponse,
    selected: &LlmCandidateInput,
) -> String {
    if let Some(markdown) = selection
        .analysis_markdown
        .as_deref()
        .map(str::trim)
        .filter(|markdown| !markdown.is_empty())
    {
        return markdown.to_string();
    }
    let reason = selection
        .reason
        .as_deref()
        .unwrap_or("模型选择该候选作为当前需求下的综合平衡方案。");
    let feedback = selection
        .review_feedback_used
        .as_deref()
        .unwrap_or("暂无足够复盘样本，主要参考历史开奖摘要与候选评分。");
    let risk = selection
        .risk_note
        .as_deref()
        .unwrap_or("彩票开奖具有随机性，本推荐不承诺中奖，也不构成投资建议。");
    format!(
        "### 策略解读\n\n已从候选池选择：{}，本地评分 {:.2}。\n\n### 历史数据依据\n\n{}\n\n### 复盘反馈校准\n\n{}\n\n### 风险提示\n\n{}\n",
        selected.formatted,
        selected.score,
        reason,
        feedback,
        risk,
    )
}

fn enrich_candidate_snapshot(
    input: &RecommendationInput,
    candidate_pool: &[LlmCandidateInput],
    trace: &SelectionTrace,
) -> serde_json::Value {
    let mut object = input
        .candidate_snapshot
        .as_object()
        .cloned()
        .unwrap_or_default();
    object.insert(
        "candidate_pool".to_string(),
        serde_json::json!(candidate_pool),
    );
    object.insert(
        "local_top_id".to_string(),
        serde_json::json!(candidate_pool.first().map(|candidate| candidate.id.clone())),
    );
    object.insert("llm_selection".to_string(), serde_json::json!(trace));
    serde_json::Value::Object(object)
}

async fn build_review_feedback_summary(
    pool: &SqlitePool,
    lottery_type: &str,
) -> AppResult<serde_json::Value> {
    let rows = sqlx::query(
        r#"
        SELECT r.candidate_snapshot, v.primary_hits, v.secondary_hits
        FROM reviews v
        INNER JOIN recommendations r ON r.id = v.recommendation_id
        WHERE r.lottery_type = ?
        ORDER BY v.id DESC
        LIMIT 60
        "#,
    )
    .bind(lottery_type)
    .fetch_all(pool)
    .await?;

    let reviewed_count = rows.len() as i64;
    if reviewed_count == 0 {
        return Ok(serde_json::json!({
            "reviewed_count": 0,
            "sample_quality": "none",
            "note": "暂无已复盘推荐，本次不能使用历史命中反馈校准。",
        }));
    }

    let mut primary_total = 0i64;
    let mut secondary_total = 0i64;
    let mut primary_distribution: BTreeMap<String, i64> = BTreeMap::new();
    let mut by_strategy: BTreeMap<String, (i64, i64, i64)> = BTreeMap::new();
    let mut llm_selection_count = 0i64;
    let mut overrode_local_top_count = 0i64;
    let mut selected_rank_total = 0i64;
    let mut selected_rank_count = 0i64;

    for row in rows {
        let primary_hits: i64 = row.try_get("primary_hits")?;
        let secondary_hits: i64 = row.try_get("secondary_hits")?;
        let candidate_snapshot: String = row.try_get("candidate_snapshot")?;
        let snapshot: serde_json::Value =
            serde_json::from_str(&candidate_snapshot).unwrap_or(serde_json::Value::Null);
        let strategy = snapshot
            .get("strategy")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("unknown")
            .to_string();

        primary_total += primary_hits;
        secondary_total += secondary_hits;
        let bucket = match primary_hits {
            0 => "0",
            1 => "1",
            2 => "2",
            _ => "3_plus",
        };
        *primary_distribution.entry(bucket.to_string()).or_insert(0) += 1;

        let strategy_entry = by_strategy.entry(strategy).or_insert((0, 0, 0));
        strategy_entry.0 += 1;
        strategy_entry.1 += primary_hits;
        strategy_entry.2 += secondary_hits;

        if let Some(selection) = snapshot.get("llm_selection").filter(|selection| {
            selection
                .get("mode")
                .and_then(serde_json::Value::as_str)
                == Some("llm_candidate_selection")
        }) {
            llm_selection_count += 1;
            if selection
                .get("overrode_local_top")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
            {
                overrode_local_top_count += 1;
            }
            if let Some(rank) = selection
                .get("selected_local_rank")
                .and_then(serde_json::Value::as_i64)
                .filter(|rank| *rank > 0)
            {
                selected_rank_total += rank;
                selected_rank_count += 1;
            }
        }
    }

    let by_strategy_json: BTreeMap<String, serde_json::Value> = by_strategy
        .into_iter()
        .map(|(strategy, (samples, primary, secondary))| {
            (
                strategy,
                serde_json::json!({
                    "samples": samples,
                    "avg_primary_hits": avg_hits(primary, samples),
                    "avg_secondary_hits": avg_hits(secondary, samples),
                }),
            )
        })
        .collect();

    Ok(serde_json::json!({
        "reviewed_count": reviewed_count,
        "sample_quality": if reviewed_count >= 10 { "usable" } else { "insufficient" },
        "avg_primary_hits": avg_hits(primary_total, reviewed_count),
        "avg_secondary_hits": avg_hits(secondary_total, reviewed_count),
        "primary_hit_distribution": primary_distribution,
        "by_strategy": by_strategy_json,
        "llm_selection": {
            "reviewed_count": llm_selection_count,
            "overrode_local_top_count": overrode_local_top_count,
            "avg_selected_local_rank": if selected_rank_count > 0 {
                serde_json::json!(avg_hits(selected_rank_total, selected_rank_count))
            } else {
                serde_json::Value::Null
            },
        },
    }))
}

fn avg_hits(total: i64, count: i64) -> f64 {
    if count == 0 {
        return 0.0;
    }
    round2(total as f64 / count as f64)
}

fn sanitize_error(error: &str) -> String {
    let compact = error.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(240).collect()
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn strategy_label(strategy: &str) -> &str {
    match strategy {
        "balanced" => "平衡",
        "anti_popular" => "反热门",
        "recency_fade" => "弱化近期",
        _ => "未知策略",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str) -> LlmCandidateInput {
        LlmCandidateInput {
            id: id.to_string(),
            ticket: serde_json::json!({ "lotteryType": "ssq", "mode": "single" }),
            amount: 2,
            formatted: format!("候选 {id}"),
            score: 70.0,
            breakdown: serde_json::json!({ "balancedFrequency": 0.5 }),
            strategy: "balanced".to_string(),
        }
    }

    #[test]
    fn extracts_json_from_fenced_model_response() {
        let raw = "```json\n{\"selected_id\":\"C002\",\"reason\":\"测试\"}\n```";
        let parsed = parse_llm_selection(raw).expect("json should parse");
        assert_eq!(parsed.selected_id.as_deref(), Some("C002"));
        assert_eq!(parsed.reason.as_deref(), Some("测试"));
    }

    #[test]
    fn accepts_only_candidates_from_pool() {
        let pool = vec![candidate("C001"), candidate("C002")];
        let selection = LlmSelectionResponse {
            selected_id: Some("C002".to_string()),
            backup_ids: vec![],
            analysis_markdown: None,
            reason: None,
            review_feedback_used: None,
            risk_note: None,
        };
        let (_, selected, rank) = select_candidate(&pool, selection).expect("valid id");
        assert_eq!(selected.id, "C002");
        assert_eq!(rank, 2);
    }

    #[test]
    fn rejects_candidates_outside_pool() {
        let pool = vec![candidate("C001")];
        let selection = LlmSelectionResponse {
            selected_id: Some("C999".to_string()),
            backup_ids: vec![],
            analysis_markdown: None,
            reason: None,
            review_feedback_used: None,
            risk_note: None,
        };
        let error = select_candidate(&pool, selection).expect_err("invalid id");
        assert!(error.contains("不在候选池"));
    }

    #[tokio::test]
    async fn builds_feedback_summary_from_reviewed_recommendations() {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"
            CREATE TABLE recommendations (
                id INTEGER PRIMARY KEY,
                lottery_type TEXT NOT NULL,
                candidate_snapshot TEXT NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE reviews (
                id INTEGER PRIMARY KEY,
                recommendation_id INTEGER NOT NULL,
                primary_hits INTEGER NOT NULL,
                secondary_hits INTEGER NOT NULL
            );
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let llm_snapshot = serde_json::json!({
            "strategy": "balanced",
            "llm_selection": {
                "mode": "llm_candidate_selection",
                "selected_local_rank": 2,
                "overrode_local_top": true
            }
        });
        let fallback_snapshot = serde_json::json!({
            "strategy": "recency_fade",
            "llm_selection": {
                "mode": "local_fallback",
                "selected_local_rank": 1,
                "overrode_local_top": false
            }
        });
        sqlx::query(
            "INSERT INTO recommendations (id, lottery_type, candidate_snapshot) VALUES (1, 'ssq', ?), (2, 'ssq', ?)",
        )
        .bind(llm_snapshot.to_string())
        .bind(fallback_snapshot.to_string())
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO reviews (id, recommendation_id, primary_hits, secondary_hits) VALUES (1, 1, 2, 1), (2, 2, 0, 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let summary = build_review_feedback_summary(&pool, "ssq").await.unwrap();
        assert_eq!(summary["reviewed_count"], 2);
        assert_eq!(summary["sample_quality"], "insufficient");
        assert_eq!(summary["avg_primary_hits"], 1.0);
        assert_eq!(summary["llm_selection"]["reviewed_count"], 1);
        assert_eq!(summary["llm_selection"]["overrode_local_top_count"], 1);
        assert_eq!(summary["llm_selection"]["avg_selected_local_rank"], 2.0);
    }
}
