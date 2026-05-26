//! Multi-provider chat client.
//!
//! Dispatches on `LlmConfig::provider`:
//! - `"anthropic"` → native Messages API (`/v1/messages`, `x-api-key`,
//!   `anthropic-version` header, top-level `system` field, `content[]`
//!   response shape)
//! - everything else → OpenAI-compatible chat completions
//!   (`/chat/completions`, `Authorization: Bearer …`)
//!
//! Both branches collapse the response into a single markdown string
//! so the caller stays provider-agnostic.

use reqwest::{Client, RequestBuilder, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::errors::{AppError, AppResult};

const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_DEFAULT_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_MAX_TOKENS: u32 = 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LlmConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

pub async fn chat_once(
    client: &Client,
    config: &LlmConfig,
    messages: &[ChatMessage],
) -> AppResult<String> {
    validate_config(config, true)?;
    if is_anthropic(config) {
        chat_anthropic(client, config, messages).await
    } else {
        chat_openai_compatible(client, config, messages).await
    }
}

pub async fn list_models(client: &Client, config: &LlmConfig) -> AppResult<Vec<String>> {
    validate_config(config, false)?;
    if is_anthropic(config) {
        list_anthropic_models(client, config).await
    } else {
        list_openai_compatible_models(client, config).await
    }
}

pub async fn test_connection(client: &Client, config: &LlmConfig) -> AppResult<String> {
    let reply = chat_once(
        client,
        config,
        &[ChatMessage {
            role: "user".to_string(),
            content: "请只回复 OK。".to_string(),
        }],
    )
    .await?;
    Ok(compact_text(&reply, 120))
}

fn is_anthropic(config: &LlmConfig) -> bool {
    if config.provider.eq_ignore_ascii_case("anthropic") {
        return true;
    }
    // Fall back to URL heuristic so users pasting an Anthropic URL into
    // the "custom" provider slot still get the native adapter.
    config.base_url.contains("anthropic.com")
}

fn validate_config(config: &LlmConfig, require_model: bool) -> AppResult<()> {
    if config.base_url.trim().is_empty() {
        return Err(AppError::Config("模型接口地址未配置。".to_string()));
    }
    if require_model && config.model.trim().is_empty() {
        return Err(AppError::Config("模型名称未配置。".to_string()));
    }
    if config.api_key.trim().is_empty() && requires_api_key(config) {
        return Err(AppError::Config(
            "接口密钥未配置，请在设置页填写。".to_string(),
        ));
    }
    Ok(())
}

pub fn requires_api_key(config: &LlmConfig) -> bool {
    if is_anthropic(config) {
        return true;
    }
    if config.provider.eq_ignore_ascii_case("lmstudio") {
        return false;
    }
    let base = config.base_url.to_ascii_lowercase();
    !(base.contains("127.0.0.1") || base.contains("localhost") || base.contains("[::1]"))
}

fn with_optional_bearer_auth(request: RequestBuilder, config: &LlmConfig) -> RequestBuilder {
    if config.api_key.trim().is_empty() {
        request
    } else {
        request.bearer_auth(config.api_key.trim())
    }
}

fn compact_text(text: &str, max_chars: usize) -> String {
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(max_chars).collect()
}

// --- OpenAI-compatible branch ---------------------------------------------

#[derive(Debug, Serialize)]
struct OpenAiChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    temperature: f32,
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChatChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiChatMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatMessage {
    content: String,
}

async fn chat_openai_compatible(
    client: &Client,
    config: &LlmConfig,
    messages: &[ChatMessage],
) -> AppResult<String> {
    let url = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );
    let body = OpenAiChatRequest {
        model: &config.model,
        messages,
        temperature: 0.4,
        stream: false,
    };
    let response = with_optional_bearer_auth(client.post(url), config)
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response_text_for_error(response, "智能模型").await;
        return Err(AppError::BadResponse(format!("智能模型 {status}: {text}")));
    }
    let payload: OpenAiChatResponse = parse_json_response(response, "智能模型").await?;
    payload
        .choices
        .into_iter()
        .next()
        .map(|choice| choice.message.content)
        .ok_or_else(|| AppError::BadResponse("智能模型响应缺少候选内容".to_string()))
}

async fn list_openai_compatible_models(
    client: &Client,
    config: &LlmConfig,
) -> AppResult<Vec<String>> {
    let url = format!("{}/models", config.base_url.trim_end_matches('/'));
    let response = with_optional_bearer_auth(client.get(url), config)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response_text_for_error(response, "模型列表").await;
        return Err(AppError::BadResponse(format!(
            "模型列表 {status}: {}",
            compact_text(&text, 240)
        )));
    }
    let payload: Value = parse_json_response(response, "模型列表").await?;
    parse_model_list(payload)
}

