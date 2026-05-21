//! Expert-role prompt persistence + defaults.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

use crate::errors::AppResult;
use crate::time_utils::now_beijing_iso;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRecord {
    pub role_name: String,
    pub content: String,
    pub prompt_revision: i64,
    pub prompt_hash: String,
    pub updated_at: String,
}

pub const DEFAULT_PROMPTS: &[(&str, &str)] = &[
    (
        "selection_director",
        "你是彩票推荐系统的选号总控。你必须从系统提供的候选池中选择最终候选 ID，不能自行编造号码、金额或玩法。\n选择时综合参考用户需求、候选本地评分、历史开奖摘要和历史推荐复盘反馈；复盘样本不足时只能作为弱信号。\n输出必须服从用户消息要求的 JSON 结构，并在 analysis_markdown 中使用中文说明：策略解读、历史数据依据、复盘反馈校准、风险提示。",
    ),
    (
        "lottery_expert",
        "你是一位中国彩票领域的资深研究者。针对用户的投注需求与候选池，评估号码选择背后的历史频次、规则合规性以及策略逻辑。\n必须尊重候选池约束，不做中奖概率承诺。",
    ),
    (
        "math_expert",
        "你是一位数学/概率专家。用清晰的推理比较候选票的分布、方差、覆盖区间和本地评分拆解，并指出重要的统计假设。\n不要把历史频次解释成确定性概率，必要时给出简单公式。",
    ),
    (
        "modeler",
        "你是彩票推荐系统的建模师。关注数据质量、策略偏差、候选池多样性以及复盘反馈可观测的改进点。\n使用中文输出，并明确标注数据局限性。",
    ),
];

const LEGACY_DEFAULT_PROMPTS: &[(&str, &str)] = &[
    (
        "lottery_expert",
        "你是一位中国彩票领域的资深研究者。针对用户的投注需求与候选票，解释号码选择背后的历史频次、规则合规性以及策略逻辑。\n请使用简洁的中文 Markdown，不做中奖概率承诺。",
    ),
    (
        "math_expert",
        "你是一位数学/概率专家。用清晰的推理评估候选票的期望收益、方差与命中区间，并指出重要的统计假设。\n输出使用中文 Markdown，必要时给出简单公式。",
    ),
    (
        "modeler",
        "你是彩票推荐系统的建模师。关注数据质量、策略偏差与后续可观测的改进点，使用中文 Markdown 输出，并标注数据局限性。",
    ),
];

pub async fn seed_defaults(pool: &SqlitePool) -> AppResult<()> {
    let now = now_beijing_iso();
    for (role, content) in DEFAULT_PROMPTS {
        let hash = hash_prompt(content);
        sqlx::query(
            r#"
            INSERT INTO prompts (role_name, content, prompt_revision, prompt_hash, updated_at)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(role_name) DO NOTHING
            "#,
        )
        .bind(role)
        .bind(content)
        .bind(hash)
        .bind(&now)
        .execute(pool)
        .await?;
    }
    upgrade_legacy_defaults(pool, &now).await?;
    Ok(())
}

pub async fn list_prompts(pool: &SqlitePool) -> AppResult<Vec<PromptRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT role_name, content, prompt_revision, prompt_hash, updated_at
        FROM prompts
        ORDER BY CASE role_name
            WHEN 'selection_director' THEN 0
            WHEN 'lottery_expert' THEN 1
            WHEN 'math_expert' THEN 2
            WHEN 'modeler' THEN 3
            ELSE 99
        END, role_name
        "#,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(PromptRecord {
                role_name: row.try_get("role_name")?,
                content: row.try_get("content")?,
                prompt_revision: row.try_get("prompt_revision")?,
                prompt_hash: row.try_get("prompt_hash")?,
                updated_at: row.try_get("updated_at")?,
            })
        })
        .collect()
}

pub async fn save_prompts(
    pool: &SqlitePool,
    prompts: &[(String, String)],
) -> AppResult<()> {
    let now = now_beijing_iso();
    let mut tx = pool.begin().await?;
    for (role, content) in prompts {
        let hash = hash_prompt(content);
        sqlx::query(
            r#"
            INSERT INTO prompts (role_name, content, prompt_revision, prompt_hash, updated_at)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(role_name) DO UPDATE SET
                content = excluded.content,
                prompt_revision = prompts.prompt_revision + 1,
                prompt_hash = excluded.prompt_hash,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(role)
        .bind(content)
        .bind(hash)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn reset_defaults(pool: &SqlitePool) -> AppResult<()> {
    let now = now_beijing_iso();
    let mut tx = pool.begin().await?;
    for (role, content) in DEFAULT_PROMPTS {
        let hash = hash_prompt(content);
        sqlx::query(
            r#"
            INSERT INTO prompts (role_name, content, prompt_revision, prompt_hash, updated_at)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(role_name) DO UPDATE SET
                content = excluded.content,
                prompt_revision = prompts.prompt_revision + 1,
                prompt_hash = excluded.prompt_hash,
                updated_at = excluded.updated_at
            "#,
        )
        .bind(role)
        .bind(content)
        .bind(hash)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

fn hash_prompt(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    hex::encode(&digest[..8])
}

async fn upgrade_legacy_defaults(pool: &SqlitePool, now: &str) -> AppResult<()> {
    for (role, old_content) in LEGACY_DEFAULT_PROMPTS {
        let Some((_, new_content)) = DEFAULT_PROMPTS
            .iter()
            .find(|(default_role, _)| default_role == role)
        else {
            continue;
        };
        if old_content == new_content {
            continue;
        }
        sqlx::query(
            r#"
            UPDATE prompts
            SET content = ?, prompt_revision = prompt_revision + 1, prompt_hash = ?, updated_at = ?
            WHERE role_name = ? AND content = ?
            "#,
        )
        .bind(new_content)
        .bind(hash_prompt(new_content))
        .bind(now)
        .bind(role)
        .bind(old_content)
        .execute(pool)
        .await?;
    }
    Ok(())
}
