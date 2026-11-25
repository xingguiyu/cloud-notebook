//! AI：各服务商的 API Key 存在系统钥匙串（配置文件只记「是否已设置」），
//! OpenAI 兼容服务的请求在这里发出：避开网页跨域限制，Key 也不经过前端。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// 支持的服务商。除 Anthropic 外都走 OpenAI 兼容接口
const PROVIDERS: &[&str] = &[
    "anthropic",
    "openai",
    "gemini",
    "grok",
    "deepseek",
    "qwen",
    "openhubs",
    "custom",
];

pub(crate) fn secret_name(provider: &str) -> Result<String, String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("未知的服务商：{provider}"));
    }
    // Anthropic 沿用早期版本的名字，已保存的 Key 不用重填
    Ok(if provider == "anthropic" {
        "anthropic-api-key".into()
    } else {
        format!("ai-key-{provider}")
    })
}

/// 钥匙串项名 → 服务商
pub(crate) fn provider_of_secret(name: &str) -> Option<String> {
    if name == "anthropic-api-key" {
        return Some("anthropic".into());
    }
    name.strip_prefix("ai-key-")
        .filter(|p| PROVIDERS.contains(p))
        .map(String::from)
}

fn flag_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("ai.json"))
}

/// 各服务商是否已保存 Key（读配置标记，不读钥匙串）
#[tauri::command]
pub fn ai_key_status(app: AppHandle) -> HashMap<String, bool> {
    let v: serde_json::Value = flag_path(&app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut out: HashMap<String, bool> = PROVIDERS
        .iter()
        .map(|p| (p.to_string(), v["keys"][p].as_bool().unwrap_or(false)))
        .collect();
    // 兼容早期只有 Anthropic 时的格式
    if v["has_key"].as_bool() == Some(true) {
        out.insert("anthropic".into(), true);
    }
    out
}

pub(crate) fn write_flag(app: &AppHandle, provider: &str, has_key: bool) -> Result<(), String> {
    let mut status = ai_key_status(app.clone());
    status.insert(provider.into(), has_key);
    let p = flag_path(app)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(p, serde_json::json!({ "keys": status }).to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_set_provider_key(app: AppHandle, provider: String, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Key 不能为空".into());
    }
    if provider == "anthropic" && !key.starts_with("sk-ant-") {
        return Err("这不像是 Anthropic 的 API Key（应以 sk-ant- 开头）".into());
    }
    crate::secrets::set(&secret_name(&provider)?, key)?;
    write_flag(&app, &provider, true)
}

#[tauri::command]
pub async fn ai_clear_provider_key(app: AppHandle, provider: String) -> Result<(), String> {
    crate::secrets::delete(&secret_name(&provider)?);
    write_flag(&app, &provider, false)
}

fn provider_key(provider: &str) -> Result<String, String> {
    crate::secrets::get(&secret_name(provider)?)?
        .ok_or_else(|| format!("还没有设置 {provider} 的 API Key"))
}

/// Anthropic 的请求由前端官方 SDK 发出，需要取 Key
#[tauri::command]
pub async fn ai_get_key() -> Result<String, String> {
    provider_key("anthropic")
}

// ---------------- OpenAI 兼容接口 ----------------

/// 只允许 https，或本机的 http（Ollama、LM Studio 等本地服务）
fn check_base(base: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base.trim()).map_err(|_| "接口地址不是有效的网址".to_string())?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("接口地址必须是 https（本机服务可以用 http://localhost）".into());
    }
    Ok(base.trim().trim_end_matches('/').to_string())
}

fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let msg = v["error"]["message"]
        .as_str()
        .or(v["message"].as_str())
        .unwrap_or(body);
    match status.as_u16() {
        401 | 403 => format!("API Key 无效或没有权限（{status}）：{msg}"),
        429 => format!("请求太频繁或额度不足（429）：{msg}"),
        _ => format!("模型服务返回错误（{status}）：{msg}"),
    }
}

fn net_error(e: reqwest::Error) -> String {
    if e.is_connect() || e.is_timeout() {
        format!("连不上模型服务，请检查网络或代理（{e}）")
    } else {
        e.to_string()
    }
}

/// 拉取服务商可用的模型列表（GET {base}/models）
#[tauri::command]
pub async fn ai_list_models(provider: String, base_url: String) -> Result<Vec<String>, String> {
    let base = check_base(&base_url)?;
    let key = provider_key(&provider)?;
    let resp = crate::google::http_client()
        .get(format!("{base}/models"))
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(net_error)?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(http_error(status, &body));
    }
    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    m["id"]
                        .as_str()
                        .map(|s| s.trim_start_matches("models/").to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

#[derive(Default)]
pub struct ChatState {
    tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(serde::Serialize, Clone)]
struct StreamEvent {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

/// 发起流式对话（POST {base}/chat/completions, stream=true），增量通过 `ai-stream` 事件推给前端。
/// `body` 是除 stream 以外的完整请求体，由前端组装。
#[tauri::command]
pub fn ai_chat_start(
    app: AppHandle,
    state: State<'_, ChatState>,
    id: String,
    provider: String,
    base_url: String,
    body: serde_json::Value,
) -> Result<(), String> {
    let base = check_base(&base_url)?;
    let key = provider_key(&provider)?;
    let handle_app = app.clone();
    let req_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let emit = |ev: StreamEvent| {
            let _ = handle_app.emit("ai-stream", ev);
        };
        let result = stream_chat(&base, &key, body, |delta, model| {
            emit(StreamEvent {
                id: req_id.clone(),
                delta: Some(delta),
                done: false,
                error: None,
                model,
            });
        })
        .await;
        emit(StreamEvent {
            id: req_id.clone(),
            delta: None,
            done: true,
            error: result.err(),
            model: None,
        });
        handle_app
            .state::<ChatState>()
            .tasks
            .lock()
            .unwrap()
            .remove(&req_id);
    });
    state.tasks.lock().unwrap().insert(id, task);
    Ok(())
}