// --- Anthropic native branch ----------------------------------------------

#[derive(Debug, Serialize)]
struct AnthropicRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    messages: Vec<AnthropicMessage<'a>>,
}

#[derive(Debug, Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    #[serde(default)]
    content: Vec<AnthropicContentBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicContentBlock {
    Text { text: String },
    #[serde(other)]
    Unknown,
}

async fn chat_anthropic(
    client: &Client,
    config: &LlmConfig,
    messages: &[ChatMessage],
) -> AppResult<String> {
    let base = anthropic_base(config);
    let url = format!("{base}/v1/messages");

    // Anthropic expects `system` at the top level and only user /
    // assistant turns in `messages`. We fold any system-role entries
    // into a single system string (joined by blank lines), keeping the
    // original order.
    let mut system_parts: Vec<String> = Vec::new();
    let mut conversation: Vec<AnthropicMessage<'_>> = Vec::new();
    for message in messages {
        match message.role.as_str() {
            "system" => system_parts.push(message.content.clone()),
            "assistant" => conversation.push(AnthropicMessage {
                role: "assistant",
                content: message.content.as_str(),
            }),
            _ => conversation.push(AnthropicMessage {
                role: "user",
                content: message.content.as_str(),
            }),
        }
    }
    // If the caller only supplied system prompts, promote them into a
    // user turn so the API has something to answer. We bind the owned
    // String here so the borrow inside `AnthropicMessage` outlives the
    // request body.
    let fallback_user: String;
    if conversation.is_empty() {
        fallback_user = if system_parts.is_empty() {
            "Hello".to_string()
        } else {
            system_parts.join("\n\n")
        };
        conversation.push(AnthropicMessage {
            role: "user",
            content: fallback_user.as_str(),
        });
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };

    let body = AnthropicRequest {
        model: &config.model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        temperature: 0.4,
        system,
        messages: conversation,
    };

    let response = client
        .post(url)
        .header("x-api-key", &config.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response_text_for_error(response, "克劳德接口").await;
        return Err(AppError::BadResponse(format!(
            "克劳德接口 {status}: {text}"
        )));
    }
    let payload: AnthropicResponse = parse_json_response(response, "克劳德接口").await?;
    let text_parts: Vec<String> = payload
        .content
        .into_iter()
        .filter_map(|block| match block {
            AnthropicContentBlock::Text { text } => Some(text),
            AnthropicContentBlock::Unknown => None,
        })
        .collect();
    if text_parts.is_empty() {
        return Err(AppError::BadResponse(
            "克劳德接口响应中没有文本内容".to_string(),
        ));
    }
    Ok(text_parts.join("\n"))
}

async fn list_anthropic_models(client: &Client, config: &LlmConfig) -> AppResult<Vec<String>> {
    let base = anthropic_base(config);
    let response = client
        .get(format!("{base}/v1/models"))
        .header("x-api-key", config.api_key.trim())
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response_text_for_error(response, "克劳德模型列表").await;
        return Err(AppError::BadResponse(format!(
            "克劳德模型列表 {status}: {}",
            compact_text(&text, 240)
        )));
    }
    let payload: Value = parse_json_response(response, "克劳德模型列表").await?;
    parse_model_list(payload)
}

fn anthropic_base(config: &LlmConfig) -> String {
    let base = if config.base_url.trim().is_empty() {
        ANTHROPIC_DEFAULT_BASE
    } else {
        config.base_url.trim()
    };
    base.trim_end_matches('/')
        .trim_end_matches("/v1")
        .to_string()
}

async fn parse_json_response<T>(response: Response, context: &str) -> AppResult<T>
where
    T: DeserializeOwned,
{
    let text = read_response_text(response, context).await?;
    parse_json_text(&text, context)
}

async fn read_response_text(response: Response, context: &str) -> AppResult<String> {
    response.text().await.map_err(|err| {
        AppError::BadResponse(format!("{context}响应读取失败：{}", err))
    })
}

async fn response_text_for_error(response: Response, context: &str) -> String {
    match read_response_text(response, context).await {
        Ok(text) => text,
        Err(err) => err.to_string(),
    }
}

fn parse_json_text<T>(text: &str, context: &str) -> AppResult<T>
where
    T: DeserializeOwned,
{
    if text.trim().is_empty() {
        return Err(AppError::BadResponse(format!("{context}响应为空。")));
    }
    serde_json::from_str(text).map_err(|err| {
        AppError::BadResponse(format!(
            "{context}响应不是有效 JSON：{}。响应摘要：{}",
            err,
            compact_text(text, 240)
        ))
    })
}

