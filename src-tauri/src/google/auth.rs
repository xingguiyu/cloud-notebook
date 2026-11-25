use super::{GoogleState, Result, err};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

const SECRET_NAME: &str = "google-refresh-token";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.file";

/// 客户端 ID / Secret 和登录账号，存在应用配置目录的 google.json。
/// 桌面应用的 client secret 按 Google 的说明不算机密，只是协议要求带上。
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct GoogleConfig {
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default = "yes")]
    pub auto_sync: bool,
    /// iOS 类型的 OAuth 客户端 ID（手机用；没有密钥，回调走自定义 URL scheme）
    #[serde(default)]
    pub ios_client_id: String,
}

/// 构建时可以内置 iOS 客户端 ID：CN_GOOGLE_IOS_CLIENT_ID=xxx.apps.googleusercontent.com
const BUILTIN_IOS_CLIENT_ID: Option<&str> = option_env!("CN_GOOGLE_IOS_CLIENT_ID");

/// 当前平台用的 OAuth 客户端：（客户端 ID，客户端密钥）
pub(crate) fn oauth_client(cfg: &GoogleConfig) -> (String, Option<String>) {
    if cfg!(mobile) {
        let id = if cfg.ios_client_id.is_empty() {
            BUILTIN_IOS_CLIENT_ID.unwrap_or("").to_string()
        } else {
            cfg.ios_client_id.clone()
        };
        (id, None)
    } else {
        (cfg.client_id.clone(), Some(cfg.client_secret.clone()))
    }
}

/// iOS 客户端的回调地址：反写的客户端 ID 作为 URL scheme
fn ios_redirect(client_id: &str) -> String {
    format!(
        "com.googleusercontent.apps.{}:/oauth2redirect",
        client_id.trim_end_matches(".apps.googleusercontent.com")
    )
}

fn token_form<'a>(client: &'a (String, Option<String>), extra: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut f = vec![("client_id", client.0.as_str())];
    if let Some(sec) = &client.1 {
        f.push(("client_secret", sec.as_str()));
    }
    f.extend_from_slice(extra);
    f
}

fn yes() -> bool {
    true
}

fn config_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(err)?
        .join("google.json"))
}

pub fn load_config(app: &AppHandle) -> GoogleConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &GoogleConfig) -> Result<()> {
    let p = config_path(app)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(err)?;
    std::fs::write(p, serde_json::to_string_pretty(cfg).map_err(err)?).map_err(err)
}

#[derive(Serialize)]
pub struct GoogleStatus {
    configured: bool,
    client_id: String,
    email: Option<String>,
    auto_sync: bool,
}

#[tauri::command]
pub async fn google_status(app: AppHandle) -> GoogleStatus {
    // 登录状态看配置里的邮箱，不读钥匙串（读钥匙串可能触发系统授权弹窗）
    let cfg = load_config(&app);
    GoogleStatus {
        configured: !oauth_client(&cfg).0.is_empty(),
        client_id: cfg.client_id,
        email: cfg.email,
        auto_sync: cfg.auto_sync,
    }
}

/// 客户端 ID / Secret（设置同步用；桌面应用的 client secret 不算机密）
#[tauri::command]
pub fn google_client_config(app: AppHandle) -> (String, String) {
    let cfg = load_config(&app);
    (cfg.client_id, cfg.client_secret)
}

/// 手机上的 iOS 客户端 ID（会随设置同步）
#[tauri::command]
pub fn google_ios_client(app: AppHandle) -> String {
    load_config(&app).ios_client_id
}

#[tauri::command]
pub fn google_set_ios_client(app: AppHandle, client_id: String) -> Result<()> {
    let mut cfg = load_config(&app);
    cfg.ios_client_id = client_id.trim().into();
    save_config(&app, &cfg)
}

/// 手机：系统通过自定义 URL scheme 把授权回调交回应用，前端转给这里
#[tauri::command]
pub fn google_oauth_callback(url: String, state: State<'_, GoogleState>) {
    if let Some(tx) = state.pending_callback.lock().unwrap().take() {
        let _ = tx.send(url);
    }
}

/// 从回调链接里取授权码
fn code_from_callback(url: &str, expected_state: &str) -> Result<String> {
    let u = reqwest::Url::parse(url).map_err(err)?;
    let get = |k: &str| u.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.into_owned());
    if let Some(e) = get("error") {
        return Err(format!("授权被拒绝：{e}"));
    }
    if get("state").as_deref() != Some(expected_state) {
        return Err("授权回调校验失败".into());
    }
    get("code").ok_or_else(|| "授权回调里没有授权码".into())
}