#[tauri::command]
pub fn ai_chat_cancel(state: State<'_, ChatState>, id: String) {
    if let Some(t) = state.tasks.lock().unwrap().remove(&id) {
        t.abort();
    }
}

async fn stream_chat(
    base: &str,
    key: &str,
    mut body: serde_json::Value,
    mut on_delta: impl FnMut(String, Option<String>),
) -> Result<(), String> {
    use futures_util::StreamExt;
    body["stream"] = serde_json::json!(true);
    let resp = crate::google::http_client()
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(net_error)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(http_error(status, &resp.text().await.unwrap_or_default()));
    }
    // SSE：按行解析 `data: {...}`，`data: [DONE]` 结束
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(&chunk.map_err(net_error)?));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].to_string();
            buf.drain(..=pos);
            match parse_sse_line(&line) {
                Sse::Delta(text, model) => on_delta(text, model),
                Sse::Done => return Ok(()),
                Sse::Error(e) => return Err(e),
                Sse::Skip => {}
            }
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Sse {
    Delta(String, Option<String>),
    Done,
    Error(String),
    Skip,
}

/// 解析一行 SSE：`data: {...}` 里取 choices[0].delta.content；空行、注释、心跳都跳过
fn parse_sse_line(line: &str) -> Sse {
    let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else {
        return Sse::Skip;
    };
    if data == "[DONE]" {
        return Sse::Done;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return Sse::Skip;
    };
    if let Some(err) = v["error"]["message"].as_str() {
        return Sse::Error(format!("模型服务返回错误：{err}"));
    }
    match v["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => {
            Sse::Delta(t.to_string(), v["model"].as_str().map(String::from))
        }
        _ => Sse::Skip,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sse_lines() {
        assert_eq!(
            parse_sse_line(r#"data: {"model":"m1","choices":[{"delta":{"content":"你好"}}]}"#),
            Sse::Delta("你好".into(), Some("m1".into()))
        );
        assert_eq!(parse_sse_line("data: [DONE]"), Sse::Done);
        assert_eq!(parse_sse_line(": keep-alive"), Sse::Skip);
        assert_eq!(
            parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#),
            Sse::Skip
        );
        assert!(matches!(
            parse_sse_line(r#"data: {"error":{"message":"bad"}}"#),
            Sse::Error(_)
        ));
    }

    /// 本机起一个假的 OpenAI 兼容服务，按 SSE 分段返回（含被拆开的半行），验证流式拼接
    #[test]
    fn streams_chat_from_openai_compatible_server() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let n = s.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.starts_with("POST /v1/chat/completions"));
            assert!(
                req.to_lowercase()
                    .contains("authorization: bearer test-key")
            );
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .unwrap();
            let parts = [
                ": ping\n\n",
                "data: {\"model\":\"m\",\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n",
                "data: {\"model\":\"m\",\"choices\":[{\"del",
                "ta\":{\"content\":\"好[1]\"}}]}\n\n",
                "data: [DONE]\n\n",
            ];
            for p in parts {
                s.write_all(p.as_bytes()).unwrap();
                s.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        });
        let mut out = String::new();
        let r = tauri::async_runtime::block_on(stream_chat(
            &format!("http://127.0.0.1:{port}/v1"),
            "test-key",
            serde_json::json!({ "model": "m", "messages": [] }),
            |d, _| out.push_str(&d),
        ));
        assert!(r.is_ok(), "{r:?}");
        assert_eq!(out, "你好[1]");
    }

    #[test]
    fn base_url_must_be_https_or_local() {
        assert!(
            check_base("https://api.deepseek.com/v1/")
                .unwrap()
                .ends_with("/v1")
        );
        assert!(check_base("http://localhost:11434/v1").is_ok());
        assert!(check_base("http://evil.example.com/v1").is_err());
    }
}

#[derive(serde::Serialize)]
pub struct Attachment {
    name: String,
    media_type: String,
    /// base64
    data: String,
}

/// 读取用户在对话框里选的附件（图片或 PDF），转成 base64 发给模型
#[tauri::command]
pub async fn ai_read_attachment(path: String) -> Result<Attachment, String> {
    use base64::Engine;
    let p = std::path::Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let media_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        _ => return Err("只支持图片（png / jpg / gif / webp）和 PDF".into()),
    };
    let meta = fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("文件超过 20 MB".into());
    }
    let bytes = fs::read(p).map_err(|e| e.to_string())?;
    Ok(Attachment {
        name: p
            .file_name()
            .map(|n| n.to_string_lossy().into())
            .unwrap_or_default(),
        media_type: media_type.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
