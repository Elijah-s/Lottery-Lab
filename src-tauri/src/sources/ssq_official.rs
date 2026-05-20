//! 双色球 — 中彩网开奖 JSONP 接口。
//!
//! 接口返回结构：
//! ```json
//! { "resCode": "000000", "data": [{ "issue": "2026056",
//!   "openTime": "2026-05-19", "frontWinningNum": "10 19 ...",
//!   "backWinningNum": "05", ... }] }
//! ```

use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use crate::errors::{AppError, AppResult};
use crate::sources::{DrawRecord, DrawSource};

const NAME: &str = "zhcw-official-api";
const URL: &str = "https://jc.zhcw.com/port/client_json.php";
const REFERER: &str = "https://www.zhcw.com/";

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default, rename = "resCode")]
    res_code: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Vec<ApiItem>,
}

#[derive(Debug, Deserialize)]
struct ApiItem {
    issue: String,
    #[serde(rename = "openTime")]
    open_time: String,
    #[serde(rename = "frontWinningNum")]
    front_winning_num: String,
    #[serde(rename = "backWinningNum")]
    back_winning_num: String,
}

pub struct SsqOfficialSource {
    client: Client,
}

impl SsqOfficialSource {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl DrawSource for SsqOfficialSource {
    fn name(&self) -> &'static str {
        NAME
    }

    fn url_hint(&self) -> Option<&'static str> {
        Some(URL)
    }

    async fn fetch(&self, limit: usize) -> AppResult<Vec<DrawRecord>> {
        let page_size = limit.max(1).to_string();
        let timestamp = current_millis();
        let callback = format!("jQuery112200000000000000000_{timestamp}");
        let cache_buster = (timestamp + 1).to_string();
        let tt = format!("0.{}", timestamp % 1_000_000_000);

        let response_body = self
            .client
            .get(URL)
            .query(&[
                ("callback", callback.as_str()),
                ("transactionType", "10001001"),
                ("lotteryId", "1"),
                ("issueCount", page_size.as_str()),
                ("startIssue", ""),
                ("endIssue", ""),
                ("startDate", ""),
                ("endDate", ""),
                ("type", "0"),
                ("pageNum", "1"),
                ("pageSize", page_size.as_str()),
                ("tt", tt.as_str()),
                ("_", cache_buster.as_str()),
            ])
            .header("Accept", "application/javascript, application/json, */*")
            .header("Referer", REFERER)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        let payload = parse_jsonp(&response_body)?;
        if payload.res_code != "000000" {
            return Err(AppError::BadResponse(
                payload
                    .message
                    .unwrap_or_else(|| format!("zhcw.com resCode={}", payload.res_code)),
            ));
        }

        let mut draws = Vec::with_capacity(payload.data.len());
        for item in payload.data {
            let reds = parse_numbers(&item.front_winning_num)?;
            let blues = parse_numbers(&item.back_winning_num)?;
            draws.push(DrawRecord {
                lottery_type: "ssq".to_string(),
                issue: item.issue.trim().to_string(),
                draw_date: item.open_time.trim().to_string(),
                numbers: serde_json::json!({ "red": reds, "blue": blues }),
                source_name: NAME.to_string(),
                source_url: Some(URL.to_string()),
            });
        }
        Ok(draws)
    }
}

fn current_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn parse_jsonp(body: &str) -> AppResult<ApiResponse> {
    let start = body
        .find('(')
        .ok_or_else(|| AppError::BadResponse("中彩网返回内容缺少 JSONP 起始括号".to_string()))?
        + 1;
    let end = body
        .rfind(')')
        .ok_or_else(|| AppError::BadResponse("中彩网返回内容缺少 JSONP 结束括号".to_string()))?;
    if end <= start {
        return Err(AppError::BadResponse(
            "中彩网返回内容不是有效 JSONP".to_string(),
        ));
    }
    Ok(serde_json::from_str(&body[start..end])?)
}

fn parse_numbers(input: &str) -> AppResult<Vec<u8>> {
    input
        .split([',', ' '])
        .filter(|s| !s.is_empty())
        .map(|s| {
            s.trim().parse::<u8>().map_err(|err| {
                AppError::BadResponse(format!("无法解析号码 {s}：{err}"))
            })
        })
        .collect()
}
