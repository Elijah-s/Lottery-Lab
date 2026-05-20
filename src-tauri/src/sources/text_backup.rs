//! 17500.cn plain-text backup sources for SSQ and DLT.
//!
//! The official welfare-lottery endpoint is frequently blocked by WAF.
//! 17500 exposes long-running historical text files that are easy to
//! parse and sufficient as a degraded fallback source.

use async_trait::async_trait;
use reqwest::Client;

use crate::errors::{AppError, AppResult};
use crate::sources::{DrawRecord, DrawSource};

const SSQ_NAME: &str = "17500-ssq-text";
const SSQ_URL: &str = "https://www.17500.cn/getData/ssq.TXT";
const DLT_NAME: &str = "17500-dlt-text";
const DLT_URL: &str = "https://www.17500.cn/getData/dlt.TXT";

pub struct SsqTextBackupSource {
    client: Client,
}

impl SsqTextBackupSource {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl DrawSource for SsqTextBackupSource {
    fn name(&self) -> &'static str {
        SSQ_NAME
    }

    fn url_hint(&self) -> Option<&'static str> {
        Some(SSQ_URL)
    }

    async fn fetch(&self, limit: usize) -> AppResult<Vec<DrawRecord>> {
        let text = fetch_text(&self.client, SSQ_URL).await?;
        let mut draws = Vec::with_capacity(limit);
        for line in text.lines().rev().take(limit) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 {
                continue;
            }
            let red = parse_numbers(&parts[2..8])?;
            let blue = parse_numbers(&parts[8..9])?;
            draws.push(DrawRecord {
                lottery_type: "ssq".to_string(),
                issue: parts[0].trim().to_string(),
                draw_date: parts[1].trim().to_string(),
                numbers: serde_json::json!({ "red": red, "blue": blue }),
                source_name: SSQ_NAME.to_string(),
                source_url: Some(SSQ_URL.to_string()),
            });
        }
        Ok(draws)
    }
}

pub struct DltTextBackupSource {
    client: Client,
}

impl DltTextBackupSource {
    pub fn new(client: Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl DrawSource for DltTextBackupSource {
    fn name(&self) -> &'static str {
        DLT_NAME
    }

    fn url_hint(&self) -> Option<&'static str> {
        Some(DLT_URL)
    }

    async fn fetch(&self, limit: usize) -> AppResult<Vec<DrawRecord>> {
        let text = fetch_text(&self.client, DLT_URL).await?;
        let mut draws = Vec::with_capacity(limit);
        for line in text.lines().rev().take(limit) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 9 {
                continue;
            }
            let front = parse_numbers(&parts[2..7])?;
            let back = parse_numbers(&parts[7..9])?;
            draws.push(DrawRecord {
                lottery_type: "dlt".to_string(),
                issue: parts[0].trim().to_string(),
                draw_date: parts[1].trim().to_string(),
                numbers: serde_json::json!({ "front": front, "back": back }),
                source_name: DLT_NAME.to_string(),
                source_url: Some(DLT_URL.to_string()),
            });
        }
        Ok(draws)
    }
}

async fn fetch_text(client: &Client, url: &str) -> AppResult<String> {
    client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await
        .map_err(AppError::from)
}

fn parse_numbers(parts: &[&str]) -> AppResult<Vec<u8>> {
    parts
        .iter()
        .map(|part| {
            part.parse::<u8>().map_err(|err| {
                AppError::BadResponse(format!("无法解析备用源号码 {part}：{err}"))
            })
        })
        .collect()
}
