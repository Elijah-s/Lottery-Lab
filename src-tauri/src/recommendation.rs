//! Rust-side recommendation service: wraps an LLM call around a candidate
//! bundle the front-end produced, and persists the resulting recommendation.

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

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

pub async fn create_recommendation(
    pool: &SqlitePool,
    client: &Client,
    input: RecommendationInput,
) -> AppResult<RecommendationOutput> {
    let prompts = list_prompts(pool).await?;
    let llm = resolve_llm_config(pool).await?;

    let analysis = if llm.api_key.is_empty() && requires_api_key(&llm) {
        Analysis {
            source_mode: "offline".to_string(),
            model: None,
            markdown: offline_analysis_markdown(&input, OfflineReason::MissingApiKey),
            sections: serde_json::json!({
                "fallback": "接口密钥未配置，展示启发式评分摘要。",
                "provider": llm.provider.clone(),
            }),
            prompt_roles: prompts.iter().map(|p| p.role_name.clone()).collect(),
            error: None,
        }
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
            content: build_user_prompt(&input),
        });
        match chat_once(client, &llm, &messages).await {
            Ok(markdown) => Analysis {
                source_mode: "llm".to_string(),
                model: Some(llm.model.clone()),
                markdown,
                sections: serde_json::json!({
                    "provider": llm.provider.clone(),
                }),
                prompt_roles: prompts.iter().map(|p| p.role_name.clone()).collect(),
                error: None,
            },
            Err(err) => Analysis {
                source_mode: "offline".to_string(),
                model: Some(llm.model.clone()),
                markdown: offline_analysis_markdown(
                    &input,
                    OfflineReason::LlmCallFailed(err.to_string()),
                ),
                sections: serde_json::json!({
                    "fallback": format!("智能模型调用失败，已回退：{err}"),
                    "provider": llm.provider.clone(),
                }),
                prompt_roles: prompts.iter().map(|p| p.role_name.clone()).collect(),
                error: Some(err.to_string()),
            },
        }
    };

    let created_at = now_beijing_iso();
    let analysis_json = serde_json::to_string(&analysis)?;
    let parsed_str = serde_json::to_string(&input.parsed_request)?;
    let numbers_str = serde_json::to_string(&input.recommended_numbers)?;
    let candidate_str = serde_json::to_string(&input.candidate_snapshot)?;

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
    .bind(input.stake_amount)
    .bind(input.heuristic_score)
    .bind(&input.rules_version)
    .bind(&input.ticket_text)
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
        recommended_numbers: input.recommended_numbers,
        stake_amount: input.stake_amount,
        heuristic_score: input.heuristic_score,
        rules_version: input.rules_version,
        ticket_text: input.ticket_text,
        analysis,
        candidate_snapshot: input.candidate_snapshot,
        created_at,
    })
}

fn build_user_prompt(input: &RecommendationInput) -> String {
    let history_summary = serde_json::to_string_pretty(&input.history_summary)
        .unwrap_or_else(|_| "{}".to_string());
    format!(
        "用户需求：{}\n彩种：{}\n目标期号：{}\n策略：{}\n推荐票面：{}\n投注金额：{} 元\n启发式评分：{}\n历史窗口：{} 期（已校验 {}）\n最新期号：{}\n\n历史开奖统计摘要（请真实参考，不要只复述票面）：\n{}\n\n请按以下结构输出中文 Markdown：\n1. 策略解读（说明本票与用户需求、预算、策略的关系，≤ 100 字）\n2. 历史数据依据（结合最近 5 期、冷热号、遗漏、候选评分拆解，≤ 180 字）\n3. 风险提示（免责声明，不承诺中奖）\n",
        input.user_request,
        input.lottery_type,
        input.target_issue,
        strategy_label(&input.strategy),
        input.ticket_text,
        input.stake_amount,
        input.heuristic_score,
        input.history_window_size,
        input.validated_history_count,
        input.latest_issue,
        history_summary,
    )
}

fn offline_analysis_markdown(input: &RecommendationInput, reason: OfflineReason) -> String {
    let reason_text = match reason {
        OfflineReason::MissingApiKey => {
            "当前未配置接口密钥，仅展示本地启发式摘要。去「设置」填写后可获得多专家解释。".to_string()
        }
        OfflineReason::LlmCallFailed(error) => format!(
            "智能模型调用失败，已回退到本地启发式摘要。请在「设置」测试连接或调整模型 / 接口地址。错误：{}",
            sanitize_error(&error)
        ),
    };
    format!(
        "### 启发式分析（离线）\n\n- 彩种：{}\n- 策略：{}\n- 推荐票面：{}\n- 投注金额：{} 元\n- 启发式评分：{}\n\n> {}\n",
        input.lottery_type,
        strategy_label(&input.strategy),
        input.ticket_text,
        input.stake_amount,
        input.heuristic_score,
        reason_text,
    )
}

fn sanitize_error(error: &str) -> String {
    let compact = error.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(240).collect()
}

fn strategy_label(strategy: &str) -> &str {
    match strategy {
        "balanced" => "平衡",
        "anti_popular" => "反热门",
        "recency_fade" => "弱化近期",
        _ => "未知策略",
    }
}
