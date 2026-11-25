//! S3 兼容图床：AWS S3、Cloudflare R2、阿里云 OSS、腾讯云 COS 等。
//!
//! 笔记原文始终是本地相对路径；只有在「复制为 Markdown」、导出时才上传图片换成网络地址。
//! 对象名按内容哈希生成，同一张图只上传一次。签名是自己实现的 AWS SigV4，不引入 SDK。

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const SECRET_NAME: &str = "imagehost-secret";

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ImageHostConfig {
    #[serde(default)]
    pub provider: String,
    /// 如 https://s3.us-east-1.amazonaws.com、https://<账号>.r2.cloudflarestorage.com、https://oss-cn-hangzhou.aliyuncs.com
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub access_key_id: String,
    /// 对象名前缀，如 `notes/`
    #[serde(default)]
    pub prefix: String,
    /// 对外访问地址（CDN 或自定义域名）；为空时用存储桶的默认地址
    #[serde(default)]
    pub public_base_url: String,
    /// 路径风格 `endpoint/bucket/key`；否则是 `bucket.endpoint/key`（阿里云只支持后者）
    #[serde(default)]
    pub path_style: bool,
    /// 钥匙串里是否存了 Secret Key；状态检查看这个标记，不去读钥匙串
    #[serde(default)]
    pub has_secret: bool,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("imagehost.json"))
}

fn cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("imagehost-cache.json"))
}

fn load_config(app: &AppHandle) -> ImageHostConfig {
    config_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 同步收到（或删掉）图床 Secret 后更新标记
pub(crate) fn set_has_secret(app: &AppHandle, present: bool) {
    let mut c = load_config(app);
    c.has_secret = present;
    if let Ok(p) = config_path(app) {
        let _ = fs::create_dir_all(p.parent().unwrap());
        let _ = fs::write(p, serde_json::to_string_pretty(&c).unwrap_or_default());
    }
}

#[derive(Serialize)]
pub struct ImageHostStatus {
    config: ImageHostConfig,
    has_secret: bool,
    configured: bool,
}

impl ImageHostStatus {
    pub(crate) fn has_secret(&self) -> bool {
        self.has_secret
    }
}

#[tauri::command]
pub fn imagehost_status(app: AppHandle) -> ImageHostStatus {
    let config = load_config(&app);
    let has_secret = config.has_secret;
    let configured = has_secret
        && !config.endpoint.is_empty()
        && !config.bucket.is_empty()
        && !config.access_key_id.is_empty();
    ImageHostStatus {
        config,
        has_secret,
        configured,
    }
}

/// `secret` 为空时保留钥匙串里原有的密钥
#[tauri::command]
pub async fn imagehost_save(
    app: AppHandle,
    config: ImageHostConfig,
    secret: Option<String>,
) -> Result<(), String> {
    let p = config_path(&app)?;
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut c = config;
    c.endpoint = c.endpoint.trim().trim_end_matches('/').to_string();
    c.public_base_url = c.public_base_url.trim().trim_end_matches('/').to_string();
    c.prefix = c.prefix.trim().trim_matches('/').to_string();
    c.has_secret = load_config(&app).has_secret;
    if let Some(s) = secret.filter(|s| !s.trim().is_empty()) {
        crate::secrets::set(SECRET_NAME, s.trim())?;
        c.has_secret = true;
    }
    fs::write(
        p,
        serde_json::to_string_pretty(&c).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // 上传记录按存储桶记，换桶后作废
    let _ = fs::remove_file(cache_path(&app)?);
    Ok(())
}

#[tauri::command]
pub async fn imagehost_clear(app: AppHandle) -> Result<(), String> {
    let _ = fs::remove_file(config_path(&app)?);
    let _ = fs::remove_file(cache_path(&app)?);
    crate::secrets::delete(SECRET_NAME);
    Ok(())
}

// ---------------- SigV4 ----------------

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac 接受任意长度密钥");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// RFC 3986 编码，`/` 按需保留（对象路径里保留）
fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 生成 Authorization 头。`headers` 需要已经包含 host、x-amz-date、x-amz-content-sha256。
fn authorization(
    method: &str,
    path: &str,
    headers: &BTreeMap<String, String>,
    payload_hash: &str,
    region: &str,
    access_key: &str,
    secret: &str,
    amz_date: &str,
) -> String {
    let date = &amz_date[..8];
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical =
        format!("{method}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date}/{region}/s3/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical.as_bytes())
    );
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date);
    let k_region = hmac(&k_date, region);
    let k_service = hmac(&k_region, "s3");
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &to_sign));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// UTC 时间 → `YYYYMMDDTHHMMSSZ`（不引入日期库）
fn amz_date(secs: u64) -> String {
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    // Howard Hinnant 的 civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

struct Target {
    url: String,
    host: String,
    path: String,
}

fn target(c: &ImageHostConfig, key: &str) -> Result<Target, String> {
    let ep = reqwest::Url::parse(&c.endpoint).map_err(|_| "Endpoint 不是有效的网址".to_string())?;
    let scheme = ep.scheme();
    let ep_host = ep.host_str().ok_or("Endpoint 缺少域名")?;
    // 明文 http 会把图片和可重放的签名暴露在网络上；只有本机服务（如本地 MinIO）可以例外
    if scheme != "https" && !(scheme == "http" && matches!(ep_host, "localhost" | "127.0.0.1")) {
        return Err("Endpoint 必须是 https（本机服务可以用 http://localhost）".into());
    }
    // 存储桶名会拼进域名：只允许域名里能出现的字符，否则可以借它把请求指到别的主机
    if c.bucket.is_empty() || !c.bucket.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' || ch == '.') {
        return Err("存储桶名称只能包含小写字母、数字、连字符和点".into());
    }
    let port = ep.port().map(|p| format!(":{p}")).unwrap_or_default();
    let key_path = uri_encode(key, true);
    let (host, path) = if c.path_style {
        (
            format!("{ep_host}{port}"),
            format!("/{}/{key_path}", uri_encode(&c.bucket, false)),
        )
    } else {
        (
            format!("{}.{ep_host}{port}", c.bucket),
            format!("/{key_path}"),
        )
    };
    Ok(Target {
        url: format!("{scheme}://{host}{path}"),
        host,
        path,
    })
}

