//! 大乐透 — 中国体彩网官方历史开奖接口。
//!
//! 返回结构示例：
//! ```json
//! { "value": { "list": [ { "lotteryDrawNum": "25104",
//!   "lotteryDrawResult": "01 05 12 18 33 02 11",
//!   "lotteryDrawTime": "2025-09-20" } ] } }
//! ```

use async_trait::async_trait;
use reqwest::Client;
use serde::Deserialize;

use crate::errors::{AppError, AppResult};
use crate::sources::{DrawRecord, DrawSource};

const NAME: &str = "sporttery-official-api";
const URL: &str =
    "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry";
const MAX_PAGE_SIZE: usize = 100;

#[derive(Debug, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    success: Option<bool>,
    #[serde(default, rename = "errorCode")]
    error_code: Option<String>,
    value: Option<ApiValue>,
}

#[derive(Debug, Deserialize)]
struct ApiValue {
    #[serde(default)]
    list: Vec<ApiItem>,
}

#[derive(Debug, Deserialize)]
struct ApiItem {
    #[serde(rename = "lotteryDrawNum")]
    draw_num: String,
    #[serde(rename = "lotteryDrawTime")]
    draw_time: String,
    #[serde(rename = "lotteryDrawResult")]
    draw_result: String,
}

pub struct DltOfficialSource {
    client: Client,
}

impl DltOfficialSource {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl DrawSource for DltOfficialSource {
    fn name(&self) -> &'static str {
        NAME
    }

    fn url_hint(&self) -> Option<&'static str> {
        Some(URL)
    }

    async fn fetch(&self, limit: usize) -> AppResult<Vec<DrawRecord>> {
        let target_count = limit.max(1);
        let mut draws = Vec::with_capacity(target_count);
        let mut page_no = 1usize;

        while draws.len() < target_count {
            let page_size = (target_count - draws.len()).min(MAX_PAGE_SIZE).to_string();
            let page_no_param = page_no.to_string();
            let response = self
                .client
                .get(URL)
                .query(&[
                    ("gameNo", "85"),
                    ("provinceId", "0"),
                    ("pageSize", page_size.as_str()),
                    ("isVerify", "1"),
                    ("pageNo", page_no_param.as_str()),
                ])
                .header("Referer", "https://www.sporttery.cn/")
                .send()
                .await?
                .error_for_status()?;

            let payload: ApiResponse = response.json().await?;
            if !payload.success.unwrap_or(true) {
                return Err(AppError::BadResponse(
                    payload
                        .error_code
                        .unwrap_or_else(|| "sporttery returned failure".to_string()),
                ));
            }

            let items = payload.value.map(|value| value.list).unwrap_or_default();
            let fetched_count = items.len();
            if fetched_count == 0 {
                break;
            }
            for item in items {
                draws.push(parse_item(item)?);
                if draws.len() >= target_count {
                    break;
                }
            }
            if fetched_count < MAX_PAGE_SIZE {
                break;
            }
            page_no += 1;
        }
        Ok(draws)
    }
}

fn parse_item(item: ApiItem) -> AppResult<DrawRecord> {
    let parts: Vec<u8> = item
        .draw_result
        .split_whitespace()
        .map(|s| {
            s.parse::<u8>()
                .map_err(|err| AppError::BadResponse(format!("无法解析大乐透号码 {s}：{err}")))
        })
        .collect::<AppResult<_>>()?;
    if parts.len() != 7 {
        return Err(AppError::BadResponse(format!(
            "大乐透开奖号码长度异常：{}",
            item.draw_result
        )));
    }
    let (front, back) = parts.split_at(5);
    Ok(DrawRecord {
        lottery_type: "dlt".to_string(),
        issue: item.draw_num.trim().to_string(),
        draw_date: item.draw_time.trim().to_string(),
        numbers: serde_json::json!({
            "front": front,
            "back": back,
        }),
        source_name: NAME.to_string(),
        source_url: Some(URL.to_string()),
    })
}