fn parse_model_list(payload: Value) -> AppResult<Vec<String>> {
    let mut models = Vec::new();
    collect_model_ids(&payload, &mut models);
    models.sort();
    models.dedup();
    if models.is_empty() {
        return Err(AppError::BadResponse(format!(
            "模型列表为空或格式不受支持。响应摘要：{}",
            compact_text(&payload.to_string(), 240)
        )));
    }
    Ok(models)
}

fn collect_model_ids(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(model) => push_model_id(out, model),
        Value::Array(items) => {
            for item in items {
                collect_model_ids(item, out);
            }
        }
        Value::Object(map) => {
            for key in ["id", "name", "model"] {
                if let Some(Value::String(model)) = map.get(key) {
                    push_model_id(out, model);
                    return;
                }
            }
            for key in ["data", "models"] {
                if let Some(nested) = map.get(key) {
                    collect_model_ids(nested, out);
                }
            }
        }
        _ => {}
    }
}

fn push_model_id(out: &mut Vec<String>, model: &str) {
    let id = model.trim();
    if !id.is_empty() {
        out.push(id.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_anthropic_by_provider() {
        let config = LlmConfig {
            provider: "anthropic".to_string(),
            base_url: "https://example.test".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            api_key: "test-key".to_string(),
        };
        assert!(is_anthropic(&config));
    }

    #[test]
    fn is_anthropic_by_url_fallback() {
        let config = LlmConfig {
            provider: "custom".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            ..Default::default()
        };
        assert!(is_anthropic(&config));
    }

    #[test]
    fn openai_default_still_detected_as_openai() {
        let config = LlmConfig {
            provider: "openai".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            ..Default::default()
        };
        assert!(!is_anthropic(&config));
    }

    #[test]
    fn local_openai_compatible_does_not_require_key() {
        let config = LlmConfig {
            provider: "lmstudio".to_string(),
            base_url: "http://127.0.0.1:1234/v1".to_string(),
            ..Default::default()
        };
        assert!(!requires_api_key(&config));
    }

    #[test]
    fn anthropic_base_strips_optional_v1_suffix() {
        let config = LlmConfig {
            base_url: "https://api.anthropic.com/v1".to_string(),
            ..Default::default()
        };
        assert_eq!(anthropic_base(&config), "https://api.anthropic.com");
    }

    #[test]
    fn anthropic_content_block_deserialization() {
        // Real Messages API payload trimmed to the interesting bits.
        let json = r#"{
            "content": [
                { "type": "text", "text": "hello" },
                { "type": "tool_use", "id": "abc", "name": "n", "input": {} },
                { "type": "text", "text": "world" }
            ]
        }"#;
        let parsed: AnthropicResponse = serde_json::from_str(json).unwrap();
        let texts: Vec<String> = parsed
            .content
            .into_iter()
            .filter_map(|block| match block {
                AnthropicContentBlock::Text { text } => Some(text),
                AnthropicContentBlock::Unknown => None,
            })
            .collect();
        assert_eq!(texts, vec!["hello".to_string(), "world".to_string()]);
    }

    #[test]
    fn parses_openai_model_data_objects() {
        let payload = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-4o-mini", "object": "model" },
                { "id": "gpt-4.1" }
            ]
        });
        assert_eq!(
            parse_model_list(payload).unwrap(),
            vec!["gpt-4.1".to_string(), "gpt-4o-mini".to_string()]
        );
    }

    #[test]
    fn parses_common_openai_compatible_model_shapes() {
        let payload = serde_json::json!({
            "data": ["deepseek-chat"],
            "models": [
                { "name": "qwen-plus" },
                { "model": "glm-4" }
            ]
        });
        assert_eq!(
            parse_model_list(payload).unwrap(),
            vec![
                "deepseek-chat".to_string(),
                "glm-4".to_string(),
                "qwen-plus".to_string()
            ]
        );
    }

    #[test]
    fn parses_top_level_model_array() {
        let payload = serde_json::json!(["local-a", "local-b"]);
        assert_eq!(
            parse_model_list(payload).unwrap(),
            vec!["local-a".to_string(), "local-b".to_string()]
        );
    }

    #[test]
    fn rejects_unsupported_model_list_with_summary() {
        let err = parse_model_list(serde_json::json!({ "ok": true }))
            .unwrap_err()
            .to_string();
        assert!(err.contains("模型列表为空或格式不受支持"));
        assert!(err.contains("\"ok\":true"));
    }

    #[test]
    fn invalid_json_error_keeps_context_and_summary() {
        let err = parse_json_text::<Value>("<html>bad gateway</html>", "模型列表")
            .unwrap_err()
            .to_string();
        assert!(err.contains("模型列表响应不是有效 JSON"));
        assert!(err.contains("bad gateway"));
    }
}