fn public_url(c: &ImageHostConfig, key: &str) -> Result<String, String> {
    if !c.public_base_url.is_empty() {
        return Ok(format!("{}/{}", c.public_base_url, uri_encode(key, true)));
    }
    Ok(target(c, key)?.url)
}

async fn put_object(
    c: &ImageHostConfig,
    secret: &str,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), String> {
    let t = target(c, key)?;
    let payload_hash = sha256_hex(&body);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let date = amz_date(now);
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), content_type.to_string());
    headers.insert("host".to_string(), t.host.clone());
    headers.insert("x-amz-content-sha256".to_string(), payload_hash.clone());
    headers.insert("x-amz-date".to_string(), date.clone());
    let region = if c.region.is_empty() {
        "us-east-1"
    } else {
        &c.region
    };
    let auth = authorization(
        "PUT",
        &t.path,
        &headers,
        &payload_hash,
        region,
        &c.access_key_id,
        secret,
        &date,
    );
    let mut req = crate::google::http_client()
        .put(&t.url)
        .header("authorization", auth)
        .body(body);
    for (k, v) in &headers {
        if k != "host" {
            req = req.header(k, v);
        }
    }
    let resp = req.send().await.map_err(|e| format!("连接图床失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let code = text
            .split("<Code>")
            .nth(1)
            .and_then(|s| s.split("</Code>").next())
            .unwrap_or("");
        let msg = text
            .split("<Message>")
            .nth(1)
            .and_then(|s| s.split("</Message>").next())
            .unwrap_or("");
        return Err(format!("上传失败（{status}）{code} {msg}")
            .trim()
            .to_string());
    }
    Ok(())
}

