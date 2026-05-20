//! Auto-review pending recommendations against the latest draws.
//!
//! For each recommendation whose `target_issue` has now been drawn, we
//! diff the recommended numbers against the actual result and persist
//! a `reviews` row. Idempotent via the `UNIQUE(recommendation_id)`
//! constraint.

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::errors::AppResult;
use crate::time_utils::now_beijing_iso;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewDto {
    pub id: i64,
    pub recommendation_id: i64,
    pub actual_draw: serde_json::Value,
    pub primary_hits: i64,
    pub secondary_hits: i64,
    pub notes: Option<String>,
    pub created_at: String,
}

pub async fn review_pending(pool: &SqlitePool) -> AppResult<usize> {
    let rows = sqlx::query(
        r#"
        SELECT r.id, r.lottery_type, r.target_issue, r.recommended_numbers
        FROM recommendations r
        LEFT JOIN reviews v ON v.recommendation_id = r.id
        WHERE v.id IS NULL
        "#,
    )
    .fetch_all(pool)
    .await?;

    let mut reviewed = 0usize;
    for row in rows {
        let rec_id: i64 = row.try_get("id")?;
        let lottery_type: String = row.try_get("lottery_type")?;
        let target_issue: String = row.try_get("target_issue")?;
        let recommended_str: String = row.try_get("recommended_numbers")?;

        let draw = sqlx::query(
            r#"
            SELECT numbers FROM draws
            WHERE lottery_type = ? AND issue = ?
            "#,
        )
        .bind(&lottery_type)
        .bind(&target_issue)
        .fetch_optional(pool)
        .await?;
        let Some(draw_row) = draw else {
            continue;
        };
        let actual_str: String = draw_row.try_get("numbers")?;
        let recommended: serde_json::Value = serde_json::from_str(&recommended_str)?;
        let actual: serde_json::Value = serde_json::from_str(&actual_str)?;

        let (primary, secondary) = count_hits(&lottery_type, &recommended, &actual);
        let now = now_beijing_iso();
        sqlx::query(
            r#"
            INSERT INTO reviews (recommendation_id, actual_draw, primary_hits, secondary_hits, notes, created_at)
            VALUES (?, ?, ?, ?, NULL, ?)
            ON CONFLICT(recommendation_id) DO NOTHING
            "#,
        )
        .bind(rec_id)
        .bind(serde_json::to_string(&actual)?)
        .bind(primary as i64)
        .bind(secondary as i64)
        .bind(&now)
        .execute(pool)
        .await?;
        reviewed += 1;
    }
    Ok(reviewed)
}

fn count_hits(
    lottery_type: &str,
    recommended: &serde_json::Value,
    actual: &serde_json::Value,
) -> (usize, usize) {
    let (primary_key, secondary_key) = match lottery_type {
        "ssq" => ("red", "blue"),
        _ => ("front", "back"),
    };
    let primary_hits = intersect_len(
        extract_primary_numbers(recommended, primary_key),
        extract_numbers(actual, primary_key),
    );
    let secondary_hits = intersect_len(
        extract_primary_numbers(recommended, secondary_key),
        extract_numbers(actual, secondary_key),
    );
    (primary_hits, secondary_hits)
}

fn extract_numbers(value: &serde_json::Value, key: &str) -> Vec<u64> {
    value
        .get(key)
        .and_then(|v| v.as_array())
        .map(|array| array.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default()
}

/// Recommended payloads can be in single / multiple / danTuo shapes.
/// We union every primary-area pool we can find under the given area
/// key (e.g. `reds` / `redBank` / `redDan` + `redTuo`).
fn extract_primary_numbers(value: &serde_json::Value, area: &str) -> Vec<u64> {
    let candidate_keys: &[&str] = match area {
        "red" => &["reds", "redBank", "redDan", "redTuo"],
        "blue" => &["blues", "blueBank"],
        "front" => &["front", "frontBank", "frontDan", "frontTuo"],
        "back" => &["back", "backBank", "backDan", "backTuo"],
        _ => &[],
    };
    let mut pool: Vec<u64> = Vec::new();
    for key in candidate_keys {
        if let Some(array) = value.get(key).and_then(|v| v.as_array()) {
            for n in array.iter().filter_map(|v| v.as_u64()) {
                if !pool.contains(&n) {
                    pool.push(n);
                }
            }
        }
    }
    pool
}

fn intersect_len(a: Vec<u64>, b: Vec<u64>) -> usize {
    a.iter().filter(|n| b.contains(n)).count()
}

pub async fn list_reviews(pool: &SqlitePool, limit: i64) -> AppResult<Vec<ReviewDto>> {
    let rows = sqlx::query(
        r#"
        SELECT id, recommendation_id, actual_draw, primary_hits, secondary_hits, notes, created_at
        FROM reviews
        ORDER BY id DESC
        LIMIT ?
        "#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            let actual_str: String = row.try_get("actual_draw")?;
            Ok(ReviewDto {
                id: row.try_get("id")?,
                recommendation_id: row.try_get("recommendation_id")?,
                actual_draw: serde_json::from_str(&actual_str)?,
                primary_hits: row.try_get("primary_hits")?,
                secondary_hits: row.try_get("secondary_hits")?,
                notes: row.try_get("notes")?,
                created_at: row.try_get("created_at")?,
            })
        })
        .collect()
}
