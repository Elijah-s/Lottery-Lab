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
    Ok(())
}

pub async fn list_prompts(pool: &SqlitePool) -> AppResult<Vec<PromptRecord>> {
    let rows = sqlx::query(
        r#"
        SELECT role_name, content, prompt_revision, prompt_hash, updated_at
        FROM prompts
        ORDER BY role_name
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