#[tauri::command]
pub async fn google_set_config(app: AppHandle, client_id: String, client_secret: String) -> Result<()> {
    let mut cfg = load_config(&app);
    cfg.client_id = client_id.trim().into();
    cfg.client_secret = client_secret.trim().into();
    save_config(&app, &cfg)
}

#[tauri::command]
pub fn google_set_auto_sync(app: AppHandle, enabled: bool) -> Result<()> {
    let mut cfg = load_config(&app);
    cfg.auto_sync = enabled;
    save_config(&app, &cfg)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    /// 实际授予的权限；用户可能在授权页取消勾选 Drive
    scope: Option<String>,
}

const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

fn cache_token(state: &GoogleState, t: &TokenResponse) {
    // 提前一分钟当作过期，避免请求途中失效
    let expires = Instant::now() + Duration::from_secs(t.expires_in.saturating_sub(60));
    *state.token.lock().unwrap() = Some((t.access_token.clone(), expires));
}

/// 等浏览器回调到本机端口，取出授权码。超时 5 分钟。
fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String> {
    listener.set_nonblocking(true).map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(300);
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream.set_nonblocking(false).map_err(err)?;
                // 连上来却不发数据的连接不能把登录流程卡住
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let mut buf = [0u8; 4096];
                let Ok(n) = stream.read(&mut buf) else { continue };
                let req = String::from_utf8_lossy(&buf[..n]);
                let query = req
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|path| path.split_once('?'))
                    .map(|(_, q)| q.to_string())
                    .unwrap_or_default();
                let param = |k: &str| {
                    query.split('&').find_map(|kv| {
                        kv.split_once('=')
                            .filter(|(key, _)| *key == k)
                            .map(|(_, v)| crate::vault::percent_decode(v))
                    })
                };
                // 浏览器还会请求 favicon 之类，没有 code/error 的忽略
                if param("code").is_none() && param("error").is_none() {
                    let _ =
                        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
                // state 对不上的请求不是这次登录的回调（本机别的程序或网页在探测端口）：回个错误，继续等真正的回调
                if param("state").as_deref() != Some(expected_state) {
                    let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
                let ok = param("code").is_some();
                let body = if ok {
                    "<h2>登录成功</h2><p>可以关闭此页面，回到 Cloud Notebook。</p>"
                } else {
                    "<h2>登录未完成</h2><p>请回到 Cloud Notebook 重试。</p>"
                };
                let html = format!(
                    "<!doctype html><meta charset=utf-8><body style=\"font:16px -apple-system,sans-serif;text-align:center;padding-top:80px\">{body}</body>"
                );
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                        html.len()
                    )
                    .as_bytes(),
                );
                if let Some(e) = param("error") {
                    return Err(format!("授权被拒绝：{e}"));
                }
                if !ok {
                    return Err("授权回调校验失败".into());
                }
                return Ok(param("code").unwrap());
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() > deadline {
                    return Err("登录超时，请重试".into());
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(err(e)),
        }
    }
}