fn content_type(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn secret() -> Result<String, String> {
    crate::secrets::get(SECRET_NAME)?.ok_or_else(|| "还没有配置图床的 Secret Key".to_string())
}

/// 上传笔记库里的若干图片，返回 { 笔记库相对路径: 网络地址 }
#[tauri::command]
pub async fn imagehost_upload(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<BTreeMap<String, String>, String> {
    let c = load_config(&app);
    if c.endpoint.is_empty() || c.bucket.is_empty() {
        return Err("还没有配置图床".into());
    }
    let secret = secret()?;
    let root = crate::vault::root(&app)?;
    let root_canon = root.canonicalize().map_err(|e| e.to_string())?;
    let cache_file = cache_path(&app)?;
    let mut cache: BTreeMap<String, String> = fs::read_to_string(&cache_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut out = BTreeMap::new();
    for rel in paths {
        let abs = root
            .join(&rel)
            .canonicalize()
            .map_err(|e| format!("{rel}：{e}"))?;
        if !abs.starts_with(&root_canon) {
            return Err("非法图片路径".into());
        }
        // 只上传图片：笔记里写一个指向别的文件的「图片」，不能把那个文件传到公开的存储桶里
        let ext = abs.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).unwrap_or_default();
        if !["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tiff"].contains(&ext.as_str()) {
            return Err(format!("{rel} 不是图片，没有上传"));
        }
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        let hash = sha256_hex(&bytes);
        if let Some(url) = cache.get(&hash) {
            out.insert(rel, url.clone());
            continue;
        }
        let key = if c.prefix.is_empty() {
            format!("{}.{ext}", &hash[..24])
        } else {
            format!("{}/{}.{ext}", c.prefix, &hash[..24])
        };
        put_object(&c, &secret, &key, bytes, content_type(&rel)).await?;
        let url = public_url(&c, &key)?;
        cache.insert(hash, url.clone());
        out.insert(rel, url);
    }
    if let Some(dir) = cache_file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(
        &cache_file,
        serde_json::to_string(&cache).unwrap_or_default(),
    );
    Ok(out)
}

/// 测试连接：上传一个小文件，再用公开地址读回来，确认上传和访问权限都没问题
#[tauri::command]
pub async fn imagehost_test(app: AppHandle) -> Result<String, String> {
    let c = load_config(&app);
    let secret = secret()?;
    let key = if c.prefix.is_empty() {
        "cloudnotebook-test.txt".to_string()
    } else {
        format!("{}/cloudnotebook-test.txt", c.prefix)
    };
    put_object(
        &c,
        &secret,
        &key,
        b"Cloud Notebook image host test".to_vec(),
        "text/plain",
    )
    .await?;
    let url = public_url(&c, &key)?;
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| format!("上传成功，但访问公开地址失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "上传成功，但公开地址无法访问（{}）。请把存储桶设为公共读，或填写可公开访问的 CDN / 自定义域名。\n{url}",
            resp.status()
        ));
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS 文档《Signature Calculations for the Authorization Header》里的 GET Object 示例
    #[test]
    fn sigv4_matches_aws_example() {
        let mut h = BTreeMap::new();
        h.insert("host".into(), "examplebucket.s3.amazonaws.com".into());
        h.insert("range".into(), "bytes=0-9".into());
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        h.insert("x-amz-content-sha256".into(), empty.into());
        h.insert("x-amz-date".into(), "20130524T000000Z".into());
        let auth = authorization(
            "GET",
            "/test.txt",
            &h,
            empty,
            "us-east-1",
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "20130524T000000Z",
        );
        assert!(
            auth.ends_with(
                "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
            ),
            "{auth}"
        );
        assert!(auth.contains("SignedHeaders=host;range;x-amz-content-sha256;x-amz-date"));
    }

    #[test]
    fn formats_amz_date() {
        assert_eq!(amz_date(1369353600), "20130524T000000Z");
        assert_eq!(amz_date(1709251199), "20240229T235959Z"); // 闰日
    }

    #[test]
    fn builds_virtual_hosted_and_path_style_urls() {
        let mut c = ImageHostConfig {
            endpoint: "https://oss-cn-hangzhou.aliyuncs.com".into(),
            bucket: "my-notes".into(),
            ..Default::default()
        };
        let t = target(&c, "notes/ab 1.png").unwrap();
        assert_eq!(
            t.url,
            "https://my-notes.oss-cn-hangzhou.aliyuncs.com/notes/ab%201.png"
        );
        c.path_style = true;
        c.endpoint = "https://acc.r2.cloudflarestorage.com".into();
        assert_eq!(
            target(&c, "x.png").unwrap().url,
            "https://acc.r2.cloudflarestorage.com/my-notes/x.png"
        );
        c.public_base_url = "https://img.example.com".into();
        assert_eq!(
            public_url(&c, "notes/x.png").unwrap(),
            "https://img.example.com/notes/x.png"
        );
    }
}