fn random_string(len: usize) -> String {
    let bytes: Vec<u8> = (0..len).map(|_| rand::thread_rng().r#gen()).collect();
    URL_SAFE_NO_PAD.encode(bytes)
}

/// 桌面 OAuth：系统浏览器登录 + 本机回环地址回调 + PKCE
#[tauri::command]
pub async fn google_login(app: AppHandle, state: State<'_, GoogleState>) -> Result<String> {
    let cfg = load_config(&app);
    let client = oauth_client(&cfg);
    if client.0.is_empty() {
        return Err(if cfg!(mobile) { "请先填写 Google iOS 客户端 ID" } else { "请先填写 Google OAuth 客户端 ID" }.into());
    }
    let verifier = random_string(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let csrf = random_string(16);
    // 电脑：本机回环端口接回调；手机：自定义 URL scheme 回到应用
    let listener = if cfg!(mobile) { None } else { Some(TcpListener::bind("127.0.0.1:0").map_err(err)?) };
    let redirect = match &listener {
        Some(l) => format!("http://127.0.0.1:{}", l.local_addr().map_err(err)?.port()),
        None => ios_redirect(&client.0),
    };
    let (cb_tx, cb_rx) = std::sync::mpsc::channel::<String>();
    if listener.is_none() {
        *state.pending_callback.lock().unwrap() = Some(cb_tx);
    }

    let url = reqwest::Url::parse_with_params(
        "https://accounts.google.com/o/oauth2/v2/auth",
        &[
            ("client_id", client.0.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("state", csrf.as_str()),
        ],
    )
    .map_err(err)?;
    tauri_plugin_opener::open_url(url.as_str(), None::<&str>).map_err(err)?;

    let code = tauri::async_runtime::spawn_blocking(move || match listener {
        Some(l) => wait_for_code(l, &csrf),
        None => {
            let url = cb_rx
                .recv_timeout(Duration::from_secs(300))
                .map_err(|_| "登录超时，请重试".to_string())?;
            code_from_callback(&url, &csrf)
        }
    })
    .await
    .map_err(err)??;

    let resp = crate::google::http_client()
        .post("https://oauth2.googleapis.com/token")
        .form(&token_form(
            &client,
            &[
                ("code", code.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier.as_str()),
            ],
        ))
        .send()
        .await
        .map_err(super::net_err)?;
    if !resp.status().is_success() {
        return Err(format!("换取令牌失败：{}", resp.text().await.unwrap_or_default()));
    }
    let token: TokenResponse = resp.json().await.map_err(err)?;
    // Google 的授权页对 Drive 权限是单独的勾选框，没勾就点继续，令牌里不会有这个权限
    if !token
        .scope
        .as_deref()
        .unwrap_or("")
        .split(' ')
        .any(|s| s == DRIVE_SCOPE)
    {
        return Err("没有获得 Google Drive 权限。请重新登录，并在 Google 授权页里勾选「查看、修改、创建和删除通过此应用使用的 Google 云端硬盘文件」。".into());
    }
    let refresh = token
        .refresh_token
        .clone()
        .ok_or("Google 没有返回 refresh token")?;
    crate::secrets::set(SECRET_NAME, &refresh)?;
    cache_token(&state, &token);

    #[derive(Deserialize)]
    struct UserInfo {
        email: Option<String>,
    }
    let info: UserInfo = crate::google::http_client()
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(super::net_err)?
        .json()
        .await
        .map_err(err)?;
    let mut cfg = load_config(&app);
    cfg.email = info.email.clone();
    save_config(&app, &cfg)?;
    Ok(info.email.unwrap_or_default())
}

#[tauri::command]
pub async fn google_logout(app: AppHandle, state: State<'_, GoogleState>) -> Result<()> {
    crate::secrets::delete(SECRET_NAME);
    *state.token.lock().unwrap() = None;
    let mut cfg = load_config(&app);
    cfg.email = None;
    save_config(&app, &cfg)?;
    super::sync::reset_state(&app)
}

/// 拿一个可用的 access token，过期了用钥匙串里的 refresh token 换新
pub async fn access_token(app: &AppHandle) -> Result<String> {
    let state = app.state::<GoogleState>();
    if let Some((t, exp)) = state.token.lock().unwrap().clone() {
        if Instant::now() < exp {
            return Ok(t);
        }
    }
    let refresh = crate::secrets::get(SECRET_NAME)?.ok_or("尚未登录 Google，请在设置里重新登录")?;
    let cfg = load_config(app);
    let resp = crate::google::http_client()
        .post("https://oauth2.googleapis.com/token")
        .form(&token_form(
            &oauth_client(&cfg),
            &[("refresh_token", refresh.as_str()), ("grant_type", "refresh_token")],
        ))
        .send()
        .await
        .map_err(super::net_err)?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        // invalid_grant：刷新令牌过期或被撤销。OAuth 同意屏幕还在「测试」状态时，Google 每 7 天就让它过期一次
        if body.contains("invalid_grant") {
            return Err("登录已失效，请重新登录 Google。\n\n如果每隔 7 天就失效一次：你的 Google Cloud 项目的 OAuth 同意屏幕还处于「测试」状态，这种状态下登录只保留 7 天。到 Google Cloud Console → Google Auth Platform → 目标对象（Audience），把发布状态改成「正式版」即可长期有效（本应用只用 drive.file 权限，不需要 Google 审核）。".into());
        }
        return Err(format!("登录已失效，请重新登录 Google：{body}"));
    }
    let token: TokenResponse = resp.json().await.map_err(err)?;
    cache_token(&state, &token);
    Ok(token.access_token)
}
